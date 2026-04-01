# 8 种传输实现：各自适合什么场景？

> **核心问题**：为什么 Claude Code 需要 8 种不同的传输实现？每种适合什么场景？

---

## 1. 传输类型总览

### Q: MCP 定义了哪些传输类型？

```typescript
// src/services/mcp/types.ts:L23-L26
export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
```

但实际上还有两个隐含类型（在 `McpServerConfigSchema` 联合类型中定义）：

```typescript
// src/services/mcp/types.ts:L116-L122
export const McpClaudeAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
  }),
)
```

加上代码中的 `ws-ide`，完整列表：

```
传输类型           通信方式          典型场景
────────           ────────          ────────
stdio              子进程 stdin/out  本地命令行工具
sse                HTTP SSE          远程 Web 服务
sse-ide            HTTP SSE (IDE)    VS Code 等 IDE 扩展
http               Streamable HTTP   新一代远程服务
ws                 WebSocket         实时双向远程服务
ws-ide             WebSocket (IDE)   IDE WebSocket 扩展
sdk                SDK 控制通道      嵌入 SDK 的进程内服务
claudeai-proxy     HTTP 代理         Claude.ai 云端代理
```

### Q: 一张图看清选择逻辑？

```
                        MCP Server 在哪里运行？
                                │
                ┌───────────────┼────────────────┐
                │               │                │
            本地进程         远程服务          进程内嵌入
                │               │                │
         ┌──────┴──────┐   ┌──┴────────┐    ┌──┴──────┐
         │             │   │           │    │         │
       标准         Chrome  需要      不需要  CLI进程  SDK进程
       工具         /CU    OAuth    OAuth   内嵌      内嵌
         │          扩展     │         │      │        │
         ▼           │    ┌──┴──┐    ┌─┴──┐   ▼        ▼
       stdio      InProc │     │    │    │ InProc    sdk
       (默认)     essTransport  sse   http  ws  ws-ide Transport
                         │           │
                         │           │
                    sse-ide      claudeai
                    (IDE)        -proxy
```

---

## 2. stdio — 本地子进程传输（默认）

### Q: stdio 传输是怎么工作的？

**原理**：启动一个子进程，通过 stdin/stdout 交换 JSON-RPC 消息。

```
┌──────────────┐  stdin (JSON-RPC 请求)  ┌──────────────┐
│  Claude Code  │ ──────────────────────→ │  MCP Server   │
│  (Client)     │                         │  (子进程)      │
│              │ ←────────────────────── │              │
└──────────────┘  stdout (JSON-RPC 响应)  └──────────────┘
                  stderr → 日志管道
```

**源码实现** (`src/services/mcp/client.ts:L944-L958`)：

```typescript
else if (serverRef.type === 'stdio' || !serverRef.type) {
  const finalCommand =
    process.env.CLAUDE_CODE_SHELL_PREFIX || serverRef.command
  const finalArgs = process.env.CLAUDE_CODE_SHELL_PREFIX
    ? [[serverRef.command, ...serverRef.args].join(' ')]
    : serverRef.args
  transport = new StdioClientTransport({
    command: finalCommand,
    args: finalArgs,
    env: {
      ...subprocessEnv(),     // 继承环境变量
      ...serverRef.env,       // 配置中的自定义环境变量
    } as Record<string, string>,
    stderr: 'pipe',           // stderr 不混入通信通道
  })
}
```

**配置示例**：

```typescript
// src/services/mcp/types.ts:L28-L35
export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(), // 可省略，默认就是 stdio
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
)
```

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxxx" }
    }
  }
}
```

### Q: `CLAUDE_CODE_SHELL_PREFIX` 是干什么的？

这是一个环境变量覆盖机制，允许在命令前插入前缀（如 `docker exec`）：

```typescript
// 如果设置了 CLAUDE_CODE_SHELL_PREFIX:
// 原始: command="npx", args=["-y", "server-github"]
// 变为: command=CLAUDE_CODE_SHELL_PREFIX, args=["npx -y server-github"]
const finalCommand =
  process.env.CLAUDE_CODE_SHELL_PREFIX || serverRef.command
const finalArgs = process.env.CLAUDE_CODE_SHELL_PREFIX
  ? [[serverRef.command, ...serverRef.args].join(' ')]
  : serverRef.args
```

场景：在 Docker 容器中运行 MCP Server。

### Q: stdio 的优缺点？

| 维度 | 评估 |
|------|------|
| 延迟 | ⭐⭐⭐⭐ 极低（进程间管道） |
| 部署 | ⭐⭐⭐⭐ 简单（只需可执行文件） |
| 安全 | ⭐⭐⭐⭐ 高（本地进程，无网络暴露） |
| 可靠性 | ⭐⭐⭐ 良好（进程崩溃需重启） |
| 多Client | ⭐ 差（一个进程只能服务一个Client） |
| 远程访问 | ❌ 不支持 |

---

## 3. SSE — Server-Sent Events 传输

### Q: SSE 传输如何工作？

**原理**：HTTP 长连接，Server 通过 SSE 流推送消息，Client 通过 POST 发送请求。

```
┌──────────────┐  POST /message (请求)    ┌──────────────┐
│  Claude Code  │ ──────────────────────→ │  远程 MCP     │
│  (Client)     │                         │  Server       │
│              │ ←━━━━━━━━━━━━━━━━━━━━━━ │              │
└──────────────┘  SSE 事件流 (响应+通知)   └──────────────┘
```

**源码实现** (`src/services/mcp/client.ts:L619-L676`)：

```typescript
if (serverRef.type === 'sse') {
  const authProvider = new ClaudeAuthProvider(name, serverRef)
  const combinedHeaders = await getMcpServerHeaders(name, serverRef)

  const transportOptions: SSEClientTransportOptions = {
    authProvider,
    fetch: wrapFetchWithTimeout(
      wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
    ),
    requestInit: {
      headers: {
        'User-Agent': getMCPUserAgent(),
        ...combinedHeaders,
      },
    },
  }

  // SSE 需要特殊的 EventSource 配置
  transportOptions.eventSourceInit = {
    fetch: async (url: string | URL, init?: RequestInit) => {
      const authHeaders: Record<string, string> = {}
      const tokens = await authProvider.tokens()
      if (tokens) {
        authHeaders.Authorization = `Bearer ${tokens.access_token}`
      }

      const proxyOptions = getProxyFetchOptions()
      return fetch(url, {
        ...init,
        ...proxyOptions,
        headers: {
          'User-Agent': getMCPUserAgent(),
          ...authHeaders,
          ...init?.headers,
          ...combinedHeaders,
          Accept: 'text/event-stream',
        },
      })
    },
  }

  transport = new SSEClientTransport(
    new URL(serverRef.url),
    transportOptions,
  )
}
```

**关键细节**：
- SSE 传输使用两个独立的 `fetch` 函数：一个用于 POST 请求，一个用于 SSE 事件流
- 两者都需要独立注入 OAuth Bearer Token
- `wrapFetchWithTimeout` 和 `wrapFetchWithStepUpDetection` 是安全包装层

### Q: SSE 配置格式？

```typescript
// src/services/mcp/types.ts:L58-L66
export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),   // 动态头生成脚本路径
    oauth: McpOAuthConfigSchema().optional(), // OAuth 配置
  }),
)
```

---

## 4. SSE-IDE — IDE 扩展专用 SSE

### Q: SSE-IDE 和普通 SSE 有什么区别？

**核心区别**：SSE-IDE 不需要 OAuth 认证，因为它连接的是本地 IDE 扩展。

```typescript
// src/services/mcp/types.ts:L69-L76
export const McpSSEIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse-ide'),
    url: z.string(),
    ideName: z.string(),                   // IDE 标识（如 "vscode"）
    ideRunningInWindows: z.boolean().optional(),
  }),
)
```

**源码实现** (`src/services/mcp/client.ts:L678-L707`)：

```typescript
else if (serverRef.type === 'sse-ide') {
  logMCPDebug(name, `Setting up SSE-IDE transport to ${serverRef.url}`)
  const proxyOptions = getProxyFetchOptions()
  // 只在需要代理时设置 transport options
  const transportOptions: SSEClientTransportOptions =
    proxyOptions.dispatcher
      ? {
          eventSourceInit: {
            fetch: async (url: string | URL, init?: RequestInit) => {
              return fetch(url, {
                ...init,
                ...proxyOptions,
                headers: {
                  'User-Agent': getMCPUserAgent(),
                  ...init?.headers,
                },
              })
            },
          },
        }
      : {}

  transport = new SSEClientTransport(
    new URL(serverRef.url),
    Object.keys(transportOptions).length > 0
      ? transportOptions
      : undefined,
  )
}
```

**差异对比**：

| 特征 | SSE | SSE-IDE |
|------|-----|---------|
| 认证 | OAuth Bearer Token | 无（本地信任） |
| URL | 远程 HTTPS | 本地 localhost |
| Headers | 自定义 + Auth | 仅 User-Agent |
| 使用者 | 用户配置 | IDE 扩展自动注入 |
| `ideName` | ❌ | ✅ 标识 IDE 类型 |

---

## 5. HTTP — Streamable HTTP 传输

### Q: HTTP 传输和 SSE 有什么区别？

**HTTP (Streamable HTTP)** 是 MCP 协议的新一代传输实现，替代旧的 SSE 方案：

```
SSE 方案 (旧):
  Client → POST /message   (请求)
  Server → SSE stream       (响应 + 通知)
  问题: 需要维持长连接，不适合无状态架构

HTTP 方案 (新):
  Client → POST /           (请求，支持 SSE 流式响应)
  支持会话管理 (Mcp-Session-Id)
  更灵活的请求/响应模型
```

**源码实现** (`src/services/mcp/client.ts:L784-L864`)：

```typescript
else if (serverRef.type === 'http') {
  const authProvider = new ClaudeAuthProvider(name, serverRef)
  const combinedHeaders = await getMcpServerHeaders(name, serverRef)
  const hasOAuthTokens = !!(await authProvider.tokens())

  const proxyOptions = getProxyFetchOptions()
  const transportOptions: StreamableHTTPClientTransportOptions = {
    authProvider,
    fetch: wrapFetchWithTimeout(
      wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
    ),
    requestInit: {
      ...proxyOptions,
      headers: {
        'User-Agent': getMCPUserAgent(),
        // 只在没有 OAuth Token 时使用 session ingress token
        ...(sessionIngressToken &&
          !hasOAuthTokens && {
            Authorization: `Bearer ${sessionIngressToken}`,
          }),
        ...combinedHeaders,
      },
    },
  }

  transport = new StreamableHTTPClientTransport(
    new URL(serverRef.url),
    transportOptions,
  )
}
```

**关键设计**：
- `StreamableHTTPClientTransport` 来自 MCP SDK，支持 HTTP 流式传输
- 会话 ID 通过 `Mcp-Session-Id` 头传递
- 如果 OAuth 和 sessionIngressToken 同时存在，OAuth 优先

### Q: HTTP 配置格式？

```typescript
// src/services/mcp/types.ts:L89-L97
export const McpHTTPServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOAuthConfigSchema().optional(),
  }),
)
```

---

## 6. WebSocket — 双向实时通信

### Q: WebSocket 传输何时使用？

**原理**：全双工通信，Client 和 Server 可以随时互发消息。

```
┌──────────────┐  ws://... (全双工)       ┌──────────────┐
│  Claude Code  │ ←━━━━━━━━━━━━━━━━━━━━→ │  远程 MCP     │
│  (Client)     │  JSON-RPC 双向消息       │  Server       │
└──────────────┘                          └──────────────┘
```

**源码实现** (`src/services/mcp/client.ts:L735-L783`)：

```typescript
else if (serverRef.type === 'ws') {
  const combinedHeaders = await getMcpServerHeaders(name, serverRef)
  const tlsOptions = getWebSocketTLSOptions()
  const wsHeaders = {
    'User-Agent': getMCPUserAgent(),
    ...(sessionIngressToken && {
      Authorization: `Bearer ${sessionIngressToken}`,
    }),
    ...combinedHeaders,
  }

  let wsClient: WsClientLike
  // Bun 和 Node.js 有不同的 WebSocket API
  if (typeof Bun !== 'undefined') {
    wsClient = new globalThis.WebSocket(serverRef.url, {
      protocols: ['mcp'],     // MCP 子协议
      headers: wsHeaders,
      proxy: getWebSocketProxyUrl(serverRef.url),
      tls: tlsOptions || undefined,
    } as unknown as string[])
  } else {
    wsClient = await createNodeWsClient(serverRef.url, {
      headers: wsHeaders,
      agent: getWebSocketProxyAgent(serverRef.url),
      ...(tlsOptions || {}),
    })
  }
  transport = new WebSocketTransport(wsClient)
}
```

**注意点**：
- 使用 `'mcp'` 子协议标识
- Bun 和 Node.js 运行时有不同的 WebSocket 构造器
- 支持代理配置（`getWebSocketProxyUrl`）和 TLS 选项

### Q: WS-IDE 和普通 WS 的区别？

```typescript
// src/services/mcp/types.ts:L79-L87
export const McpWebSocketIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws-ide'),
    url: z.string(),
    ideName: z.string(),
    authToken: z.string().optional(),           // IDE 专用 auth token
    ideRunningInWindows: z.boolean().optional(),
  }),
)
```

**源码实现** (`src/services/mcp/client.ts:L708-L734`)：

```typescript
else if (serverRef.type === 'ws-ide') {
  const tlsOptions = getWebSocketTLSOptions()
  const wsHeaders = {
    'User-Agent': getMCPUserAgent(),
    ...(serverRef.authToken && {
      'X-Claude-Code-Ide-Authorization': serverRef.authToken,
    }),
  }
  // ...创建 WebSocket 客户端
  transport = new WebSocketTransport(wsClient)
}
```

**差异**：
- WS-IDE 使用 `X-Claude-Code-Ide-Authorization` 头（不是标准 `Authorization`）
- 不使用 OAuth，而是 IDE 生成的短期 token
- 连接目标通常是本地 IDE 进程

---

## 7. InProcessTransport — 零开销进程内通信

### Q: InProcessTransport 解决什么问题？

某些 MCP Server（如 Chrome 扩展、Computer Use）需要在同一进程内运行，不需要启动子进程。

**完整实现** (`src/services/mcp/InProcessTransport.ts`)：

```typescript
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined
  private closed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  /** @internal */
  _setPeer(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Transport is closed')
    }
    // 异步交付，避免同步请求/响应导致的栈深度问题
    queueMicrotask(() => {
      this.peer?.onmessage?.(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onclose?.()
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true
      this.peer.onclose?.()
    }
  }
}

// 创建配对传输
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b)
  b._setPeer(a)
  return [a, b]
}
```

### Q: 为什么用 `queueMicrotask` 而不是直接调用？

这是一个精妙的设计决策：

```typescript
// ❌ 直接调用 — 可能导致栈溢出
async send(message: JSONRPCMessage): Promise<void> {
  this.peer?.onmessage?.(message)  // A.send → B.onmessage → B.send → A.onmessage → ...
}

// ✅ queueMicrotask — 打断同步调用链
async send(message: JSONRPCMessage): Promise<void> {
  queueMicrotask(() => {
    this.peer?.onmessage?.(message)  // 延迟到微任务队列，当前栈帧先返回
  })
}
```

**问题场景**：如果 Client 发送请求，Server 的 `onmessage` 立即回复，Client 的 `onmessage` 又触发新请求... 同步调用链会无限增长直到栈溢出。`queueMicrotask` 将每次消息投递推迟到下一个微任务，让当前调用栈先清空。

### Q: InProcessTransport 在哪些场景使用？

**场景 1：Chrome 扩展 MCP Server** (`src/services/mcp/client.ts:L905-L924`)：

```typescript
else if (
  (serverRef.type === 'stdio' || !serverRef.type) &&
  isClaudeInChromeMCPServer(name)
) {
  const { createChromeContext } = await import(
    '../../utils/claudeInChrome/mcpServer.js'
  )
  const { createClaudeForChromeMcpServer } = await import(
    '@ant/claude-for-chrome-mcp'
  )
  const { createLinkedTransportPair } = await import(
    './InProcessTransport.js'
  )
  const context = createChromeContext(serverRef.env)
  inProcessServer = createClaudeForChromeMcpServer(context)
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await inProcessServer.connect(serverTransport)
  transport = clientTransport  // Client 使用配对的另一端
}
```

**场景 2：Computer Use MCP Server** (`src/services/mcp/client.ts:L925-L943`)：

```typescript
else if (
  feature('CHICAGO_MCP') &&
  (serverRef.type === 'stdio' || !serverRef.type) &&
  isComputerUseMCPServer!(name)
) {
  const { createComputerUseMcpServerForCli } = await import(
    '../../utils/computerUse/mcpServer.js'
  )
  const { createLinkedTransportPair } = await import(
    './InProcessTransport.js'
  )
  inProcessServer = await createComputerUseMcpServerForCli()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await inProcessServer.connect(serverTransport)
  transport = clientTransport
}
```

**模式总结**：
```
createLinkedTransportPair() → [clientTransport, serverTransport]
                                     │                  │
                                     ▼                  ▼
                              MCP Client 使用    MCP Server 使用
                              (Claude Code)      (进程内 Server)
```

---

## 8. SdkControlTransport — CLI ↔ SDK 进程桥接

### Q: SDK 传输解决什么问题？

当 Claude Code 作为 SDK 被嵌入到其他应用时，MCP Server 运行在 SDK 进程中，而 MCP Client 运行在 CLI 进程中。需要一个桥接机制。

**架构图** (`src/services/mcp/SdkControlTransport.ts:L1-L37`)：

```
┌─────────────────────────────────────────────────────────┐
│  CLI 进程                                                │
│  ┌──────────────────┐                                    │
│  │ MCP Client       │                                    │
│  │ (claude-code)    │                                    │
│  └────────┬─────────┘                                    │
│           │ JSON-RPC                                     │
│  ┌────────┴─────────┐                                    │
│  │ SdkControlClient │                                    │
│  │ Transport         │                                    │
│  └────────┬─────────┘                                    │
└───────────┼──────────────────────────────────────────────┘
            │  stdout (control message: server_name + request_id)
            │  stdin  (control response)
┌───────────┼──────────────────────────────────────────────┐
│  SDK 进程  │                                              │
│  ┌────────┴─────────┐                                    │
│  │ SdkControlServer │                                    │
│  │ Transport         │                                    │
│  └────────┬─────────┘                                    │
│           │ JSON-RPC                                     │
│  ┌────────┴─────────┐                                    │
│  │ MCP Server       │                                    │
│  │ (SDK 内置)        │                                    │
│  └──────────────────┘                                    │
└──────────────────────────────────────────────────────────┘
```

### Q: 两端的 Transport 实现有何不同？

**Client 端** (`src/services/mcp/SdkControlTransport.ts:L60-L95`)：

```typescript
export class SdkControlClientTransport implements Transport {
  private isClosed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(
    private serverName: string,
    private sendMcpMessage: SendMcpMessageCallback,  // 跨进程发送回调
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }
    // 发送消息并等待响应（同步 request-response）
    const response = await this.sendMcpMessage(this.serverName, message)
    // 把响应传回 MCP Client
    if (this.onmessage) {
      this.onmessage(response)
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    this.onclose?.()
  }
}
```

**Server 端** (`src/services/mcp/SdkControlTransport.ts:L109-L136`)：

```typescript
export class SdkControlServerTransport implements Transport {
  private isClosed = false

  constructor(private sendMcpMessage: (message: JSONRPCMessage) => void) {}

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }
    // 简单传递 — Query 处理请求/响应关联
    this.sendMcpMessage(message)
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    this.onclose?.()
  }
}
```

**核心区别**：
- Client 端的 `send()` 是 **异步** 的 — 发送后等待响应
- Server 端的 `send()` 是 **同步回调** — 直接通过 callback 传递
- `serverName` 用于路由到正确的 SDK MCP Server（支持多个同时运行）

### Q: SDK MCP 客户端如何初始化？

```typescript
// src/services/mcp/client.ts — setupSdkMcpClients (L3262-L3348)
export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  sendMcpMessage: (
    serverName: string,
    message: JSONRPCMessage,
  ) => Promise<JSONRPCMessage>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
}> {
  // 并行连接所有 SDK Server
  const results = await Promise.allSettled(
    Object.entries(sdkMcpConfigs).map(async ([name, config]) => {
      const transport = new SdkControlClientTransport(name, sendMcpMessage)

      const client = new Client(
        {
          name: 'claude-code',
          title: 'Claude Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        { capabilities: {} },
      )

      await client.connect(transport)
      const capabilities = client.getServerCapabilities()
      // ...
    })
  )
}
```

---

## 9. claudeai-proxy — Claude.ai 云端代理

### Q: claudeai-proxy 是怎么工作的？

这是连接 Claude.ai 托管的 MCP Server 的专用传输：

```typescript
// src/services/mcp/client.ts:L868-L904
else if (serverRef.type === 'claudeai-proxy') {
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens) {
    throw new Error('No claude.ai OAuth token found')
  }

  const oauthConfig = getOauthConfig()
  // 构建代理 URL: MCP_PROXY_URL + MCP_PROXY_PATH（替换 {server_id}）
  const proxyUrl = `${oauthConfig.MCP_PROXY_URL}${
    oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)
  }`

  const fetchWithAuth = createClaudeAiProxyFetch(globalThis.fetch)
  const proxyOptions = getProxyFetchOptions()
  const transportOptions: StreamableHTTPClientTransportOptions = {
    fetch: wrapFetchWithTimeout(fetchWithAuth),
    requestInit: {
      ...proxyOptions,
      headers: {
        'User-Agent': getMCPUserAgent(),
        'X-Mcp-Client-Session-Id': getSessionId(),  // 会话跟踪
      },
    },
  }

  transport = new StreamableHTTPClientTransport(
    new URL(proxyUrl),
    transportOptions,
  )
}
```

**配置格式**：

```typescript
// src/services/mcp/types.ts:L116-L122
export const McpClaudeAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),     // 代理基础 URL
    id: z.string(),      // MCP Server 在 Claude.ai 上的 ID
  }),
)
```

**特殊之处**：
- 使用 Claude.ai 的 OAuth token（不是 MCP Server 自己的 OAuth）
- 通过 `X-Mcp-Client-Session-Id` 跟踪会话
- 底层仍然是 `StreamableHTTPClientTransport`

---

## 10. 连接状态机与生命周期

### Q: 连接超时如何处理？

```typescript
// src/services/mcp/client.ts:L1020-L1080
const connectPromise = client.connect(transport)
const timeoutPromise = new Promise<never>((_, reject) => {
  const timeoutId = setTimeout(() => {
    const elapsed = Date.now() - connectStartTime
    logMCPDebug(name,
      `Connection timeout triggered after ${elapsed}ms
       (limit: ${getConnectionTimeoutMs()}ms)`)
    if (inProcessServer) {
      inProcessServer.close().catch(() => {})
    }
    transport.close().catch(() => {})
    reject(
      new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        `MCP server "${name}" connection timed out
         after ${getConnectionTimeoutMs()}ms`,
        'MCP connection timeout',
      ),
    )
  }, getConnectionTimeoutMs())

  connectPromise.then(
    () => { clearTimeout(timeoutId) },
    _error => { clearTimeout(timeoutId) }
  )
})

// 竞争: 连接成功 vs 超时
await Promise.race([connectPromise, timeoutPromise])
```

### Q: 连接断开后如何检测和重连？

**断线检测** (`src/services/mcp/client.ts:L1216-L1371`)：

```typescript
let consecutiveConnectionErrors = 0
const MAX_ERRORS_BEFORE_RECONNECT = 3
let hasTriggeredClose = false

const isTerminalConnectionError = (msg: string): boolean => {
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EPIPE') ||
    msg.includes('EHOSTUNREACH') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('Body Timeout Error') ||
    msg.includes('terminated') ||
    msg.includes('SSE stream disconnected') ||
    msg.includes('Failed to reconnect SSE stream')
  )
}

client.onerror = (error: Error) => {
  const uptime = Date.now() - connectionStartTime
  hasErrorOccurred = true

  // 会话过期检测 (HTTP/proxy only)
  if (
    (transportType === 'http' || transportType === 'claudeai-proxy') &&
    isMcpSessionExpiredError(error)
  ) {
    closeTransportAndRejectPending('session expired')
    return
  }

  // 错误累积
  if (isTerminalConnectionError(error.message)) {
    consecutiveConnectionErrors++
    if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
      consecutiveConnectionErrors = 0
      closeTransportAndRejectPending('max consecutive terminal errors')
    }
  } else {
    consecutiveConnectionErrors = 0  // 非终端错误重置计数
  }
}
```

**重连时缓存清理** (`src/services/mcp/client.ts:L1340-L1370`)：

```typescript
client.onclose = () => {
  // 清除所有缓存，为重连做准备
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
  if (feature('MCP_SKILLS')) {
    fetchMcpSkillsForClient!.cache.delete(name)
  }
  connectToServer.cache.delete(key)
}
```

**设计精髓**：
- **3 次连续终端错误才触发重连** — 避免网络抖动导致频繁重连
- **非终端错误重置计数器** — 间歇性问题不会累积
- **会话过期立即重连** — HTTP 会话不可恢复，必须重建

---

## 11. 设计分析

### Q: 为什么需要这么多传输类型？

```
传输类型的演化路径:

v1: stdio only
    └── 问题: 不支持远程 Server

v2: + sse
    └── 问题: IDE 扩展不需要 OAuth 复杂性

v3: + sse-ide
    └── 问题: SSE 是单向的，某些场景需要双向通信

v4: + ws, ws-ide
    └── 问题: 进程内 Server 不需要 IPC 开销

v5: + InProcessTransport
    └── 问题: SDK 嵌入场景需要跨进程桥接

v6: + SdkControlTransport
    └── 问题: Claude.ai 需要云端代理

v7: + claudeai-proxy
    └── 问题: SSE 有已知限制，需要新的 HTTP 标准

v8: + http (Streamable HTTP)
    └── 当前状态: 8 种传输共存
```

**不同传输解决不同约束**：

| 约束 | 解决方案 |
|------|---------|
| 本地执行 | stdio |
| 远程 + 认证 | sse, http |
| IDE 集成（无认证） | sse-ide, ws-ide |
| 实时双向 | ws, ws-ide |
| 零进程开销 | InProcessTransport |
| 跨进程嵌入 | SdkControlTransport |
| 云端托管 | claudeai-proxy |

### Q: 如果重新设计，能减少传输类型数量吗？

可能可以合并的：
- `sse` + `http` → 统一为 `http`（Streamable HTTP 是 SSE 的超集）
- `sse-ide` + `ws-ide` → 统一为 `ws-ide`（WebSocket 更强大）

**不能合并的**：
- `stdio` — 本地进程的最简方案，不可替代
- `InProcessTransport` — 零序列化开销，不可替代
- `SdkControlTransport` — SDK 嵌入的特殊架构需求
- `claudeai-proxy` — 云端代理的独特认证模型

---

## 传输类型速查表

| 类型 | 方向 | 认证 | 延迟 | 场景 |
|------|------|------|------|------|
| stdio | 双向 (pipe) | 无 | 极低 | 本地工具 |
| sse | 半双工 | OAuth | 中等 | 远程服务 |
| sse-ide | 半双工 | 无 | 低 | IDE 扩展 |
| http | 双向 (stream) | OAuth | 中等 | 远程服务 (新) |
| ws | 全双工 | Token | 低 | 实时服务 |
| ws-ide | 全双工 | IDE Token | 低 | IDE 扩展 |
| sdk | 跨进程 | 无 | 低 | SDK 嵌入 |
| claudeai-proxy | 双向 | Claude.ai OAuth | 中等 | 云端代理 |

> **下一篇**：[03-oauth-and-security.md](./03-oauth-and-security.md) — MCP 服务器如何安全认证？
