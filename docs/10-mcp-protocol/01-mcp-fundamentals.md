# MCP 协议基础：为什么 Agent 需要标准化工具协议？

> **核心问题**：MCP 解决了什么问题？为什么 AI Agent 不能继续用自定义集成？

---

## 1. N×M 问题：工具集成的组合爆炸

### Q: 没有 MCP 之前，Agent 接入外部工具有多痛苦？

想象这样一个场景：

```
Agent 生态系统（没有标准协议）:

  Agent A ──┬── 自定义集成 ──→ GitHub API
            ├── 自定义集成 ──→ Slack API
            ├── 自定义集成 ──→ 数据库
            └── 自定义集成 ──→ 文件系统

  Agent B ──┬── 自定义集成 ──→ GitHub API（又写一遍）
            ├── 自定义集成 ──→ Slack API（又写一遍）
            ├── 自定义集成 ──→ 数据库（又写一遍）
            └── 自定义集成 ──→ 文件系统（又写一遍）

  集成总数 = N agents × M tools = N×M
  2 个 Agent × 4 个工具 = 8 个自定义集成
  10 个 Agent × 20 个工具 = 200 个自定义集成 😱
```

每个集成都需要：
- 理解特定 API 的认证方式
- 处理请求/响应格式差异
- 实现错误处理和重试逻辑
- 维护版本兼容性

### Q: MCP 如何将 N×M 降为 N+M？

**Model Context Protocol (MCP)** 定义了一个标准化接口层：

```
Agent 生态系统（有 MCP 标准协议）:

  Agent A ──┐
  Agent B ──┤── MCP 协议 ──┬── MCP Server: GitHub
  Agent C ──┘              ├── MCP Server: Slack
                           ├── MCP Server: 数据库
                           └── MCP Server: 文件系统

  集成总数 = N + M
  3 个 Agent + 4 个 Server = 7 个集成（而不是 12 个）
  10 个 Agent + 20 个 Server = 30 个集成（而不是 200 个）
```

**核心思想**：Agent（Client）和工具（Server）各自实现一次 MCP 协议，即可互相通信。这和 USB 的思路一样 — 设备制造商不需要为每台电脑设计专用接口。

---

## 2. MCP 协议基础：JSON-RPC 2.0

### Q: MCP 的底层通信用的是什么协议？

MCP 基于 **JSON-RPC 2.0** — 一个轻量级远程过程调用协议。

```typescript
// 请求格式
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}

// 响应格式
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "read_file", "description": "读取文件内容", ... }
    ]
  }
}
```

Claude Code 中的 JSON-RPC 引用：

```typescript
// src/services/mcp/client.ts:L28
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

// src/services/mcp/client.ts:L189-L205 — 会话过期检测
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus =
    'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) {
    return false
  }
  // MCP 规范: 服务器返回 404 表示会话 ID 不再有效
  // 检查 JSON-RPC 错误码 -32001 以区分普通 404
  return (
    error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
  )
}
```

**为什么选 JSON-RPC？**
- 简单：请求/响应模式，方法名 + 参数
- 语言无关：任何能处理 JSON 的语言都能实现
- 成熟：被 LSP (Language Server Protocol) 验证过的基础设施
- 错误码标准化：如 `-32001` 表示会话过期

---

## 3. 连接握手：initialize / initialized

### Q: MCP Client 和 Server 如何建立连接？

MCP 使用两阶段握手，类似 TCP 的三次握手但更简单：

```
┌──────────┐                        ┌──────────┐
│  Client   │                        │  Server   │
│(Claude    │                        │(MCP      │
│  Code)    │                        │  Server)  │
└────┬─────┘                        └────┬─────┘
     │                                    │
     │ ─── initialize(capabilities) ────→ │  阶段1: Client 发送自己的能力
     │                                    │
     │ ←── result(capabilities) ────────  │  Server 返回自己的能力
     │                                    │
     │ ─── initialized ─────────────────→ │  阶段2: Client 确认协商完成
     │                                    │
     │    ← 正常 RPC 通信开始 →           │
     │                                    │
```

在 Claude Code 源码中的实现 (`src/services/mcp/client.ts:L981-L1080`)：

```typescript
// 步骤1: 创建 MCP Client 实例
const client = new Client(
  {
    name: 'claude-code',
    title: 'Claude Code',
    version: MACRO.VERSION ?? 'unknown',
    description: "Anthropic's agentic coding tool",
    websiteUrl: PRODUCT_URL,
  },
  {
    capabilities: {},  // Client 声明自己的能力
  },
)

// 步骤2: 注册 Server 可能发来的请求处理器
client.setRequestHandler(ListRootsRequestSchema, async () => {
  return {
    roots: [
      {
        uri: `file://${getOriginalCwd()}`,  // 告诉 Server 工作目录
      },
    ],
  }
})

// 步骤3: 执行连接（内部完成 initialize/initialized 握手）
await client.connect(transport)
```

### Q: 能力协商 (Capabilities Negotiation) 具体交换什么？

```typescript
// src/services/mcp/client.ts:L1157-L1186
const capabilities = client.getServerCapabilities()
const serverVersion = client.getServerVersion()
const rawInstructions = client.getInstructions()

// 记录 Server 的能力
logMCPDebug(
  name,
  `Connection established with capabilities: ${jsonStringify({
    hasTools: !!capabilities?.tools,         // 是否提供工具
    hasPrompts: !!capabilities?.prompts,     // 是否提供 prompts
    hasResources: !!capabilities?.resources, // 是否提供资源
    hasResourceSubscribe: !!capabilities?.resources?.subscribe,
    serverVersion: serverVersion || 'unknown',
  })}`,
)
```

能力类型一览：

| 能力字段 | 含义 | 示例 |
|---------|------|------|
| `tools` | Server 提供可调用的工具 | `{ listChanged: true }` |
| `prompts` | Server 提供预定义 prompt 模板 | `{ listChanged: true }` |
| `resources` | Server 提供可读取的资源 | `{ subscribe: true }` |
| `elicitation` | Server 可能要求用户输入 | `{}` |
| `roots` | Client 提供工作目录信息 | `{}` |

**关键设计**：Client 和 Server 只使用双方都声明支持的能力。比如 Server 没有声明 `resources`，Client 就不会发送 `resources/list` 请求。

---

## 4. 核心操作：tools / resources / prompts

### Q: MCP 定义了哪些核心操作？

MCP 围绕三大原语展开：**工具 (Tools)**、**资源 (Resources)**、**提示 (Prompts)**。

```
MCP 核心操作:

┌─────────────────────────────────────────────────────────┐
│                    tools (工具)                           │
│  tools/list  → 列出所有可用工具                            │
│  tools/call  → 调用指定工具                                │
│  场景: 执行操作（读写文件、运行命令、搜索代码）               │
├─────────────────────────────────────────────────────────┤
│                  resources (资源)                         │
│  resources/list → 列出所有可用资源                          │
│  resources/read → 读取指定资源                             │
│  场景: 获取上下文信息（文档、配置、数据库 schema）            │
├─────────────────────────────────────────────────────────┤
│                   prompts (提示)                          │
│  prompts/list → 列出所有可用 prompt 模板                   │
│  prompts/get  → 获取指定 prompt（含参数填充）               │
│  场景: 预定义的交互模式（代码审查、翻译、总结）               │
└─────────────────────────────────────────────────────────┘
```

### Q: Claude Code 如何调用这些操作？

**tools/list** — 获取工具列表：

```typescript
// src/services/mcp/client.ts:L1752-L1755
const result = (await client.client.request(
  { method: 'tools/list' },
  ListToolsResultSchema,
)) as ListToolsResult
```

**resources/list** — 获取资源列表：

```typescript
// src/services/mcp/client.ts:L2009-L2012
const result = await client.client.request(
  { method: 'resources/list' },
  ListResourcesResultSchema,
)
```

**prompts/list** — 获取提示列表：

```typescript
// src/services/mcp/client.ts:L2043-L2046
const result = (await client.client.request(
  { method: 'prompts/list' },
  ListPromptsResultSchema,
)) as ListPromptsResult
```

### Q: 获取到的工具如何转换为 Claude Code 内部格式？

这是一个有趣的适配层 — MCP 工具被包装成 `MCPTool`：

```typescript
// src/services/mcp/client.ts — fetchToolsForClient (L1743-L1900)
export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    if (client.type !== 'connected') return []
    if (!client.capabilities?.tools) return []

    const result = (await client.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )) as ListToolsResult

    // Unicode 清理 — 防止恶意字符
    const toolsToProcess = recursivelySanitizeUnicode(result.tools)

    // 每个 MCP 工具被包装成 Claude Code 的 Tool 接口
    // 工具名称格式: mcp__{serverName}__{toolName}
    // ...
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
```

**名称规范化**：MCP 工具名称会被转换为 `mcp__{normalized_server_name}__{tool_name}` 格式，确保不与内置工具冲突。

**prompts → Commands** 的转换类似：

```typescript
// src/services/mcp/client.ts:L2033-L2107 — fetchCommandsForClient
// MCP prompts 被转换为 Claude Code 的 Command 接口
// 名称格式: mcp__{serverName}__{promptName}
// 参数通过空格分割传入
return promptsToProcess.map(prompt => ({
  type: 'prompt' as const,
  name: 'mcp__' + normalizeNameForMCP(client.name) + '__' + prompt.name,
  async getPromptForCommand(args: string) {
    const argsArray = args.split(' ')
    const connectedClient = await ensureConnectedClient(client)
    const result = await connectedClient.client.getPrompt({
      name: prompt.name,
      arguments: zipObject(argNames, argsArray),
    })
    // ...
  }
}))
```

---

## 5. Claude Code 的 MCP 目录结构

### Q: src/services/mcp/ 下都有什么文件？各自的职责是什么？

```
src/services/mcp/
├── client.ts                    # 🔑 核心文件 (119KB) — MCP Client 连接管理
│                                #    connectToServer(), 传输选择, 工具/资源获取
├── types.ts                     # 📋 类型定义 — Transport/Config/Connection 类型
├── config.ts                    # ⚙️  配置管理 (51KB) — 多来源配置合并
├── auth.ts                      # 🔒 OAuth 认证 (89KB) — ClaudeAuthProvider
├── xaa.ts                       # 🏢 XAA 企业认证 (18KB) — Cross-App Access
├── xaaIdpLogin.ts               # 🆔 IdP 登录 (16KB) — OIDC 发现+令牌获取
├── oauthPort.ts                 # 🔌 OAuth 端口 — 回调端口查找
├── InProcessTransport.ts        # 🔗 进程内传输 — 零子进程通信
├── SdkControlTransport.ts       # 🌉 SDK 传输桥 — CLI↔SDK 进程通信
├── MCPConnectionManager.tsx     # 🔄 连接管理器 — React 组件，管理生命周期
├── useManageMCPConnections.ts   # ⚡ 连接 Hook (45KB) — 连接/重连/断开逻辑
├── elicitationHandler.ts        # 💬 用户交互 — 处理 Server 的输入请求
├── channelAllowlist.ts          # ✅ 频道白名单 — 工具访问控制
├── channelNotification.ts       # 📢 频道通知 — Server 变更通知
├── channelPermissions.ts        # 🛡️ 频道权限 — 工具权限控制
├── claudeai.ts                  # ☁️  Claude.ai 代理 — 云端 MCP 集成
├── envExpansion.ts              # 🔤 环境变量 — 配置中的变量展开
├── headersHelper.ts             # 📨 头部助手 — 动态 HTTP 头生成
├── mcpStringUtils.ts            # 📝 字符串工具 — 名称规范化等
├── normalization.ts             # 🔧 标准化 — URL/名称标准化
├── officialRegistry.ts          # 📦 官方注册表 — 官方 MCP Server 目录
├── utils.ts                     # 🛠️ 通用工具 (18KB) — 日志安全 URL 等
└── vscodeSdkMcp.ts              # 💻 VS Code SDK — IDE 集成
```

### Q: 为什么 client.ts 有 119KB 这么大？

`client.ts` 是整个 MCP 子系统的核心，承担了过多职责：

```
client.ts 的职责分布:

┌──────────────────────────────────────────┐
│ connectToServer()          (~350 行)      │ → 传输创建 + 连接握手
│ 8 种传输类型的实例化逻辑                    │
├──────────────────────────────────────────┤
│ fetchToolsForClient()      (~150 行)      │ → 工具获取 + Tool 适配
│ fetchResourcesForClient()  (~30 行)       │ → 资源获取
│ fetchCommandsForClient()   (~75 行)       │ → Prompt→Command 适配
├──────────────────────────────────────────┤
│ 连接断线检测 + 重连逻辑      (~150 行)      │ → 错误累积 + 关闭触发
├──────────────────────────────────────────┤
│ setupSdkMcpClients()       (~80 行)       │ → SDK 进程 MCP 连接
├──────────────────────────────────────────┤
│ IDE 工具白名单 + 权限控制     (~50 行)      │ → 安全边界
├──────────────────────────────────────────┤
│ 辅助函数、日志、缓存           (剩余)       │
└──────────────────────────────────────────┘
```

这是一个典型的 "God Object" 问题 — 随着功能增长，单个文件承担了过多职责。

---

## 6. 配置来源：七种 Scope

### Q: MCP Server 的配置可以从哪些地方加载？

```typescript
// src/services/mcp/types.ts:L10-L21
export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',       // 本地项目配置 (.mcp.json)
    'user',        // 用户全局配置 (~/.claude/settings.json)
    'project',     // 项目级配置
    'dynamic',     // 运行时动态添加
    'enterprise',  // 企业级配置（管理员下发）
    'claudeai',    // Claude.ai 云端代理
    'managed',     // 托管配置
  ]),
)
```

配置优先级和信任层次：

```
信任等级:     高 ─────────────────────────────── 低
              │                                   │
              ▼                                   ▼
           enterprise  >  user  >  project  >  local  >  dynamic
           (管理员)      (用户)    (项目)      (本地)    (运行时)

特殊：
           claudeai  — 云端代理，独立信任链
           managed   — 托管服务，独立信任链
```

每个 MCP Server 配置都带有 `scope` 标签 (`ScopedMcpServerConfig`)：

```typescript
// src/services/mcp/types.ts:L163-L169
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  // 插件来源标识（如 'slack@anthropic'）
  pluginSource?: string
}
```

---

## 7. 连接状态机

### Q: MCP 连接有几种状态？状态之间如何转换？

```typescript
// src/services/mcp/types.ts:L221-L226
export type MCPServerConnection =
  | ConnectedMCPServer    // ✅ 已连接，正常工作
  | FailedMCPServer       // ❌ 连接失败
  | NeedsAuthMCPServer    // 🔑 需要认证
  | PendingMCPServer      // ⏳ 连接中
  | DisabledMCPServer     // 🚫 已禁用
```

状态转换图：

```
                    ┌──────────────────────┐
                    │      Disabled        │
                    │   (用户主动禁用)      │
                    └──────────┬───────────┘
                               │ 用户启用
                               ▼
  ┌───────────┐    ┌──────────────────────┐    ┌───────────────┐
  │           │    │      Pending         │    │               │
  │  Failed   │←───│   (正在连接...)       │───→│  Connected    │
  │  (失败)    │    │  reconnectAttempt    │    │  (已连接)      │
  │           │    │  maxReconnectAttempts │    │               │
  └─────┬─────┘    └──────────┬───────────┘    └──────┬────────┘
        │                     │                        │
        │                     ▼                        │ 连接断开
        │          ┌──────────────────────┐            │
        │          │    NeedsAuth         │            │
        └──────────│  (需要 OAuth 认证)    │←───────────┘
                   └──────────────────────┘
                               │ 认证完成
                               ▼
                         回到 Pending
```

每种状态携带的数据不同：

```typescript
// Connected — 最完整的状态
type ConnectedMCPServer = {
  client: Client              // MCP SDK Client 实例
  name: string                // Server 名称
  type: 'connected'
  capabilities: ServerCapabilities  // 协商后的能力
  serverInfo?: { name: string; version: string }
  instructions?: string       // Server 提供的指令
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>  // 清理函数
}

// Pending — 带重连信息
type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number       // 当前重连次数
  maxReconnectAttempts?: number   // 最大重连次数
}

// Failed — 带错误描述
type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string                  // 失败原因
}
```

---

## 8. MCP CLI 状态序列化

### Q: Claude Code 如何在 CLI 模式下传递 MCP 状态？

在 SDK/非交互模式下，MCP 状态需要序列化传递：

```typescript
// src/services/mcp/types.ts:L252-L258
export interface MCPCliState {
  clients: SerializedClient[]                    // 连接状态列表
  configs: Record<string, ScopedMcpServerConfig> // 配置映射
  tools: SerializedTool[]                        // 工具定义
  resources: Record<string, ServerResource[]>    // 资源列表
  normalizedNames?: Record<string, string>       // 名称映射
}
```

序列化的工具格式刻意简化：

```typescript
// src/services/mcp/types.ts:L232-L244
export interface SerializedTool {
  name: string
  description: string
  inputJSONSchema?: {
    [x: string]: unknown
    type: 'object'
    properties?: { [x: string]: unknown }
  }
  isMcp?: boolean           // 标记为 MCP 工具
  originalToolName?: string // 规范化前的原始名称
}
```

---

## 9. 设计分析

### Q: MCP 协议标准化带来了什么取舍？

**✅ 优势**：

1. **可组合性** — 任何 MCP Client 可以连接任何 MCP Server
2. **降低维护成本** — N+M 而非 N×M
3. **安全边界清晰** — 协议层定义了权限模型
4. **渐进式增强** — 通过能力协商支持不同版本

**⚠️ 代价**：

1. **抽象税** — 简单的本地工具调用也要走完整协议栈
2. **最低公分母** — 协议只能表达所有工具的共同能力
3. **性能开销** — JSON-RPC 序列化/反序列化、传输层延迟
4. **版本演进困难** — 标准协议的变更需要生态系统协调

### Q: Claude Code 在 MCP 标准之上做了哪些扩展？

```
标准 MCP 协议              Claude Code 扩展
─────────────              ─────────────────
tools/list                 → Unicode 清理 + 名称规范化
tools/call                 → 进度回调 + 权限检查
resources/list             → Server 名称注入
prompts/list               → Command 适配层
连接管理                    → 8 种传输 + 自动重连
认证                        → OAuth + XAA 企业认证
                           → IDE 工具白名单
                           → 频道权限控制
                           → Elicitation (用户交互)
```

### Q: 为什么 MCP 选择 JSON-RPC 而不是 gRPC 或 GraphQL？

| 维度 | JSON-RPC | gRPC | GraphQL |
|------|----------|------|---------|
| 序列化 | JSON (人类可读) | Protobuf (二进制) | JSON |
| 传输 | 传输无关 | HTTP/2 | HTTP |
| Schema | 可选 | 强制 (.proto) | 强制 (SDL) |
| 流式 | 需扩展 | 原生支持 | Subscription |
| 学习曲线 | 极低 | 中等 | 中等 |
| 工具生态 | 广泛 | 较窄 | 中等 |

MCP 选择 JSON-RPC 的核心理由：
- **传输无关**：可以跑在 stdio、HTTP、WebSocket 等任何传输上
- **极简**：实现一个 JSON-RPC 端点只需几十行代码
- **LSP 验证**：Language Server Protocol 用同样的基础设施证明了可行性
- **调试友好**：纯文本协议，`cat` 就能看懂消息

---

## 10. 实际消息流示例

### Q: 一次完整的 MCP 工具调用，消息是怎么流动的？

以 Claude Code 调用 GitHub MCP Server 的 `search_repositories` 为例：

```
时间线:

1. [启动时] Client → Server: initialize
   {
     "jsonrpc": "2.0", "id": 0,
     "method": "initialize",
     "params": {
       "protocolVersion": "2024-11-05",
       "capabilities": {},
       "clientInfo": {
         "name": "claude-code",
         "version": "2.1.88"
       }
     }
   }

2. [启动时] Server → Client: initialize result
   {
     "jsonrpc": "2.0", "id": 0,
     "result": {
       "protocolVersion": "2024-11-05",
       "capabilities": { "tools": { "listChanged": true } },
       "serverInfo": { "name": "github-mcp", "version": "1.0.0" }
     }
   }

3. [启动时] Client → Server: initialized
   { "jsonrpc": "2.0", "method": "notifications/initialized" }

4. [用户请求时] Client → Server: tools/list
   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }

5. [用户请求时] Server → Client: tools result
   {
     "jsonrpc": "2.0", "id": 1,
     "result": {
       "tools": [{
         "name": "search_repositories",
         "description": "搜索 GitHub 仓库",
         "inputSchema": {
           "type": "object",
           "properties": {
             "query": { "type": "string" }
           },
           "required": ["query"]
         }
       }]
     }
   }

6. [LLM 决定调用] Client → Server: tools/call
   {
     "jsonrpc": "2.0", "id": 2,
     "method": "tools/call",
     "params": {
       "name": "search_repositories",
       "arguments": { "query": "mcp protocol language:typescript" }
     }
   }

7. [工具执行完成] Server → Client: call result
   {
     "jsonrpc": "2.0", "id": 2,
     "result": {
       "content": [{
         "type": "text",
         "text": "[{\"name\": \"modelcontextprotocol/servers\", ...}]"
       }]
     }
   }
```

**关键观察**：
- 步骤 1-3 只在连接建立时执行一次
- 步骤 4-5 的工具列表通常会被缓存（`memoizeWithLRU`）
- 步骤 6-7 是每次工具调用都要执行的核心交互
- 所有消息都是标准 JSON-RPC 格式

---

## 小结

| 概念 | 一句话解释 |
|------|-----------|
| MCP | Model Context Protocol — AI Agent 的标准化工具接口 |
| N×M → N+M | 标准协议将集成数量从乘法降为加法 |
| JSON-RPC 2.0 | 底层通信协议，轻量、传输无关 |
| initialize / initialized | 两阶段握手，协商 Client/Server 能力 |
| tools/list + tools/call | 最核心的操作 — 列出并调用工具 |
| resources / prompts | 资源读取 + 预定义 prompt 模板 |
| ConfigScope | 七种配置来源，从企业级到运行时动态 |
| MCPServerConnection | 五种连接状态的联合类型 |

> **下一篇**：[02-transport-implementations.md](./02-transport-implementations.md) — 8 种传输实现各自适合什么场景？
