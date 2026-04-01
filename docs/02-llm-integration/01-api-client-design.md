# Q: 如何设计一个健壮的 LLM API 客户端？


当你的 AI Agent 需要与 LLM 后端通信时，最先面对的问题就是：如何设计一个既灵活又可靠的 API 客户端？Claude Code 的方案堪称教科书级别——它支持 4 种云后端、6 层认证策略、指数退避重试、以及精细的参数管理。

---

## 目录

1. [客户端初始化架构](#1-客户端初始化架构)
2. [认证链：谁来证明你是谁](#2-认证链谁来证明你是谁)
3. [客户端配置：Headers、超时与代理](#3-客户端配置headers超时与代理)
4. [错误处理：重试是一门艺术](#4-错误处理重试是一门艺术)
5. [模型参数管理](#5-模型参数管理)
6. [设计启发](#6-设计启发)

---

## 1. 客户端初始化架构

### 1.1 入口函数

Claude Code 不是简单地 `new Anthropic()`，而是根据运行环境动态选择 SDK 实例：

```typescript
// src/services/api/client.ts:88-100
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic>
```

这个函数做了一件关键的事：**根据环境变量选择完全不同的 SDK 子类**。

### 1.2 四种后端分支

```
getAnthropicClient()
  │
  ├── CLAUDE_CODE_USE_BEDROCK=1  → AnthropicBedrock (AWS)
  │   └── src/services/api/client.ts:153-189
  │
  ├── CLAUDE_CODE_USE_FOUNDRY=1  → AnthropicFoundry (Azure)
  │   └── src/services/api/client.ts:191-219
  │
  ├── CLAUDE_CODE_USE_VERTEX=1   → AnthropicVertex (GCP)
  │   └── src/services/api/client.ts:221-297
  │
  └── (default)                  → Anthropic (First-Party)
      └── src/services/api/client.ts:300-315
```

每种后端有独立的认证机制：

```typescript
// src/services/api/client.ts:153-164 — Bedrock 分支
if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
  const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
  const awsRegion =
    model === getSmallFastModel() &&
    process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
      ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
      : getAWSRegion()

  const bedrockArgs = {
    ...ARGS,
    awsRegion,
    // ...
  }
```

> **设计洞察**: 不同云平台的 SDK 通过 **dynamic import** 按需加载（`await import()`），避免不使用的平台拖累启动时间。

### 1.3 公共配置对象

所有后端共享同一个基础配置：

```typescript
// src/services/api/client.ts:141-152
const ARGS = {
  defaultHeaders,       // 自定义 headers（User-Agent, session ID 等）
  maxRetries,           // 重试次数
  timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
  dangerouslyAllowBrowser: true,
  fetchOptions: getProxyFetchOptions({
    forAnthropicAPI: true,
  }),
  ...(resolvedFetch && { fetch: resolvedFetch }),
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `timeout` | 600,000ms (10 分钟) | 覆盖 `API_TIMEOUT_MS` 环境变量 |
| `maxRetries` | 由调用方传入 | SDK 内置重试（Claude Code 额外包装了 `withRetry`） |
| `dangerouslyAllowBrowser` | `true` | 允许浏览器环境使用 |

---

## 2. 认证链：谁来证明你是谁

认证逻辑集中在 `src/utils/auth.ts`，核心函数是 `getAnthropicApiKeyWithSource()`（行 226-348）。

### 2.1 优先级链

认证不是单一路径，而是一条**按优先级递降的链**：

```
┌─────────────────────────────────────────────────────┐
│            认证解析链（按优先级排序）                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. --bare 模式 (行 235-247)                         │
│     ├── ANTHROPIC_API_KEY 环境变量                    │
│     └── apiKeyHelper (--settings 指定)               │
│                                                     │
│  2. CI/Test 模式 (行 265-297)                        │
│     ├── CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR          │
│     ├── ANTHROPIC_API_KEY                            │
│     └── CLAUDE_CODE_OAUTH_TOKEN                      │
│                                                     │
│  3. 正式模式 (行 298-342)                             │
│     ├── ANTHROPIC_API_KEY (需已审批)                  │
│     ├── 文件描述符传入的 API Key                      │
│     ├── apiKeyHelper 配置命令                         │
│     └── macOS Keychain / 配置文件                     │
│                                                     │
│  4. OAuth 令牌 (client.ts:131-137)                   │
│     ├── ANTHROPIC_AUTH_TOKEN                          │
│     ├── CLAUDE_CODE_OAUTH_TOKEN                      │
│     ├── OAuth 文件描述符                              │
│     └── Claude.ai 订阅令牌                            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 2.2 --bare 模式：最严格的隔离

```typescript
// src/utils/auth.ts:235-247
if (isBareMode()) {
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  }
  if (getConfiguredApiKeyHelper()) {
    return {
      key: opts.skipRetrievingKeyFromApiKeyHelper
        ? null
        : getApiKeyFromApiKeyHelperCached(),
      source: 'apiKeyHelper',
    }
  }
  return { key: null, source: 'none' }
}
```

`--bare` 模式下只允许两种认证方式——永远不碰 Keychain 或配置文件。这是为了在**沙箱/CI 环境**中提供确定性行为。

### 2.3 apiKeyHelper：外部命令获取密钥

```typescript
// src/utils/auth.ts:320-336
const apiKeyHelperCommand = getConfiguredApiKeyHelper()
if (apiKeyHelperCommand) {
  if (opts.skipRetrievingKeyFromApiKeyHelper) {
    return { key: null, source: 'apiKeyHelper' }
  }
  return {
    key: getApiKeyFromApiKeyHelperCached(),
    source: 'apiKeyHelper',
  }
}
```

`apiKeyHelper` 是一个**外部命令字符串**，配置在用户 settings 中。Claude Code 执行它来获取 API Key。这允许企业用 Vault、1Password CLI 等管理密钥。

### 2.4 OAuth 令牌管理

OAuth 是 Claude.ai 订阅用户的认证方式：

```typescript
// src/services/api/client.ts:131-137
await checkAndRefreshOAuthTokenIfNeeded()   // 自动刷新过期令牌
if (!isClaudeAISubscriber()) {
  await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
}
```

```typescript
// src/services/api/client.ts:300-315 — First-Party 客户端创建
const clientConfig = {
  apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
  authToken: isClaudeAISubscriber()
    ? getClaudeAIOAuthTokens()?.accessToken
    : undefined,
  baseURL: /* OAuth staging URL if configured */,
  ...ARGS,
}
return new Anthropic(clientConfig)
```

> **关键区分**: `apiKey` 和 `authToken` 是互斥的——API Key 用户设置 `apiKey`，OAuth 用户设置 `authToken`。

### 2.5 自定义 Headers

```typescript
// src/services/api/client.ts:105-116
const defaultHeaders: { [key: string]: string } = {
  'x-app': 'cli',
  'User-Agent': getUserAgent(),
  'X-Claude-Code-Session-Id': getSessionId(),
  ...customHeaders,
  ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
  ...(remoteSessionId ? { 'x-claude-remote-session-id': remoteSessionId } : {}),
  ...(clientApp ? { 'x-client-app': clientApp } : {}),
}
```

每个请求都携带 session ID 和 app 标识，用于后端日志追踪与限流。

---

## 3. 客户端配置：Headers、超时与代理

### 3.1 超时策略

```
┌─────────────────────────────────────────────────┐
│               超时层级                            │
├─────────────────────────────────────────────────┤
│ SDK 请求超时:  600s (API_TIMEOUT_MS)             │
│ 流式空闲超时:   90s (CLAUDE_STREAM_IDLE_TIMEOUT_MS)│
│ 非流式回退超时: 120s (远程) / 300s (本地)          │
│ 连接超时:      SDK 默认                           │
└─────────────────────────────────────────────────┘
```

- **SDK 请求超时**（`client.ts:144`）：10 分钟。覆盖了 SDK 的 initial fetch + 整个 SSE 流。
- **流式空闲超时**（`claude.ts:1877-1878`）：如果 90 秒没收到任何 SSE 事件，主动中止流。
- **非流式回退超时**：当流式失败回退到非流式时，远程场景 120 秒，本地 300 秒。

### 3.2 代理与 Fetch 定制

```typescript
// src/services/api/client.ts:139
const resolvedFetch = buildFetch(fetchOverride, source)
```

`buildFetch()` 允许：
1. 调用方注入自定义 `fetch` 实现（SDK 模式）
2. 通过 `getProxyFetchOptions()` 配置 HTTP/HTTPS 代理
3. 运行时日志追踪

### 3.3 额外请求体参数

```typescript
// src/services/api/claude.ts:272-331
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    const parsed = safeParseJSON(extraBodyStr)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result = { ...(parsed as JsonObject) }   // 浅拷贝避免污染 LRU 缓存
    }
  }

  // Beta headers 合并
  if (betaHeaders && betaHeaders.length > 0) {
    result.anthropic_beta = betaHeaders
  }

  return result
}
```

`CLAUDE_CODE_EXTRA_BODY` 环境变量允许注入**任意 JSON 参数**到 API 请求体中——这是高级用户和内部调试的后门。

---

## 4. 错误处理：重试是一门艺术

### 4.1 withRetry 包装器

Claude Code 不依赖 SDK 内置重试，而是实现了一个**高度定制的重试包装器**：

```typescript
// src/services/api/withRetry.ts:170+
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T>
```

注意返回类型：它是 `AsyncGenerator`，能在重试过程中 **yield 错误消息给 UI**——用户可以看到"正在重试..."。

### 4.2 错误分类

```typescript
// src/services/api/withRetry.ts:52-55
const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500
```

```
错误分类及处理策略
─────────────────────────────────────────────────
429 (Rate Limit)    → 指数退避重试，最多 10 次
529 (Overloaded)    → 最多 3 次，超过触发模型 fallback
401 (Auth Failure)  → 刷新客户端（重新获取令牌）
403 (Revoked Token) → 刷新客户端
400 (Context Overflow) → 减少 max_tokens 重试
ECONNRESET/EPIPE    → 检测为陈旧连接，刷新客户端
Streaming 超时      → 回退到非流式模式
```

### 4.3 指数退避算法

```typescript
// src/services/api/withRetry.ts:530-548
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  // 优先使用服务器返回的 Retry-After
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  // 指数退避 + 25% jitter
  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),   // 500, 1000, 2000, 4000...
    maxDelayMs,                                   // 上限 32 秒
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}
```

退避序列（理想情况）：

| 重试次数 | 基础延迟 | 含 Jitter 范围 |
|----------|----------|----------------|
| 1 | 500ms | 500-625ms |
| 2 | 1,000ms | 1,000-1,250ms |
| 3 | 2,000ms | 2,000-2,500ms |
| 4 | 4,000ms | 4,000-5,000ms |
| 5 | 8,000ms | 8,000-10,000ms |
| 6+ | 16,000ms | 16,000-20,000ms |
| 7+ | 32,000ms (上限) | 32,000-40,000ms |

### 4.4 529 → Fallback 触发

当连续 3 次 529 错误时，触发模型回退：

```typescript
// src/services/api/withRetry.ts:326-365
if (is529Error(error) && isNonCustomOpusModel(options.model)) {
  consecutive529Errors++
  if (consecutive529Errors >= MAX_529_RETRIES) {
    if (options.fallbackModel) {
      throw new FallbackTriggeredError(
        options.model,
        options.fallbackModel,
      )
    }
  }
}
```

`FallbackTriggeredError` 是一个特殊异常，被上层捕获后切换到 `--fallback-model` 指定的模型。

### 4.5 Context Overflow 自动修复

当 400 错误提示输入 token 超出上下文窗口时：

```typescript
// src/services/api/withRetry.ts:384-427
const overflowData = parseMaxTokensContextOverflowError(error)
if (overflowData) {
  const { inputTokens, contextLimit } = overflowData
  const availableContext = Math.max(0, contextLimit - inputTokens - 1000)
  retryContext.maxTokensOverride = Math.max(
    FLOOR_OUTPUT_TOKENS,     // 最低 3000
    availableContext,
  )
  continue   // 用更小的 max_tokens 重试
}
```

这个策略是：**不是放弃，而是自动缩减输出 token 预算再试一次**。

### 4.6 前台 vs 后台查询的差异化重试

```typescript
// src/services/api/withRetry.ts:62-82
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'compact',
  'verification_agent',
  'auto_mode',
  // ...
])
```

只有**前台查询**（用户正在等待结果的）才会重试 529。后台任务（标题生成、摘要、分类器）直接放弃——因为在容量紧张时，每次重试都是 **3-10 倍的网关放大**。

### 4.7 持久重试模式（无人值守）

```typescript
// src/services/api/withRetry.ts:96-98
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000      // 5 分钟
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000   // 6 小时
const HEARTBEAT_INTERVAL_MS = 30_000                   // 30 秒心跳
```

通过 `CLAUDE_CODE_UNATTENDED_RETRY` 环境变量启用——适用于 CI/CD 场景，会**无限重试** 429/529，定期 yield 心跳消息防止宿主环境标记会话为空闲。

---

## 5. 模型参数管理

### 5.1 API 请求参数组装

API 调用的参数在 `claude.ts` 的 `queryModel()` 函数中组装：

```typescript
// src/services/api/claude.ts — queryModel() 核心参数
{
  messages,          // 标准化后的 MessageParam[]
  model,             // 解析后的模型名称
  system,            // 系统提示词数组
  max_tokens,        // 输出 token 上限
  tools,             // 工具 schema
  temperature: 1,    // 默认温度
  thinking,          // 思考配置（adaptive/enabled/disabled）
  betas,             // Beta feature headers 数组
  metadata,          // 归属和会话元数据
  stream: true,      // 流式标记
}
```

### 5.2 温度与工具

温度在 `claude.ts` 中默认设为 `1`——在扩展思维（thinking）模式下 API 要求温度为 1，所以写死了这个值。

工具（tools）通过 `toolToAPISchema()` 将内部工具定义转换为 API schema 格式后传入。

### 5.3 Prompt Caching

```typescript
// src/services/api/claude.ts:358-374
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

缓存控制附加在系统提示词和工具定义上，通过 `cache_control` 字段告诉 API 缓存这些不常变化的部分。

### 5.4 Effort 配置

```typescript
// src/services/api/claude.ts:440-466
function configureEffortParams(
  effortValue,
  outputConfig,
  extraBodyParams,
  betas,
  model,
): void {
  if (!modelSupportsEffort(model)) return

  if (typeof effortValue === 'string') {
    outputConfig.effort = effortValue       // 'low' | 'medium' | 'high'
    betas.push(EFFORT_BETA_HEADER)
  } else if (process.env.USER_TYPE === 'ant') {
    extraBodyParams.anthropic_internal = {
      effort_override: effortValue,          // 数值覆盖（内部专用）
    }
  }
}
```

Effort 控制影响模型的推理深度——`low` 更快，`high` 更深入。

---

## 6. 设计启发

### 6.1 关键设计模式

| 模式 | 实现 | 收益 |
|------|------|------|
| **策略模式** | 4 种后端动态选择 | 一套代码支持 AWS/Azure/GCP/1P |
| **责任链** | 6 层认证优先级 | 灵活的密钥解析，适配各种部署场景 |
| **装饰器模式** | `withRetry` 包装器 | API 调用与重试逻辑解耦 |
| **Generator yield** | 重试中 yield 错误消息 | 重试对用户透明可见 |
| **Circuit Breaker** | 3 次 529 → fallback | 避免无限重试加剧服务雪崩 |

### 6.2 如果你在设计自己的 LLM 客户端

1. **不要只支持一种认证方式**——未来一定会需要更多。设计成链式解析。
2. **重试不是万能药**——区分前台/后台请求，后台直接放弃可以保护整个系统。
3. **超时要分层**——SDK 超时、流式空闲超时、总体超时各管各的。
4. **错误处理要智能**——Context overflow 不是放弃，而是自动缩减参数重试。
5. **环境变量是最灵活的配置入口**——但要有合理的默认值。

### 6.3 环境变量速查表

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | First-Party API Key | — |
| `ANTHROPIC_AUTH_TOKEN` | Bearer Token | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth 令牌 | — |
| `CLAUDE_CODE_USE_BEDROCK` | 启用 AWS Bedrock | `false` |
| `CLAUDE_CODE_USE_VERTEX` | 启用 GCP Vertex | `false` |
| `CLAUDE_CODE_USE_FOUNDRY` | 启用 Azure Foundry | `false` |
| `API_TIMEOUT_MS` | 请求超时 | `600000` |
| `CLAUDE_CODE_UNATTENDED_RETRY` | 持久重试模式 | `false` |
| `CLAUDE_CODE_EXTRA_BODY` | 额外请求体 JSON | — |

---

## 延伸阅读

- [Q: 流式响应如何变成终端实时文字？](02-streaming-architecture.md) — API 调用之后的流式处理
- [Q: 如何精确管理 token 预算？](03-token-management.md) — max_tokens 的深层管理
- [Q: 如何支持多模型切换与回退？](04-model-selection.md) — 模型选择与 fallback 策略
