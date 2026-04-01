# MCP 安全认证：OAuth 与 XAA

> **核心问题**：MCP 服务器如何安全认证？Claude Code 的 OAuth 实现有多复杂？

---

## 1. 认证全景图

### Q: MCP 连接需要哪些安全机制？

```
MCP 认证层次:

┌─────────────────────────────────────────────────────────────┐
│  Layer 0: 无认证                                             │
│  适用: stdio（本地）、sse-ide/ws-ide（IDE 信任）               │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: 标准 OAuth 2.0 + PKCE                             │
│  适用: sse、http（远程 MCP Server）                           │
│  流程: 浏览器授权 → 回调获取 code → 换取 token                │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: XAA (Cross-App Access) 企业联合认证                 │
│  适用: 企业环境，IdP 联合登录                                  │
│  流程: IdP id_token → RFC 8693 交换 → RFC 7523 JWT Bearer    │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Claude.ai Proxy 认证                               │
│  适用: claudeai-proxy 类型                                   │
│  流程: Claude.ai OAuth token → 代理转发                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Step-Up Authentication (权限提升)                   │
│  适用: 需要额外 scope 的操作                                  │
│  流程: 403 insufficient_scope → 重新 PKCE 授权                │
└─────────────────────────────────────────────────────────────┘
```

### Q: 关键文件和职责？

```
src/services/mcp/
├── auth.ts          # 🔑 主认证模块 (89KB)
│                    #    ClaudeAuthProvider 类
│                    #    performMCPOAuthFlow()
│                    #    Token 刷新 + 撤销
│                    #    Step-Up 检测
├── xaa.ts           # 🏢 XAA 企业认证 (18KB)
│                    #    RFC 8693 Token Exchange
│                    #    RFC 7523 JWT Bearer Grant
│                    #    PRM 发现 (RFC 9728)
├── xaaIdpLogin.ts   # 🆔 IdP 登录 (16KB)
│                    #    OIDC 发现
│                    #    id_token 获取与缓存
│                    #    回调服务器
└── oauthPort.ts     # 🔌 OAuth 端口管理
                     #    动态端口查找
                     #    回调 URI 构建
```

---

## 2. 超时配置：30 秒统一防线

### Q: 为什么所有 OAuth 请求都有 30 秒超时？

```typescript
// src/services/mcp/auth.ts:L65
const AUTH_REQUEST_TIMEOUT_MS = 30000

// src/services/mcp/xaa.ts:L29
const XAA_REQUEST_TIMEOUT_MS = 30000

// src/services/mcp/xaaIdpLogin.ts:L52
const IDP_REQUEST_TIMEOUT_MS = 30000
```

三个文件分别定义了相同的 30 秒超时。这是一个有意的设计：

```
超时防线:

请求级别:    30s  ← AUTH_REQUEST_TIMEOUT_MS
                    XAA_REQUEST_TIMEOUT_MS
                    IDP_REQUEST_TIMEOUT_MS

流程级别:     5min ← IDP_LOGIN_TIMEOUT_MS (xaaIdpLogin.ts:L51)
                     OAuth 回调服务器超时 (auth.ts:L1202-L1214)

缓存级别:    60s  ← ID_TOKEN_EXPIRY_BUFFER_S (xaaIdpLogin.ts:L53)
             300s ← 主动刷新窗口（token 到期前 5 分钟）
```

**超时实现** (`src/services/mcp/auth.ts:L198-L237`)：

```typescript
function createAuthFetch(abortSignal?: AbortSignal): FetchLike {
  return async (url, init) => {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('OAuth request timed out')),
      AUTH_REQUEST_TIMEOUT_MS,
    )

    // 合并外部 abort signal（用户取消）和超时 signal
    const cleanup = abortSignal
      ? (() => {
          const onAbort = () => controller.abort(abortSignal.reason)
          abortSignal.addEventListener('abort', onAbort)
          return () => abortSignal.removeEventListener('abort', onAbort)
        })()
      : undefined

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      })
      // 标准化 OAuth 错误（Slack 兼容）
      return normalizeOAuthErrorBody(response, init?.method)
    } finally {
      clearTimeout(timeout)
      cleanup?.()
    }
  }
}
```

### Q: `normalizeOAuthErrorBody` 是什么？为什么需要它？

某些 OAuth 服务器不遵守标准：

```typescript
// src/services/mcp/auth.ts:L147-L190
const NONSTANDARD_INVALID_GRANT_ALIASES = [
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
]

function normalizeOAuthErrorBody(
  response: Response,
  method?: string,
): Response {
  // 问题1: Slack 返回 200 + JSON error body（标准要求 4xx）
  // 问题2: Slack 用 'invalid_refresh_token' 替代标准 'invalid_grant'
  // MCP SDK 只在 !response.ok 时解析 error

  if (method !== 'POST' || !response.ok) return response

  // 克隆响应并检查 body 中是否有 error 字段
  // 如果有，重新构造为 400 响应
  // 将非标准错误码映射为 'invalid_grant'
}
```

**现实中的 OAuth 服务器千奇百怪**，Claude Code 必须处理这些不合规实现。

---

## 3. 标准 OAuth 流程：performMCPOAuthFlow

### Q: 完整的 OAuth 授权流程是怎样的？

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Claude   │    │  本地     │    │  浏览器   │    │  MCP     │
│  Code     │    │  HTTP     │    │          │    │  Server  │
│  (Client) │    │  Server   │    │          │    │  AS      │
└────┬──────┘    └────┬──────┘    └────┬──────┘    └────┬──────┘
     │                │                │                │
     │ 1. 发现 OAuth metadata          │                │
     │────────────────────────────────────────────────→│
     │                │                │         result │
     │←────────────────────────────────────────────────│
     │                │                │                │
     │ 2. 启动回调服务器               │                │
     │──→ 监听 localhost:PORT          │                │
     │                │                │                │
     │ 3. 构建授权 URL (PKCE)          │                │
     │──────────────────────→ 打开浏览器│                │
     │                │         │      │                │
     │                │         │ 4. 用户授权            │
     │                │         │──────────────────────→│
     │                │         │      │                │
     │                │         │ 5. 重定向到 localhost  │
     │                │         │──→│  │                │
     │                │    6. 收到 code │                │
     │                │←────────│      │                │
     │                │                │                │
     │ 7. 验证 state (CSRF)           │                │
     │←───────────────│                │                │
     │                │                │                │
     │ 8. 用 code 换取 token           │                │
     │────────────────────────────────────────────────→│
     │                │                │         tokens │
     │←────────────────────────────────────────────────│
     │                │                │                │
     │ 9. 存储到 Keychain              │                │
     │                │                │                │
```

**入口函数** (`src/services/mcp/auth.ts:L847-L901`)：

```typescript
export async function performMCPOAuthFlow(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  abortSignal?: AbortSignal,
): Promise<void> {
  // 步骤1: 先尝试 XAA（如果配置了）
  if (serverConfig.oauth?.xaa) {
    const xaaResult = await performMCPXaaAuth(
      serverName, serverConfig, abortSignal
    )
    if (xaaResult === 'success') return
    // XAA 配置了就不回退到浏览器授权（安全考虑）
    throw new Error('XAA auth failed and no fallback configured')
  }

  // 步骤2: 标准 OAuth 浏览器授权流程
  // 清除旧凭据
  // 读取缓存的 step-up scope 和资源 metadata
  // ...
}
```

### Q: 回调服务器是怎么实现的？

**OAuth 回调服务器** (`src/services/mcp/auth.ts:L1029-L1214`)：

```typescript
// 创建 HTTP 服务器监听 OAuth 回调
const server = createServer((req, res) => {
  const { pathname, query } = parse(req.url || '', true)

  if (pathname === '/callback') {
    // CSRF 验证: 检查 state 参数
    if (query.state !== oauthState) {
      logMCPDebug(serverName,
        'State mismatch - possible CSRF attack')
      res.writeHead(400)
      res.end('State mismatch - possible CSRF attack')
      return
    }

    if (query.error) {
      // 处理授权错误
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(xss(`Authorization error: ${query.error}`))
      return
    }

    if (query.code) {
      // 成功获取授权码
      authorizationCode = query.code as string
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('Authorization successful! You can close this tab.')
      // 触发 token 交换...
    }
  }
})
```

### Q: OAuth 端口怎么选择？

```typescript
// src/services/mcp/oauthPort.ts:L9-L13
const REDIRECT_PORT_RANGE =
  getPlatform() === 'windows'
    ? { min: 39152, max: 49151 }  // Windows: 避免保留的 49152-65535
    : { min: 49152, max: 65535 }  // Unix: IANA 动态端口范围

const REDIRECT_PORT_FALLBACK = 3118

// src/services/mcp/oauthPort.ts:L36-L78
export async function findAvailablePort(): Promise<number> {
  // 优先级1: 环境变量 MCP_OAUTH_CALLBACK_PORT
  const configuredPort = getMcpOAuthCallbackPort()
  if (configuredPort) return configuredPort

  // 优先级2: 随机端口（更安全 — 防止端口预测攻击）
  const maxAttempts = Math.min(range, 100)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = min + Math.floor(Math.random() * range)
    try {
      // 尝试绑定端口，成功则返回
      await new Promise<void>((resolve, reject) => {
        const testServer = createServer()
        testServer.once('error', reject)
        testServer.listen(port, () => {
          testServer.close(() => resolve())
        })
      })
      return port
    } catch {
      continue  // 端口被占用，换一个
    }
  }

  // 优先级3: 回退端口 3118
  return REDIRECT_PORT_FALLBACK
}
```

**安全设计**：使用随机端口而非顺序扫描，防止攻击者预测回调端口。

---

## 4. Token 管理：存储、刷新、撤销

### Q: Token 存储在哪里？

Claude Code 使用系统 Keychain 存储 OAuth Token：

```typescript
// Token 存储使用 getSecureStorage() — 系统级安全存储
// macOS: Keychain
// Linux: libsecret
// Windows: Credential Manager

// 存储 Key 的生成 (auth.ts:L325-L341)
function getServerKey(serverName: string, config: McpServerConfig): string {
  // serverName + config 的 SHA256 哈希
  // 防止同名不同配置的 Server 共享凭据
  const configHash = createHash('sha256')
    .update(JSON.stringify({
      type: config.type,
      url: 'url' in config ? config.url : undefined,
      headers: 'headers' in config ? config.headers : undefined,
    }))
    .digest('hex')
    .substring(0, 16)
  return `${serverName}|${configHash}`
}
```

**存储 Slot 分类**：

| Slot 名称 | 存储内容 | 作用域 |
|-----------|---------|--------|
| `mcpOAuth` | MCP OAuth tokens (access/refresh) | 每个 Server |
| `mcpOAuthClientConfig` | AS client secrets | 每个 Server |
| `mcpXaaIdp` | 缓存的 id_token | 每个 IdP issuer |
| `mcpXaaIdpConfig` | IdP client secrets | 每个 IdP issuer |

### Q: Token 刷新是怎么工作的？

**主刷新逻辑** (`src/services/mcp/auth.ts:L1540-L1702`)：

```typescript
async tokens(): Promise<OAuthTokens | undefined> {
  // 步骤1: 从 Keychain 读取 token
  const tokenData = await this.readTokens()

  // 步骤2: XAA 自动刷新（无浏览器）
  if (this.serverConfig.oauth?.xaa && !tokenData?.refresh_token) {
    // 没有 refresh_token 的 XAA 场景
    // 直接用缓存的 id_token 重新交换
    const xaaResult = await this.xaaRefresh()
    if (xaaResult) return xaaResult
  }

  // 步骤3: 主动刷新（到期前 5 分钟）
  if (
    tokenData?.expires_at &&
    tokenData.expires_at - Date.now() / 1000 < 300 &&
    tokenData.refresh_token
  ) {
    // 检查是否有 step-up pending（不能用 refresh 提升 scope）
    if (this.stepUpScope) {
      // RFC 6749 §6: refresh 不能扩展 scope
      // 返回 undefined → 触发新的 PKCE 授权
      return undefined
    }

    // 防止并发刷新
    if (!this.refreshInProgress) {
      this.refreshInProgress = this.refreshAuthorization(
        tokenData.refresh_token
      )
    }
    return await this.refreshInProgress
  }

  return tokenData
    ? { access_token: tokenData.access_token, token_type: 'Bearer' }
    : undefined
}
```

**跨进程刷新同步** (`src/services/mcp/auth.ts:L2090-L2175`)：

```typescript
async refreshAuthorization(refreshToken: string): Promise<OAuthTokens> {
  // 使用文件锁防止多个 Claude Code 实例同时刷新
  const lockPath = join(
    getClaudeConfigHomeDir(),
    `mcp-refresh-${sanitizedKey}.lock`
  )

  // 最多重试 5 次获取锁，每次 1-3 秒指数退避
  const MAX_LOCK_RETRIES = 5
  for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
    try {
      await lockfile.lock(lockPath)
      break
    } catch {
      await sleep(1000 * Math.pow(2, i) + Math.random() * 1000)
    }
  }

  try {
    // 获取锁后，先检查其他进程是否已经刷新
    const freshTokens = await this.readTokens()
    if (freshTokens?.expires_at &&
        freshTokens.expires_at - Date.now() / 1000 > 300) {
      return freshTokens  // 其他进程已刷新，直接用
    }

    // 使用最新的 refresh_token（可能已被其他进程更新）
    const latestRefreshToken = freshTokens?.refresh_token || refreshToken
    return await this._doRefresh(latestRefreshToken)
  } finally {
    await lockfile.unlock(lockPath)
  }
}
```

### Q: 刷新失败怎么处理？

**重试逻辑** (`src/services/mcp/auth.ts:L2177-L2359`)：

```typescript
async _doRefresh(refreshToken: string): Promise<OAuthTokens> {
  // 最多 3 次重试
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 步骤1: 发现 OAuth metadata
      const metadata = await this.discoverMetadata()

      // 步骤2: 调用 SDK 刷新函数
      await sdkRefreshAuthorization(metadata, clientInfo, refreshToken, resource)
      return await this.readTokens()

    } catch (error) {
      if (error instanceof InvalidGrantError) {
        // refresh_token 无效 → 检查其他进程是否已成功
        const stored = await this.readTokens()
        if (stored?.expires_at &&
            stored.expires_at - Date.now() / 1000 > 300) {
          return stored  // 其他进程救了我们
        }
        // 否则: 清除 token，通知用户重新授权
        throw error
      }

      // 可重试错误: timeout, ServerError, TemporarilyUnavailable, TooManyRequests
      if (isRetryable(error) && attempt < 2) {
        await sleep(1000 * Math.pow(2, attempt))  // 1s, 2s, 4s
        continue
      }
      throw error
    }
  }
}
```

**失败原因分类**：

```
analytics 失败原因:

metadata_discovery_failed  ← OAuth metadata 发现失败
no_client_info            ← 无客户端信息（DCR 未完成）
no_tokens_returned        ← 刷新成功但没返回 token
invalid_grant             ← refresh_token 无效/过期
transient_retries_exhausted ← 3 次重试后仍失败
request_failed            ← 网络错误
```

### Q: Token 撤销怎么做？

```typescript
// src/services/mcp/auth.ts:L381-L459
async revokeToken(token: string, tokenTypeHint: string): Promise<void> {
  // RFC 7009: Token Revocation
  // 1. 先用 client_id 在 body 中发送（无 Authorization header）
  const response = await fetch(revocationEndpoint, {
    method: 'POST',
    body: new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
      client_id: clientInfo.client_id,
    }),
  })

  // 2. 如果 401，回退到 Bearer Auth（非合规服务器）
  if (response.status === 401) {
    await fetch(revocationEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ token, token_type_hint }),
    })
  }
}

// src/services/mcp/auth.ts:L467-L618
async revokeServerTokens(preserveStepUpState?: boolean): Promise<void> {
  // RFC 7009: 先撤销 refresh_token（长期），再撤销 access_token
  // 1. 获取撤销端点
  // 2. 选择认证方式:
  //    - revocation_endpoint_auth_methods_supported (RFC 7009)
  //    - 回退: token_endpoint_auth_methods_supported
  //    - 支持: client_secret_basic, client_secret_post
  // 3. 如果 preserveStepUpState: 保留 scope + discoveryState
}
```

---

## 5. XAA：企业级无浏览器认证

### Q: XAA 是什么？为什么需要它？

**XAA (Cross-App Access)** 解决的核心问题：

```
标准 OAuth 流程:
  用户 → 打开浏览器 → 授权 → 回调 → Token
  问题: 企业环境中，用户已经通过 IdP (如 Okta/Azure AD) 登录
        为什么每个 MCP Server 还要再走一次浏览器授权？

XAA 流程:
  用户已有 IdP 的 id_token（SSO 登录时获取）
  → IdP 交换出 ID-JAG (RFC 8693)
  → AS 用 ID-JAG 换取 access_token (RFC 7523)
  = 无浏览器，无用户交互！
```

### Q: XAA 的两步令牌交换怎么工作？

```
XAA 令牌交换 (src/services/mcp/xaa.ts):

步骤1: RFC 8693 Token Exchange (IdP 端)
┌──────────┐                          ┌──────────┐
│  Claude   │  POST /token             │   IdP    │
│  Code     │  grant_type=             │  (Okta/  │
│           │    token-exchange         │  Azure)  │
│           │  subject_token=id_token  │          │
│           │  subject_token_type=     │          │
│           │    id_token              │          │
│           │  requested_token_type=   │          │
│           │    id-jag                │          │
│           │───────────────────────→  │          │
│           │  ←─── ID-JAG token ───── │          │
└──────────┘                          └──────────┘

步骤2: RFC 7523 JWT Bearer Grant (AS 端)
┌──────────┐                          ┌──────────┐
│  Claude   │  POST /token             │   AS     │
│  Code     │  grant_type=             │  (MCP    │
│           │    jwt-bearer            │  Server  │
│           │  assertion=ID-JAG        │  的 AS)  │
│           │───────────────────────→  │          │
│           │  ←── access_token ────── │          │
└──────────┘                          └──────────┘
```

**源码实现** (`src/services/mcp/xaa.ts:L426-L511`)：

```typescript
export async function performCrossAppAccess(options: {
  idToken: string
  serverUrl: string
  clientId?: string
  clientSecret?: string
  authServerMetadataUrl?: string
  abortSignal?: AbortSignal
}): Promise<{
  tokens: OAuthTokens
  authorizationServerUrl: string
}> {
  const xaaFetch = makeXaaFetch(options.abortSignal)

  // 步骤1: RFC 9728 PRM 发现（Protected Resource Metadata）
  const prm = await discoverProtectedResource(
    options.serverUrl, xaaFetch
  )

  // 步骤2: 遍历 authorization_servers，找支持 jwt-bearer 的
  for (const asUrl of prm.authorization_servers) {
    const metadata = await discoverAuthorizationServer(asUrl, xaaFetch)

    // 检查是否支持 jwt-bearer grant type
    if (!metadata.grant_types_supported?.includes(JWT_BEARER_GRANT)) {
      continue
    }

    // 步骤3: RFC 8693 Token Exchange at IdP
    const idJag = await requestJwtAuthorizationGrant({
      idToken: options.idToken,
      // ...
    })

    // 步骤4: RFC 7523 JWT Bearer Grant at AS
    const tokens = await exchangeJwtAuthGrant({
      assertion: idJag,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      // ...
    })

    return { tokens, authorizationServerUrl: asUrl }
  }
}
```

### Q: 令牌交换中的安全措施有哪些？

**1. HTTPS 强制** (`src/services/mcp/xaa.ts:L178-L210`)：

```typescript
async function discoverAuthorizationServer(url, fetch) {
  const metadata = await discoverAuthorizationServerMetadata(url, fetch)
  // HTTPS 检查 — 拒绝明文 token 端点
  if (!metadata.token_endpoint.startsWith('https://')) {
    throw new Error('token_endpoint must use HTTPS')
  }
  return metadata
}
```

**2. URL 规范化防混淆攻击** (`src/services/mcp/xaa.ts:L61-L67`)：

```typescript
// RFC 3986 §6.2.2 语法级规范化
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href.replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

// PRM 发现时验证 resource URL 一致性 (L135-L165)
const prmResource = normalizeUrl(prmData.resource)
const expectedResource = normalizeUrl(serverUrl)
if (prmResource !== expectedResource) {
  throw new Error(`PRM resource mismatch: ${prmResource} vs ${expectedResource}`)
}
```

**3. 敏感信息脱敏** (`src/services/mcp/xaa.ts:L91-L97`)：

```typescript
const SENSITIVE_TOKEN_RE =
  /"(access_token|refresh_token|id_token|assertion|subject_token|client_secret)"\s*:\s*"[^"]*"/g

function redactTokens(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : jsonStringify(raw)
  return s.replace(SENSITIVE_TOKEN_RE, (_, k) => `"${k}":"[REDACTED]"`)
}
```

**4. 智能 id_token 缓存失效** (`src/services/mcp/xaa.ts:L77-L84`)：

```typescript
export class XaaTokenExchangeError extends Error {
  readonly shouldClearIdToken: boolean
  constructor(message: string, shouldClearIdToken: boolean) {
    super(message)
    this.name = 'XaaTokenExchangeError'
    this.shouldClearIdToken = shouldClearIdToken
  }
}
// 4xx / invalid_grant → id_token 有问题，清除缓存
// 5xx → IdP 服务器故障，id_token 可能仍然有效，保留
```

---

## 6. CSRF 防护

### Q: OAuth 流程如何防止 CSRF 攻击？

```typescript
// src/services/mcp/auth.ts:L1473-L1480
async state(): Promise<string> {
  if (!this._state) {
    this._state = randomBytes(32).toString('base64url')
  }
  return this._state
}
```

**state 参数的全生命周期**：

```
1. 生成: 32 字节随机数 → base64url 编码
         (src/services/mcp/auth.ts:L1476)

2. 发送: 附加到授权 URL 的 query string
         ?state=abc123...

3. 验证: 回调服务器检查返回的 state
         if (query.state !== oauthState) {
           // "possible CSRF attack"
         }
         (src/services/mcp/auth.ts:L1109-L1118)

4. 日志脱敏: state 值不出现在日志中
         SENSITIVE_OAUTH_PARAMS = ['state', 'nonce',
           'code_challenge', 'code_verifier', 'code']
         (src/services/mcp/auth.ts:L100-L106)
```

**敏感参数脱敏** (`src/services/mcp/auth.ts:L100-L125`)：

```typescript
const SENSITIVE_OAUTH_PARAMS = [
  'state',           // CSRF token
  'nonce',           // 防重放
  'code_challenge',  // PKCE
  'code_verifier',   // PKCE
  'code',            // 授权码
]

function redactSensitiveUrlParams(url: string): string {
  try {
    const parsed = new URL(url)
    for (const param of SENSITIVE_OAUTH_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]')
      }
    }
    return parsed.toString()
  } catch {
    return url
  }
}
```

---

## 7. Step-Up Authentication：权限提升

### Q: 什么是 Step-Up Authentication？

当 MCP Server 返回 `403 Forbidden` + `WWW-Authenticate: insufficient_scope` 时，需要提升权限：

```typescript
// src/services/mcp/auth.ts:L1354-L1374
function wrapFetchWithStepUpDetection(
  fetch: FetchLike,
  provider: ClaudeAuthProvider,
): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init)

    if (response.status === 403) {
      const wwwAuth = response.headers.get('www-authenticate')
      if (wwwAuth?.includes('insufficient_scope')) {
        // 提取需要的新 scope
        const scopeMatch = wwwAuth.match(/scope="([^"]*)"/)
        const scope = scopeMatch?.[1]
        if (scope) {
          provider.markStepUpPending(scope)
          // 标记后：
          // 1. tokens() 返回 undefined → 跳过 refresh
          // 2. 触发新的 PKCE 授权流程（带新 scope）
          // RFC 6749 §6: refresh 不能扩展 scope
        }
      }
    }

    return response
  }
}
```

**为什么不能用 refresh_token 提升 scope？**

根据 RFC 6749 §6：refresh token 交换的新 token scope 不能超过原始授权的 scope。所以必须重新走 PKCE 授权流程，让用户在浏览器中明确授权新的 scope。

---

## 8. IdP 登录与 OIDC 发现

### Q: XAA 的 IdP 登录是怎么实现的？

```typescript
// src/services/mcp/xaaIdpLogin.ts:L200-L225
async function discoverOidc(idpIssuer: string) {
  // OIDC 发现: {issuer}/.well-known/openid-configuration
  // 注意: 路径 APPEND 而不是 REPLACE
  // 修复多租户 IdP:
  //   Azure AD: login.microsoftonline.com/{tenant}/v2.0
  //   Okta: {org}.okta.com/oauth2/{server}
  //   Keycloak: keycloak.example.com/realms/{realm}

  const discoveryUrl = new URL(
    '.well-known/openid-configuration',
    idpIssuer.endsWith('/') ? idpIssuer : idpIssuer + '/'
  )

  const response = await fetch(discoveryUrl, {
    signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),  // 30s
  })

  // 门户劫持检测: 非 JSON 响应 → 可能是 captive portal
  const contentType = response.headers.get('content-type')
  if (!contentType?.includes('json')) {
    throw new Error('Non-JSON response - possible captive portal')
  }

  const metadata = await response.json()
  // HTTPS 强制
  if (!metadata.token_endpoint.startsWith('https://')) {
    throw new Error('IdP token_endpoint must use HTTPS')
  }
  return metadata
}
```

### Q: id_token 缓存策略？

```typescript
// src/services/mcp/xaaIdpLogin.ts:L78-L117

// 缓存 Key: IdP issuer 的规范化形式
function issuerKey(idpIssuer: string): string {
  try {
    const url = new URL(idpIssuer)
    return url.href.replace(/\/$/, '').toLowerCase()
  } catch {
    return idpIssuer.replace(/\/$/, '')
  }
}

// 读取缓存: 60 秒过期缓冲
function getCachedIdpIdToken(idpIssuer: string): string | undefined {
  const token = readFromKeychain('mcpXaaIdp', issuerKey(idpIssuer))
  if (!token) return undefined

  // 检查是否在 60 秒内过期
  const exp = jwtExp(token)
  if (exp && exp - Date.now() / 1000 < ID_TOKEN_EXPIRY_BUFFER_S) {
    return undefined  // 即将过期，视为无效
  }
  return token
}

// JWT exp 解析 (不验证签名)
// src/services/mcp/xaaIdpLogin.ts:L228-L242
function jwtExp(jwt: string): number | undefined {
  // 只解码 exp claim，不验证签名
  // 原因: id_token 是 RFC 8693 subject_token
  // 由 IdP 的 token endpoint 验证，不需要 Client 验证
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString()
    )
    return payload.exp
  } catch {
    return undefined
  }
}
```

---

## 9. 失败追踪与分析

### Q: OAuth 失败时收集哪些诊断信息？

```typescript
// 失败原因枚举 (auth.ts:L1269-L1339)
type OAuthFailureReason =
  | 'cancelled'                    // 用户取消
  | 'timeout'                      // 5 分钟超时
  | 'state_mismatch'               // CSRF 检测
  | 'port_conflict'                // 端口被占用
  | 'invalid_client'               // DCR 客户端无效
  | 'metadata_discovery_failed'    // OAuth 发现失败
  | 'no_client_info'               // 无客户端信息
  | 'invalid_grant'                // 授权码/token 无效
  | 'transient_retries_exhausted'  // 重试耗尽
  | 'request_failed'               // 网络错误
  | 'unknown'                      // 未知错误

// Analytics 事件
logEvent('tengu_mcp_oauth_complete', {
  outcome: 'success' | 'failure',
  failure_reason: OAuthFailureReason,
  oauth_error_code: string,         // 如 'invalid_grant'
  http_status: number,              // 如 401
  transport_type: 'sse' | 'http',
  has_xaa: boolean,
  duration_ms: number,
})
```

**XAA 失败阶段追踪** (`src/services/mcp/auth.ts:L664-L845`)：

```
XAA 失败阶段:

1. idp_login        → IdP 登录获取 id_token 失败
2. discovery        → PRM/AS metadata 发现失败
3. token_exchange   → RFC 8693 IdP 交换失败
4. jwt_bearer       → RFC 7523 AS 交换失败

每个阶段的错误都会上报到 analytics:
logEvent('tengu_mcp_oauth_complete', {
  failure_reason: 'xaa_failure',
  xaa_failure_stage: 'token_exchange',
  ...
})
```

---

## 10. Discovery State 持久化

### Q: 为什么要持久化 Discovery State？

```typescript
// src/services/mcp/auth.ts:L1997-L2035 — 关键注释
async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
  // 只持久化 URL，不持久化完整 metadata
  // 原因:
  //   - 完整 metadata 大约 1.5-2KB/server
  //   - macOS Keychain 通过 stdin 传输，限制 4096 字节
  //   - 两个 server 的 hex 编码 metadata 就超过限制
  //   - 会导致 Keychain 数据损坏 (#30337)
  //   - SDK 可以用一次 HTTP GET 重新获取 metadata
  
  const persistedState = {
    authorizationServerUrl: state.authorizationServerUrl,
    resourceMetadataUrl: state.resourceMetadataUrl,
    // 注意: 不保存 metadata 和 resourceMetadata
  }
  // ...
}
```

**macOS Keychain 的隐藏限制**：

```
macOS Keychain 数据流:
  应用 → stdin → security 命令 → Keychain

stdin 缓冲区限制: 4096 字节
Hex 编码膨胀: 2x
实际数据限制: ~2013 字节

一个 OAuth metadata: ~1500 字节
两个 Server: ~3000 字节 → hex 编码 ~6000 字节 → 溢出！

解决方案: 只存 URL (~100 字节)，运行时重新 fetch
```

---

## 11. 安全总结

### Q: Claude Code MCP 认证的安全层次总览？

```
┌──────────────────────────────────────────────────┐
│  传输加密                                         │
│  • HTTPS 强制（token endpoint、metadata URL）      │
│  • TLS 选项支持（WebSocket）                       │
├──────────────────────────────────────────────────┤
│  认证协议                                         │
│  • OAuth 2.0 + PKCE（防授权码拦截）                │
│  • CSRF state 参数（32 字节随机）                  │
│  • XAA 联合认证（RFC 8693 + 7523）                │
├──────────────────────────────────────────────────┤
│  Token 安全                                       │
│  • 系统 Keychain 存储                             │
│  • 跨进程文件锁刷新                               │
│  • 智能缓存失效（4xx vs 5xx）                     │
│  • 主动刷新（到期前 5 分钟）                       │
├──────────────────────────────────────────────────┤
│  日志安全                                         │
│  • Token 值脱敏（SENSITIVE_TOKEN_RE）              │
│  • OAuth 参数脱敏（state, code, nonce...）         │
│  • URL 安全日志（redactSensitiveUrlParams）        │
├──────────────────────────────────────────────────┤
│  错误处理                                         │
│  • 非标准 OAuth 服务器兼容（Slack 等）             │
│  • 门户劫持检测（非 JSON 响应）                    │
│  • 端口预测防护（随机端口选择）                    │
│  • 30 秒请求超时防挂起                             │
└──────────────────────────────────────────────────┘
```

> **下一篇**：[04-mcp-server-mode.md](./04-mcp-server-mode.md) — Claude Code 自身如何作为 MCP Server？
