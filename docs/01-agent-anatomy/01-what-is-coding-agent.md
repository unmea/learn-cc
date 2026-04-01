# Q: AI 编码代理到底是什么？与普通聊天机器人有何本质区别？

> **一句话回答**：编码代理是一个在循环中使用工具的 LLM —— 它不断感知环境、思考策略、执行动作、观察结果，直到任务完成；而聊天机器人只是无状态的一问一答。

---

## 为什么这个问题重要

理解"代理"与"聊天机器人"的本质区别，是理解整个 Claude Code 架构的第一步。这不仅是概念问题——它决定了系统的核心数据结构（消息循环 vs 单次请求）、状态管理策略（持久化 vs 无状态）、安全模型（权限管理 vs 无约束输出），以及用户交互模式（协作式 vs 问答式）。

如果你把 Claude Code 当作"一个能写代码的 ChatGPT"，你会误解它 90% 的设计决策。

---

## 深度解答

### 子问题 1：什么是 Agent？形式化定义

Agent（代理）在 AI 领域有一个经典定义：

```
Agent = LLM + Tools + Loop + State + Policy
```

拆解这个公式：

| 组件 | 含义 | Claude Code 中的映射 |
|------|------|---------------------|
| **LLM** | 大语言模型，负责推理和决策 | Anthropic Claude API（通过 `callModel` 调用） |
| **Tools** | 模型可以调用的外部能力 | `src/Tool.ts` 定义的 40+ 工具（Bash, Edit, Read...） |
| **Loop** | 感知-思考-行动的迭代循环 | `src/query.ts` 中的 `queryLoop` AsyncGenerator |
| **State** | 跨轮次持久化的上下文 | `State` 类型 + `ToolUseContext` + `AppState` |
| **Policy** | 约束行为的规则/权限 | 权限系统 (`ToolPermissionContext`) |

关键区别在于 **Loop**。聊天机器人是"请求-响应"模式：

```
用户 → LLM → 回复     （结束）
```

而 Agent 是"循环执行"模式：

```
用户 → LLM → 工具调用 → 观察结果 → LLM → 工具调用 → ... → 最终回复
```

### 子问题 2：Claude Code 的核心循环是什么样的？

Claude Code 的心脏在 `src/query.ts`。让我们看核心循环的骨架：

```typescript
// src/query.ts:241-251
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
```

这个函数是一个 AsyncGenerator。它的循环结构是：

```
while (true) {
  1. 准备消息（compact、microcompact、context collapse）
  2. 调用模型 API（streaming）
  3. 处理流式响应
  4. 如果有 tool_use → 执行工具 → 继续循环
  5. 如果没有 tool_use → 检查停止条件 → 返回
}
```

映射到经典的 Agent 循环模型：

```
┌─────────────────────────────────────────────────────┐
│                   Agent Loop                         │
│                                                      │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│   │ Perceive │───▶│  Think   │───▶│   Act    │      │
│   │ (消息准备)│    │ (LLM推理)│    │ (工具执行)│      │
│   └──────────┘    └──────────┘    └──────────┘      │
│        ▲                               │             │
│        │          ┌──────────┐         │             │
│        └──────────│ Observe  │◀────────┘             │
│                   │ (结果收集)│                       │
│                   └──────────┘                       │
└─────────────────────────────────────────────────────┘
```

在 Claude Code 源码中，这四个阶段对应的代码位置：

| 阶段 | 对应代码 | 行号范围 |
|------|---------|---------|
| **Perceive** | autocompact、microcompact、context collapse | `query.ts:365-548` |
| **Think** | `deps.callModel(...)` streaming loop | `query.ts:659-863` |
| **Act** | `runTools()` 或 `streamingToolExecutor` | `query.ts:1363-1408` |
| **Observe** | 收集 toolResults、attachments、memory | `query.ts:1536-1658` |

### 子问题 3：是什么让 Claude Code 成为真正的 Agent？

四个关键能力将 Agent 与聊天机器人区分开：

#### 能力 1：工具执行（Tool Execution）

Claude Code 定义了一个精心设计的 Tool 接口：

```typescript
// src/Tool.ts:362-503（简化）
export type Tool<Input, Output, P> = {
  name: string
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  inputSchema: Input
  checkPermissions(input, context): Promise<PermissionResult>
  isEnabled(): boolean
  isReadOnly(input): boolean
  isConcurrencySafe(input): boolean
  isDestructive?(input): boolean
  validateInput?(input, context): Promise<ValidationResult>
  prompt(options): string
  // ...
}
```

注意这不是简单的"函数调用"。每个工具有：

- **权限检查** (`checkPermissions`)：在执行前判断是否允许
- **输入验证** (`validateInput`)：确保参数合法
- **并发安全声明** (`isConcurrencySafe`)：支持并行执行
- **只读/破坏性标记** (`isReadOnly`, `isDestructive`)：影响权限决策
- **进度报告** (`onProgress`)：支持流式反馈

这是一个完整的工具治理框架，而非简单的函数注册。

#### 能力 2：状态持久化（State Persistence）

状态管理分三层：

**第一层：循环状态（Loop State）**

```typescript
// src/query.ts:204-217
type State = {
  messages: Message[]                           // 完整对话历史
  toolUseContext: ToolUseContext                 // 工具执行上下文
  autoCompactTracking: AutoCompactTrackingState // 自动压缩追踪
  maxOutputTokensRecoveryCount: number          // 输出超限恢复计数
  hasAttemptedReactiveCompact: boolean          // 是否尝试过响应式压缩
  maxOutputTokensOverride: number | undefined   // 输出 token 上限覆写
  pendingToolUseSummary: Promise<...> | undefined // 待处理的工具摘要
  stopHookActive: boolean | undefined           // 停止钩子是否激活
  turnCount: number                             // 当前轮次计数
  transition: Continue | undefined              // 上一次迭代的继续原因
}
```

这个 `State` 类型记录了循环的所有运行时状态。注意 `transition` 字段——它记录了*为什么*循环继续，这在调试时极其有用。

**第二层：应用状态（App State）**

```typescript
// src/state/store.ts — 极简 Store 实现
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // 引用相等性检查
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => { /* ... */ },
  }
}
```

这是一个自定义的、React 无关的状态管理器。35 行代码，却驱动了整个应用的状态。设计哲学：不用 Redux 也不用 Zustand，而是一个满足需求的最小实现。

**第三层：工具使用上下文（ToolUseContext）**

```typescript
// src/Tool.ts:158-300（简化）
export type ToolUseContext = {
  options: {
    commands: Command[]
    tools: Tools
    mainLoopModel: string
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    // ...
  }
  abortController: AbortController        // 取消控制
  readFileState: FileStateCache            // 文件读取缓存
  getAppState(): AppState                  // 获取应用状态
  setAppState(f: (prev) => AppState): void // 修改应用状态
  messages: Message[]                      // 当前消息快照
  agentId?: AgentId                        // 子代理标识
  contentReplacementState?: ContentReplacementState // 内容替换状态
  // ... 40+ 字段
}
```

`ToolUseContext` 是传递给每个工具的"世界视图"——它包含了工具执行所需的一切信息。

#### 能力 3：权限管理（Permission Management）

聊天机器人不需要权限——它的输出只是文字。但 Agent 可以**修改文件、执行命令、访问网络**，所以权限是必需的。

```typescript
// src/Tool.ts:123-138
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode                    // 'default' | 'plan' | 'auto' | ...
  additionalWorkingDirectories: Map<...>  // 额外工作目录
  alwaysAllowRules: ToolPermissionRulesBySource   // 始终允许规则
  alwaysDenyRules: ToolPermissionRulesBySource     // 始终拒绝规则
  alwaysAskRules: ToolPermissionRulesBySource      // 始终询问规则
  isBypassPermissionsModeAvailable: boolean        // 是否可跳过权限
  shouldAvoidPermissionPrompts?: boolean           // 后台代理自动拒绝
}>
```

`DeepImmutable<>` 包装确保权限上下文不会被意外修改——这是安全设计的体现。

#### 能力 4：多轮推理（Multi-turn Reasoning）

最关键的 Agent 能力是**在多个工具调用之间保持推理连贯性**。看循环中的 continue 判断：

```typescript
// src/query.ts:1062
if (!needsFollowUp) {
  // 没有工具调用 → 检查各种终止/恢复条件
  // ...
  return { reason: 'completed' }
}

// 有工具调用 → 执行工具 → 收集结果
// ...

// src/query.ts:1715-1727
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  // ...
  transition: { reason: 'next_turn' },
}
state = next
// while (true) 继续下一轮
```

每次工具执行后，模型都能看到**完整的历史**（包括之前的工具调用和结果），并在此基础上决定下一步。这就是"推理链"。

### 子问题 4：对比 Agent 和 Chatbot 架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Chatbot 架构                               │
│                                                               │
│  User ──▶ [Format Prompt] ──▶ [LLM API] ──▶ [Parse] ──▶ User │
│                                                               │
│  特点：                                                       │
│  • 单次请求-响应                                               │
│  • 无副作用（不修改外部环境）                                     │
│  • 无状态（每次请求独立）                                        │
│  • 无权限需求                                                  │
│  • 输出 = 文本                                                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                    Agent 架构 (Claude Code)                    │
│                                                               │
│  User ──▶ [REPL] ──▶ [query()] ──▶ [queryLoop] ─┐           │
│                                                    │           │
│            ┌──── while (true) ─────────────────────┤           │
│            │                                       │           │
│            │  [Compact/Prepare] ──▶ [LLM API]      │           │
│            │                         │              │           │
│            │              ┌──────────┘              │           │
│            │              ▼                         │           │
│            │  tool_use? ──YES──▶ [Permission Check] │           │
│            │     │               [Execute Tools]    │           │
│            │     │               [Collect Results]  │           │
│            │     │               ──▶ continue       │           │
│            │     │                                  │           │
│            │     NO──▶ [Stop Hooks]                 │           │
│            │           [Budget Check]               │           │
│            │           ──▶ return Terminal           │           │
│            └────────────────────────────────────────┘           │
│                                                               │
│  特点：                                                       │
│  • 循环执行，轮次 (turn) 是核心概念                               │
│  • 有副作用（修改文件、运行命令）                                   │
│  • 有状态（State 跨轮次持久化）                                   │
│  • 精细的权限管理                                               │
│  • 输出 = 文本 + 文件变更 + 命令执行结果                          │
└──────────────────────────────────────────────────────────────┘
```

---

## 源码对照

### 入口：从用户输入到 Agent 循环

用户输入一条消息后，经过 REPL 处理，最终进入核心循环：

```
用户输入 "请帮我读取 main.ts 的内容"
    │
    ▼
REPL.tsx (UI 层)
    │ 构建 messages、systemPrompt
    ▼
query() 函数  ← src/query.ts:219-239
    │
    ▼
queryLoop() AsyncGenerator  ← src/query.ts:241
```

### query() 的封装层

```typescript
// src/query.ts:219-239
export async function* query(params: QueryParams): AsyncGenerator<...> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 循环正常结束后，通知已消费的命令
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

`query()` 是对 `queryLoop()` 的薄封装。`yield*` 将内部 generator 的所有值转发给外部消费者。`consumedCommandUuids` 追踪循环中消费的队列命令，确保在正常退出时发送完成通知。

### QueryParams：循环的输入

```typescript
// src/query.ts:181-199
export type QueryParams = {
  messages: Message[]              // 初始消息列表
  systemPrompt: SystemPrompt       // 系统提示
  userContext: { [k: string]: string }    // 用户上下文
  systemContext: { [k: string]: string }  // 系统上下文
  canUseTool: CanUseToolFn         // 工具权限检查函数
  toolUseContext: ToolUseContext    // 工具上下文
  fallbackModel?: string           // 备用模型
  querySource: QuerySource         // 查询来源标识
  maxOutputTokensOverride?: number // 输出 token 覆写
  maxTurns?: number                // 最大轮次限制
  skipCacheWrite?: boolean         // 跳过缓存写入
  taskBudget?: { total: number }   // API 任务预算
  deps?: QueryDeps                 // 可注入的依赖（测试用）
}
```

注意 `deps?: QueryDeps` —— 这是依赖注入接口，允许测试替换 `callModel`、`uuid` 等函数。

### 工具执行的并发优化

Claude Code 支持两种工具执行模式：

```typescript
// src/query.ts:561-568
const useStreamingToolExecution = config.gates.streamingToolExecution
let streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  : null
```

- **传统模式**：等 API 响应完成后，批量执行所有工具
- **流式模式**（`StreamingToolExecutor`）：API 流式返回 tool_use block 时立即开始执行，与后续 block 的接收并行

这是一个重要的性能优化：模型可能同时请求多个工具调用（如同时读取 3 个文件），流式执行让这些工具在 API 仍在返回后续 block 时就开始运行。

### 工具结果的丰富类型

```typescript
// src/Tool.ts:321-336
export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

工具不仅返回数据，还可以：
- 注入新消息到对话流
- 修改后续工具的执行上下文（`contextModifier`）
- 携带 MCP 元数据

---

## 设计动机分析

### 为什么选择 Agent 而非增强型 Chatbot？

编码是一个**多步骤、有状态、需要环境交互**的任务。考虑一个典型场景："修复这个 bug"。

聊天机器人能做的：
1. 阅读用户粘贴的代码
2. 生成修复建议
3. 输出修改后的代码（用户自行复制粘贴）

Agent 能做的：
1. 搜索代码库找到相关文件（Grep/Glob 工具）
2. 阅读相关文件理解上下文（Read 工具）
3. 分析 bug 原因（LLM 推理）
4. 编辑文件修复 bug（Edit 工具）
5. 运行测试验证修复（Bash 工具）
6. 如果测试失败，分析错误并重新修复（循环）
7. 所有测试通过，汇报结果

步骤 1-7 可能涉及 10+ 轮工具调用，这就是为什么需要循环。

### 设计权衡

Agent 范式引入了几个重要的工程挑战：

| 挑战 | Claude Code 的应对 |
|------|-------------------|
| **安全性**：工具能修改文件系统 | 多层权限系统（default/plan/auto 模式） |
| **资源消耗**：循环可能无限运行 | `maxTurns` 限制 + `maxBudgetUsd` 预算 + token budget |
| **上下文膨胀**：消息列表不断增长 | autocompact + microcompact + reactive compact + context collapse |
| **错误恢复**：工具或 API 可能失败 | 6+ 种 continue 条件 + fallback model |
| **用户控制**：需要能中断长时间操作 | `AbortController` + interrupt 机制 |

每一个挑战都对应着 `query.ts` 中的大量代码。这就是为什么一个"简单的循环"有 1700+ 行——大部分代码在处理边界情况和恢复策略。

### 最小可行 Agent vs Claude Code

如果你从零实现一个最小 Agent：

```python
# 最小可行 Agent（伪代码）
messages = [user_message]
while True:
    response = llm.call(messages)
    if response.has_tool_calls:
        results = execute_tools(response.tool_calls)
        messages.append(response)
        messages.append(results)
    else:
        return response.text
```

这大约 10 行。Claude Code 的 `queryLoop` 有 ~1500 行。额外的代码量来自：

- **上下文管理**（~300 行）：autocompact, microcompact, snip, context collapse
- **错误恢复**（~200 行）：prompt-too-long, max-output-tokens, media errors
- **流式处理**（~200 行）：streaming tool execution, fallback handling
- **权限/安全**（~100 行）：stop hooks, permission checks
- **遥测/分析**（~100 行）：logEvent, queryCheckpoint
- **任务管理**（~100 行）：notifications, commands queue, memory prefetch
- **预算控制**（~80 行）：token budget, task budget

---

## 启发与超越

### 启发 1：Agent 是一种架构模式，而非产品特性

Claude Code 告诉我们，"代理"不是在聊天机器人上加一个"工具调用"功能就完成了。它需要重新思考整个系统架构：状态如何流动、错误如何恢复、资源如何控制、安全如何保障。

### 启发 2：循环的复杂性在于"边界"

`queryLoop` 的核心循环只有 5 步（准备→调用→流式→工具→继续），但 80% 的代码在处理边界情况。这是所有工程系统的通性：正常路径简单，边界处理复杂。

### 启发 3：Agent 的 "自主性" 需要精心约束

Claude Code 的权限系统（5 种模式、3 层规则、工具级粒度）说明了一个关键设计原则：自主性越强，约束机制越要精细。`DeepImmutable<ToolPermissionContext>` 这种类型级保护不是过度工程——它是防止安全漏洞的必要手段。

### 启发 4：可观察性是 Agent 的生命线

`query.ts` 中大量的 `queryCheckpoint`、`logEvent`、`transition` 记录，看起来像"非功能代码"，但对 Agent 系统至关重要。当一个 Agent 循环运行了 50 轮但没有产出时，你需要知道*为什么*每一次循环都继续了。`transition` 字段正是为此设计：

```typescript
transition: Continue | undefined  // 上一次迭代为什么继续
```

---

## 延伸阅读

- **循环详解**：`learn/01-agent-anatomy/03-main-loop-design.md` — AsyncGenerator 实现的深度分析
- **启动流程**：`learn/01-agent-anatomy/02-bootstrap-and-lifecycle.md` — 从进程启动到循环就绪
- **工具系统**：`learn/03-tool-system/` — 工具注册、执行、权限的完整分析
- **上下文管理**：`learn/06-context-engineering/` — autocompact、microcompact 等策略
- **源码文件**：
  - `src/query.ts` — 核心循环（1730 行）
  - `src/Tool.ts` — 工具接口定义
  - `src/state/store.ts` — 状态管理（35 行极简实现）
  - `src/state/AppStateStore.ts` — 应用状态定义
