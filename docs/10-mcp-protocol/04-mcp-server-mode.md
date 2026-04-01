# Claude Code 作为 MCP Server：双重身份的设计

> **核心问题**：Claude Code 既是 MCP Client（调用其他工具），又是 MCP Server（被其他系统调用）。这个双重身份是怎么实现的？

---

## 1. 为什么需要 Server 模式？

### Q: Claude Code 作为 MCP Server 能解决什么问题？

```
场景1: IDE 集成
┌──────────┐  MCP 协议  ┌──────────────┐
│  VS Code  │ ────────→ │  Claude Code  │
│  (Client) │           │  (MCP Server) │
└──────────┘           └──────────────┘
VS Code 通过 MCP 协议调用 Claude Code 的所有内置工具

场景2: Agent 编排
┌──────────┐  MCP 协议  ┌──────────────┐
│  外部     │ ────────→ │  Claude Code  │
│  Agent    │           │  (MCP Server) │
└──────────┘           └──────────────┘
其他 AI Agent 通过 MCP 协议使用 Claude Code 的能力

场景3: 自动化管道
┌──────────┐  MCP 协议  ┌──────────────┐
│  CI/CD   │ ────────→ │  Claude Code  │
│  系统     │           │  (MCP Server) │
└──────────┘           └──────────────┘
自动化系统调用 Claude Code 进行代码审查等任务
```

**核心价值**：Claude Code 拥有丰富的内置工具（文件读写、代码搜索、命令执行、代码审查等），通过 MCP Server 模式，这些能力可以被任何 MCP Client 复用。

---

## 2. 入口文件：src/entrypoints/mcp.ts

### Q: MCP Server 的完整实现有多少行？

只有 **197 行**。这是整个 Claude Code 项目中最精简的入口之一。

**文件结构**：

```typescript
// src/entrypoints/mcp.ts — 完整结构
import { Server } from '@modelcontextprotocol/sdk/server/index.js'       // L1
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'  // L2
import { CallToolRequestSchema, ListToolsRequestSchema } from '...'      // L3-L9
// ... 其他 imports                                                       // L10-L28

type ToolInput = Tool['inputSchema']                                      // L30
type ToolOutput = Tool['outputSchema']                                    // L31
const MCP_COMMANDS: Command[] = [review]                                  // L33

export async function startMCPServer(                                     // L35
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // 1. 初始化                                                            // L39-L57
  // 2. ListToolsRequestSchema handler                                    // L59-L97
  // 3. CallToolRequestSchema handler                                     // L99-L188
  // 4. 启动 Transport                                                    // L190-L196
}
```

---

## 3. Server 初始化

### Q: MCP Server 是怎么创建的？

```typescript
// src/entrypoints/mcp.ts:L35-L57
export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // 步骤1: 创建文件状态缓存（LRU，防止无限内存增长）
  const READ_FILE_STATE_CACHE_SIZE = 100
  const readFileStateCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,  // 最多缓存 100 个文件，25MB 限制
  )

  // 步骤2: 设置工作目录
  setCwd(cwd)

  // 步骤3: 创建 MCP Server 实例
  const server = new Server(
    {
      name: 'claude/tengu',        // Server 标识名
      version: MACRO.VERSION,      // 构建时注入的版本号
    },
    {
      capabilities: {
        tools: {},                 // 只声明了 tools 能力
        // 注意：没有 resources、prompts、elicitation
      },
    },
  )
  // ...
}
```

**关键设计决策**：

| 决策 | 选择 | 原因 |
|------|------|------|
| Server 名称 | `'claude/tengu'` | Tengu (天狗) 是项目内部代号 |
| 声明能力 | 只有 `tools` | Server 模式只暴露工具调用能力 |
| 文件缓存 | 100 文件 / 25MB | MCP Server 长期运行，防止 OOM |
| resources | ❌ 未启用 | 暂时不暴露资源读取 |
| prompts | ❌ 未启用 | 暂时不暴露 prompt 模板 |

### Q: 为什么只暴露 tools 而不暴露 resources 和 prompts？

这是一个有意的最小化设计：

```
Claude Code 内置工具 (全部通过 tools 暴露):
  ├── ReadFile      → 读取文件（工具 = 主动操作）
  ├── WriteFile     → 写入文件
  ├── SearchFiles   → 搜索文件
  ├── ExecuteCommand → 执行命令
  ├── ...
  └── Review        → 代码审查（通过 MCP_COMMANDS 暴露）

Resources 适合:
  └── 被动数据源（如文件列表、配置）→ 对 Agent 场景价值不大

Prompts 适合:
  └── 预定义模板 → 工具本身已通过 description 提供足够信息
```

源码中的 TODO 也印证了这一点：

```typescript
// src/entrypoints/mcp.ts:L62
// TODO: Also re-expose any MCP tools
```

未来可能会把 Claude Code 作为 Client 连接的 MCP 工具也通过 Server 模式再暴露出去。

---

## 4. ListToolsRequestSchema — 工具列表暴露

### Q: Client 请求 tools/list 时发生了什么？

```typescript
// src/entrypoints/mcp.ts:L59-L97
server.setRequestHandler(
  ListToolsRequestSchema,
  async (): Promise<ListToolsResult> => {
    const toolPermissionContext = getEmptyToolPermissionContext()
    const tools = getTools(toolPermissionContext)
    return {
      tools: await Promise.all(
        tools.map(async tool => {
          let outputSchema: ToolOutput | undefined
          if (tool.outputSchema) {
            const convertedSchema = zodToJsonSchema(tool.outputSchema)
            // 过滤: 只接受 type: "object" 的根级 schema
            if (
              typeof convertedSchema === 'object' &&
              convertedSchema !== null &&
              'type' in convertedSchema &&
              convertedSchema.type === 'object'
            ) {
              outputSchema = convertedSchema as ToolOutput
            }
          }
          return {
            ...tool,
            description: await tool.prompt({
              getToolPermissionContext: async () => toolPermissionContext,
              tools,
              agents: [],
            }),
            inputSchema: zodToJsonSchema(tool.inputSchema) as ToolInput,
            outputSchema,
          }
        }),
      ),
    }
  },
)
```

**工具转换流水线**：

```
Claude Code 内部 Tool 格式               MCP Tool 格式
─────────────────────────                ──────────────
tool.name              ───────────────→  name
tool.prompt()          ── async 调用 ──→  description (string)
tool.inputSchema (Zod) ── zodToJson ──→  inputSchema (JSON Schema)
tool.outputSchema (Zod) ── 过滤 + 转换→  outputSchema (JSON Schema | undefined)
其他属性               ── spread ─────→  保留
```

### Q: outputSchema 为什么需要过滤？

这是一个重要的兼容性处理：

```typescript
// src/entrypoints/mcp.ts:L71-L81
// MCP SDK requires outputSchema to have type: "object" at root level
// Skip schemas with anyOf/oneOf at root
// (from z.union, z.discriminatedUnion, etc.)
// See: https://github.com/anthropics/claude-code/issues/8014
if (
  typeof convertedSchema === 'object' &&
  convertedSchema !== null &&
  'type' in convertedSchema &&
  convertedSchema.type === 'object'
) {
  outputSchema = convertedSchema as ToolOutput
}
```

**问题根源**：

```
Zod 类型                     JSON Schema 输出           MCP 兼容？
─────────                    ─────────────────          ──────────
z.object({...})          →   { type: "object", ... }    ✅ 兼容
z.string()               →   { type: "string" }         ❌ 非 object
z.union([A, B])          →   { anyOf: [A, B] }          ❌ 无 type
z.discriminatedUnion()   →   { oneOf: [A, B] }          ❌ 无 type
```

**MCP SDK 的限制**：`outputSchema` 必须是 `{ type: "object" }` 格式。如果 Claude Code 工具的输出类型是联合类型（如 `string | { data: ... }`），生成的 JSON Schema 会包含 `anyOf/oneOf`，不符合 MCP 要求。

**解决方案**：遇到不兼容的 schema，直接跳过（`outputSchema = undefined`）。这意味着这些工具仍然可用，只是 Client 不知道输出的精确格式。

### Q: zodToJsonSchema 是怎么实现的？

```typescript
// src/utils/zodToJsonSchema.ts
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = toJSONSchema(schema) as JsonSchema7Type  // Zod v4 原生方法
  cache.set(schema, result)
  return result
}
```

**设计亮点**：
- 使用 `WeakMap` 缓存：schema 对象被 GC 时缓存自动清理
- 利用 Zod v4 原生 `toJSONSchema()`：不需要第三方库
- 每个工具的 schema 在进程生命周期内只转换一次

---

## 5. CallToolRequestSchema — 工具调用执行

### Q: Client 调用工具时的完整流程是什么？

```typescript
// src/entrypoints/mcp.ts:L99-L188
server.setRequestHandler(
  CallToolRequestSchema,
  async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
    // 步骤1: 查找工具
    const toolPermissionContext = getEmptyToolPermissionContext()
    const tools = getTools(toolPermissionContext)
    const tool = findToolByName(tools, name)
    if (!tool) {
      throw new Error(`Tool ${name} not found`)
    }

    // 步骤2: 构建执行上下文
    const toolUseContext: ToolUseContext = {
      abortController: createAbortController(),
      options: {
        commands: MCP_COMMANDS,       // 只包含 review 命令
        tools,
        mainLoopModel: getMainLoopModel(),
        thinkingConfig: { type: 'disabled' },  // 无思考模式
        mcpClients: [],               // 不连接其他 MCP Server
        mcpResources: {},
        isNonInteractiveSession: true, // 非交互模式
        debug,
        verbose,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      getAppState: () => getDefaultAppState(),
      setAppState: () => {},          // 状态变更无操作
      messages: [],                   // 空消息历史
      readFileState: readFileStateCache,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    }

    // 步骤3: 验证并执行
    try {
      if (!tool.isEnabled()) {
        throw new Error(`Tool ${name} is not enabled`)
      }

      // 输入验证
      const validationResult = await tool.validateInput?.(
        (args as never) ?? {},
        toolUseContext,
      )
      if (validationResult && !validationResult.result) {
        throw new Error(
          `Tool ${name} input is invalid: ${validationResult.message}`,
        )
      }

      // 执行工具
      const finalResult = await tool.call(
        (args ?? {}) as never,
        toolUseContext,
        hasPermissionsToUseTool,       // 权限检查函数
        createAssistantMessage({ content: [] }),
      )

      // 步骤4: 格式化输出
      return {
        content: [
          {
            type: 'text' as const,
            text:
              typeof finalResult === 'string'
                ? finalResult
                : jsonStringify(finalResult.data),
          },
        ],
      }
    } catch (error) {
      // 步骤5: 错误处理
      logError(error)
      const parts =
        error instanceof Error ? getErrorParts(error) : [String(error)]
      const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

      return {
        isError: true,
        content: [{ type: 'text', text: errorText }],
      }
    }
  },
)
```

### Q: ToolUseContext 中的各个字段意味着什么？

```
ToolUseContext 各字段解析:

┌──────────────────────────────────────────────────────────────┐
│ abortController                                              │
│ → 取消控制器，允许中断长时间运行的工具                           │
├──────────────────────────────────────────────────────────────┤
│ options.commands = [review]                                   │
│ → 只暴露 review 命令（不是所有命令都适合 MCP 场景）              │
├──────────────────────────────────────────────────────────────┤
│ options.thinkingConfig = { type: 'disabled' }                │
│ → 禁用 extended thinking（MCP 调用不需要思考过程）              │
├──────────────────────────────────────────────────────────────┤
│ options.mcpClients = []                                      │
│ → 不连接其他 MCP Server（避免循环依赖）                        │
├──────────────────────────────────────────────────────────────┤
│ options.isNonInteractiveSession = true                       │
│ → 非交互模式（不弹出确认对话框）                               │
├──────────────────────────────────────────────────────────────┤
│ messages = []                                                │
│ → 空消息历史（每次工具调用独立，无上下文）                       │
├──────────────────────────────────────────────────────────────┤
│ readFileState = readFileStateCache                           │
│ → 带 LRU 限制的文件缓存（100 文件 / 25MB）                    │
├──────────────────────────────────────────────────────────────┤
│ setAppState = () => {}                                       │
│ → 状态变更无操作（Server 模式是无状态的）                       │
├──────────────────────────────────────────────────────────────┤
│ agentDefinitions = { activeAgents: [], allAgents: [] }       │
│ → 无 Agent 定义（Server 模式不支持子 Agent）                   │
└──────────────────────────────────────────────────────────────┘
```

### Q: 为什么 `mcpClients = []`？这意味着什么？

这是一个**防止递归**的重要决策：

```
如果 mcpClients 不为空:

外部 Client → Claude Code (MCP Server)
                    │
                    └→ 调用内置工具
                    └→ 内置工具可能调用其他 MCP Server
                    └→ 其他 MCP Server 可能又调用 Claude Code
                    └→ 无限循环！

设置 mcpClients = []:

外部 Client → Claude Code (MCP Server)
                    │
                    └→ 调用内置工具
                    └→ 工具执行完毕，直接返回
                    ✅ 无循环风险
```

源码注释也提到了未来可能改变这个限制：

```typescript
// src/entrypoints/mcp.ts:L62
// TODO: Also re-expose any MCP tools

// src/entrypoints/mcp.ts:L103
// TODO: Also re-expose any MCP tools
```

---

## 6. 输出格式化

### Q: 工具执行结果是怎么转换为 MCP 响应的？

```typescript
// src/entrypoints/mcp.ts:L159-L169
return {
  content: [
    {
      type: 'text' as const,
      text:
        typeof finalResult === 'string'
          ? finalResult                    // 字符串直接返回
          : jsonStringify(finalResult.data), // 对象 JSON 序列化
    },
  ],
}
```

**两种输出路径**：

```
Tool.call() 返回值              MCP 响应
────────────────                ─────────
string                    →    { type: "text", text: <原始字符串> }
{ data: any, ... }        →    { type: "text", text: JSON.stringify(data) }
```

**注意**：所有输出都被包装成 `text` 类型。即使工具返回结构化数据，也会被 JSON 序列化为字符串。这是因为 MCP `CallToolResult` 的 content 格式较为有限。

### Q: 错误处理有什么特别的？

```typescript
// src/entrypoints/mcp.ts:L170-L186
catch (error) {
  logError(error)

  // 使用 getErrorParts 提取错误的多个部分
  const parts =
    error instanceof Error ? getErrorParts(error) : [String(error)]
  const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

  return {
    isError: true,               // 标记为错误响应
    content: [
      {
        type: 'text',
        text: errorText,         // 人类可读的错误信息
      },
    ],
  }
}
```

**错误格式对比**：

```
正常响应:
{
  "content": [{ "type": "text", "text": "文件内容..." }]
}

错误响应:
{
  "isError": true,
  "content": [{ "type": "text", "text": "Tool read_file input is invalid: ..." }]
}
```

`isError: true` 让 Client 可以区分工具执行失败和正常返回空结果。

---

## 7. StdioServerTransport：通信通道

### Q: MCP Server 使用什么传输？

```typescript
// src/entrypoints/mcp.ts:L190-L195
async function runServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

return await runServer()
```

**为什么是 stdio？**

```
stdio 传输的优势:

1. 零配置: 不需要端口号、URL、证书
2. 零网络: 不暴露网络接口
3. 进程管理: Client 启动 Server 进程，天然具备生命周期管理
4. 简单: JSON-RPC 消息通过 stdin/stdout 交换

典型启动方式:
$ claude mcp serve
# Client (如 VS Code) 通过 stdio 与此进程通信
```

**数据流**：

```
┌──────────┐                        ┌──────────────┐
│  MCP     │  stdin → JSON-RPC 请求  │  Claude Code  │
│  Client  │ ──────────────────────→ │  MCP Server   │
│          │                         │  (stdio 模式)  │
│          │ ←────────────────────── │              │
└──────────┘  stdout ← JSON-RPC 响应 └──────────────┘
```

---

## 8. CLI 启动流程

### Q: `claude mcp serve` 命令是怎么触发的？

```typescript
// src/cli/handlers/mcp.tsx:L42-L70
export async function mcpServeHandler({
  debug,
  verbose,
}: {
  debug?: boolean
  verbose?: boolean
}): Promise<void> {
  const providedCwd = cwd()

  // 记录启动事件
  logEvent('tengu_mcp_start', {})

  // 加载配置和设置
  const { setup } = await import('../../setup.js')
  await setup(providedCwd, 'default', false, false, undefined, false)

  // 启动 MCP Server
  const { startMCPServer } = await import('../../entrypoints/mcp.js')
  await startMCPServer(providedCwd, debug ?? false, verbose ?? false)
}
```

**启动链**：

```
用户命令:     claude mcp serve [--debug] [--verbose]
                  │
CLI 路由:     src/cli/handlers/mcp.tsx → mcpServeHandler()
                  │
设置阶段:     setup() → 加载配置、环境初始化
                  │
入口函数:     src/entrypoints/mcp.ts → startMCPServer()
                  │
Server 创建:  new Server('claude/tengu', { tools: {} })
                  │
Handler 注册: setRequestHandler(ListTools...) + setRequestHandler(CallTool...)
                  │
传输连接:     new StdioServerTransport() → server.connect(transport)
                  │
等待请求:     stdin 监听中...
```

---

## 9. 其他 MCP Server 实例

### Q: 除了主入口，还有哪些 MCP Server 实现？

Claude Code 项目中有 **3 个** 独立的 MCP Server：

**1. 主 MCP Server** (`src/entrypoints/mcp.ts`)
- 暴露所有内置工具
- stdio 传输
- 通过 `claude mcp serve` 启动

**2. Chrome 扩展 MCP Server** (`src/utils/claudeInChrome/mcpServer.ts`)
- 用于 Claude in Chrome 浏览器扩展
- 使用 `StdioServerTransport`
- 集成 lightning-mode Agent 循环
- 处理推理回调 (inference callbacks)

**3. Computer Use MCP Server** (`src/utils/computerUse/mcpServer.ts`)
- 用于计算机使用场景（屏幕截图、鼠标/键盘操作）
- 使用 `StdioServerTransport`
- 受 feature flag `CHICAGO_MCP` 控制

**它们都通过 InProcessTransport 集成到 Client**：

```typescript
// src/services/mcp/client.ts:L905-L943
// Chrome 扩展和 Computer Use 都使用相同模式:
const [clientTransport, serverTransport] = createLinkedTransportPair()
await inProcessServer.connect(serverTransport)
transport = clientTransport  // Client 用这端通信
```

---

## 10. IDE 工具白名单

### Q: IDE 通过 MCP 调用 Claude Code 时有什么限制？

```typescript
// src/services/mcp/client.ts:L567-L572
const ALLOWED_IDE_TOOLS = [
  'mcp__ide__executeCode',
  'mcp__ide__getDiagnostics',
]

function isIncludedMcpTool(tool: Tool): boolean {
  return (
    !tool.name.startsWith('mcp__ide__') ||
    ALLOWED_IDE_TOOLS.includes(tool.name)
  )
}
```

**安全模型**：

```
IDE 提供的 MCP 工具:
  mcp__ide__executeCode      ✅ 允许（执行代码片段）
  mcp__ide__getDiagnostics   ✅ 允许（获取诊断信息）
  mcp__ide__openFile         ❌ 被过滤（不在白名单）
  mcp__ide__refactor         ❌ 被过滤（不在白名单）

规则: 以 mcp__ide__ 开头的工具，只有白名单中的才会暴露给 LLM
非 IDE 工具: 不受此限制
```

这是一个**最小权限原则**的实践 — IDE 的 MCP 工具不是全部都暴露给 AI，只暴露经过审核的子集。

---

## 11. 双重身份架构

### Q: Claude Code 同时作为 Client 和 Server 的架构是怎样的？

```
┌──────────────────────────────────────────────────────────────┐
│                      Claude Code 进程                         │
│                                                               │
│  ┌──────────────────────────────────────────────┐            │
│  │ MCP Client 角色                               │            │
│  │                                               │            │
│  │ connectToServer() → 连接外部 MCP Server         │            │
│  │ fetchToolsForClient() → 获取外部工具            │            │
│  │ 8 种传输实现                                    │            │
│  │ OAuth + XAA 认证                               │            │
│  │                                               │            │
│  │ 连接的 Server:                                 │            │
│  │   ├── GitHub MCP Server                       │            │
│  │   ├── Slack MCP Server                        │            │
│  │   ├── 自定义 MCP Server                       │            │
│  │   └── ...                                     │            │
│  └──────────────────────────────────────────────┘            │
│                                                               │
│  ┌──────────────────────────────────────────────┐            │
│  │ MCP Server 角色 (claude mcp serve)             │            │
│  │                                               │            │
│  │ ListToolsRequestSchema → 暴露内置工具           │            │
│  │ CallToolRequestSchema → 执行内置工具            │            │
│  │ StdioServerTransport                           │            │
│  │                                               │            │
│  │ 被谁调用:                                      │            │
│  │   ├── VS Code (IDE)                           │            │
│  │   ├── 其他 AI Agent                           │            │
│  │   ├── 自动化系统                               │            │
│  │   └── ...                                     │            │
│  └──────────────────────────────────────────────┘            │
│                                                               │
│  ┌──────────────────────────────────────────────┐            │
│  │ 内置工具 (两种角色共享)                         │            │
│  │                                               │            │
│  │ ReadFile, WriteFile, SearchFiles,              │            │
│  │ ExecuteCommand, GlobTool, GrepTool,            │            │
│  │ Review, ...                                    │            │
│  └──────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────┘
```

### Q: Client 和 Server 模式是否同时运行？

**不是**。Claude Code 在启动时选择一种模式：

```
启动模式选择:

$ claude                     → 交互模式 (内置 MCP Client)
$ claude -p "query"          → 单次查询模式 (内置 MCP Client)
$ claude mcp serve           → MCP Server 模式 (只暴露工具)
```

在 Server 模式下：
- `mcpClients = []` — 不连接外部 MCP Server
- `isNonInteractiveSession = true` — 无交互
- `messages = []` — 无会话历史
- `thinkingConfig = { type: 'disabled' }` — 无 extended thinking

这意味着 **Server 模式是一个"纯工具执行引擎"**，不具备 Agent 推理能力。

---

## 12. MCP_COMMANDS：暴露的命令

### Q: 为什么只暴露了 review 命令？

```typescript
// src/entrypoints/mcp.ts:L33
const MCP_COMMANDS: Command[] = [review]
```

`review` 是 Claude Code 的代码审查命令。它被特别选中放入 MCP Server 是因为：

1. **独立性** — 代码审查可以独立执行，不需要上下文
2. **安全性** — 只读操作，不修改文件
3. **实用性** — CI/CD 管道的常见需求

```typescript
// 使用示例:
// MCP Client 可以这样调用代码审查:
{
  "method": "tools/call",
  "params": {
    "name": "review",
    "arguments": { /* 审查参数 */ }
  }
}
```

---

## 13. 设计分析

### Q: MCP Server 模式的架构权衡是什么？

**✅ 优势**：

1. **复用性极高** — 197 行代码就暴露了所有内置工具
2. **标准协议** — 任何 MCP Client 都能连接
3. **安全隔离** — Server 模式是无状态的纯函数式执行
4. **简单传输** — stdio 零配置

**⚠️ 限制**：

1. **无 Agent 推理** — 只是工具执行，不能做多步推理
2. **无上下文** — 每次调用独立，不记住历史
3. **无递归 MCP** — 不能通过 MCP Server 访问其他 MCP Server
4. **输出格式有限** — 所有结果都是 text 类型

### Q: 这些限制可以突破吗？

```
未来可能的增强:

1. 暴露 resources:
   → 让 Client 可以直接读取项目文件结构
   → 需要安全审查（防止路径穿越）

2. 暴露 prompts:
   → 预定义的工作流模板（代码审查、重构、调试）
   → 需要设计参数化接口

3. 级联 MCP:
   → Server 模式连接其他 MCP Server
   → 需要解决循环依赖和认证传递

4. 有状态会话:
   → 保持对话历史，支持多轮交互
   → 需要会话管理和内存清理

5. 流式输出:
   → 长任务的进度汇报
   → 需要扩展 CallToolResult 格式
```

### Q: 从 197 行代码学到了什么设计原则？

```
设计原则                              体现
──────                               ──────
最小暴露面                            只声明 tools 能力
防御性编程                            outputSchema 过滤、isError 标记
无状态设计                            每次调用独立上下文
资源限制                              LRU 缓存防 OOM
渐进式增强                            TODO 注释标记未来扩展点
复用优先                              直接复用 getTools()、findToolByName()
错误不泄露                            getErrorParts() 提取安全信息
```

---

## 小结

| 概念 | 一句话解释 |
|------|-----------|
| MCP Server 模式 | Claude Code 暴露内置工具供外部系统调用 |
| `claude/tengu` | Server 标识名（Tengu 天狗是项目代号） |
| StdioServerTransport | 通过 stdin/stdout 通信 |
| ListToolsRequestSchema | 暴露工具列表（Zod → JSON Schema 转换） |
| CallToolRequestSchema | 执行工具调用（独立上下文、无状态） |
| outputSchema 过滤 | 跳过 anyOf/oneOf 根级 schema |
| MCP_COMMANDS | 只暴露 review 命令 |
| mcpClients = [] | 不连接其他 MCP Server（防递归） |
| isNonInteractiveSession | 非交互模式，不弹确认对话框 |
| 197 行 | 整个 Server 实现的代码量 |
