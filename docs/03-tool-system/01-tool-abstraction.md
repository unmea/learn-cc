# Q: 如何设计一个可扩展的工具接口？

> 本文深入分析 Claude Code 工具系统的核心抽象——`Tool` 类型与 `buildTool` 工厂。

---

## 1. 核心问题

Claude Code 拥有 40+ 内置工具和无限量的 MCP 工具。如何设计一个接口，使得：

1. 每个工具定义足够简洁（不需要写一堆样板代码）
2. 类型系统足够严格（输入/输出完全类型安全）
3. 扩展足够灵活（MCP 工具、feature-gated 工具都能统一接入）
4. 运行时行为可查询（是否只读？能否并发？需要什么权限？）

答案是：**泛型接口 + 工厂函数 + 组合优于继承**。

---

## 2. `Tool<Input, Output, P>` — 三个泛型参数

```typescript
// src/Tool.ts:L362-L366
export type Tool<
  Input extends AnyObject = AnyObject,    // Zod schema 类型
  Output = unknown,                        // call() 返回数据类型
  P extends ToolProgressData = ToolProgressData, // 进度事件类型
> = {
  // ... 30+ 个属性和方法
}
```

### 为什么需要三个类型参数？

| 参数 | 作用 | 示例 |
|------|------|------|
| `Input` | 约束 `inputSchema` 的 Zod 类型，自动推导 `call(args)` 的参数类型 | GrepTool: `{pattern: string, path?: string, glob?: string}` |
| `Output` | `call()` 返回值中 `data` 的类型，贯穿 `mapToolResultToToolResultBlockParam` 和所有 render 方法 | FileReadTool: `{content: string}` |
| `P` | 进度事件的类型，约束 `onProgress` 回调和 `renderToolUseProgressMessage` | BashTool: `BashProgress` (包含 stdout 增量输出) |

**设计关键**: `Input extends AnyObject` 中 `AnyObject = z.ZodType<{ [key: string]: unknown }>`，确保输入始终是对象类型（而非原始类型），因为 API 的 tool_use block 的 input 字段必须是 JSON 对象。

---

## 3. 核心属性逐一解析

### 3.1 身份标识

```typescript
// src/Tool.ts:L456
readonly name: string           // 工具唯一名称，如 "Bash", "Read", "Edit"

// src/Tool.ts:L369-L372
aliases?: string[]              // 向后兼容的别名
// 示例: TaskStopTool 可能有 alias "KillShell"

// src/Tool.ts:L375-L378
searchHint?: string             // ToolSearch 关键词匹配用
// 示例: NotebookEditTool 的 searchHint 是 'jupyter'
```

**别名机制**: 当模型使用旧名称调用工具时（如从旧 transcript 恢复），系统通过 `toolMatchesName()` 进行匹配：

```typescript
// src/Tool.ts:L348-L353
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}
```

### 3.2 输入定义 — Zod Schema

```typescript
// src/Tool.ts:L394
readonly inputSchema: Input           // Zod schema 实例

// src/Tool.ts:L396-L397
readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具的 JSON Schema
```

**双重 schema 设计**: 内置工具用 Zod（类型推导 + 运行时验证一体），MCP 工具用 JSON Schema（因为 MCP 协议本身传的就是 JSON Schema）。Zod schema 在运行时执行 `safeParse`：

```typescript
// src/services/tools/toolExecution.ts:L615
const parsedInput = tool.inputSchema.safeParse(input)
if (!parsedInput.success) {
  // 返回格式化的 Zod 错误给模型
  let errorContent = formatZodValidationError(tool.name, parsedInput.error)
}
```

### 3.3 核心方法 — call()

```typescript
// src/Tool.ts:L379-L385
call(
  args: z.infer<Input>,              // Zod 类型自动推导
  context: ToolUseContext,             // 运行时上下文（详见第 5 节）
  canUseTool: CanUseToolFn,            // 权限检查回调（用于嵌套工具调用）
  parentMessage: AssistantMessage,     // 触发此工具调用的助手消息
  onProgress?: ToolCallProgress<P>,    // 进度回调
): Promise<ToolResult<Output>>
```

`call()` 是工具的核心执行方法。注意几个设计选择：

1. **返回 `Promise<ToolResult<Output>>`** 而非裸 Output — 因为工具可能产生副消息（`newMessages`）或上下文修改（`contextModifier`）
2. **传入 `canUseTool`** — 使嵌套工具调用成为可能（AgentTool 内部调用其他工具时需要权限检查）
3. **进度回调是可选的** — 不是所有工具都需要实时进度（如 GrepTool 就不需要）

### 3.4 描述方法 — description()

```typescript
// src/Tool.ts:L386-L393
description(
  input: z.infer<Input>,
  options: {
    isNonInteractiveSession: boolean
    toolPermissionContext: ToolPermissionContext
    tools: Tools
  },
): Promise<string>
```

**为什么 description 是方法而不是静态字符串？** 因为工具描述可能依赖上下文：
- BashTool 的描述在非交互模式下不包含"等待用户确认"的说明
- 权限模式影响描述中关于安全操作的措辞
- 工具池变化影响描述中对其他工具的交叉引用

### 3.5 行为查询方法

```typescript
// src/Tool.ts:L402
isConcurrencySafe(input: z.infer<Input>): boolean
// 是否可以与其他工具并发执行？
// 注意：取决于 input！ BashTool 只有在 isReadOnly 时才 concurrency-safe

// src/Tool.ts:L403
isEnabled(): boolean
// 工具当前是否可用？用于运行时动态过滤

// src/Tool.ts:L404
isReadOnly(input: z.infer<Input>): boolean
// 是否只读操作？用于权限快速路径

// src/Tool.ts:L406
isDestructive?(input: z.infer<Input>): boolean
// 是否不可逆操作？如删除文件、发送消息
```

**关键设计**: `isConcurrencySafe` 和 `isReadOnly` 都接收 input 参数。这意味着**同一个工具在不同输入下可以有不同的并发策略**：

```typescript
// src/tools/BashTool/BashTool.tsx:L434-L438
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;  // 只有只读命令才能并发
},
isReadOnly(input) {
  // 分析 shell 命令，判断 grep/cat/ls 等只读 vs rm/mv/echo> 等写入
}
```

### 3.6 权限方法 — checkPermissions()

```typescript
// src/Tool.ts:L500-L503
checkPermissions(
  input: z.infer<Input>,
  context: ToolUseContext,
): Promise<PermissionResult>
```

返回三种可能的行为：
- `{ behavior: 'allow', updatedInput }` — 允许执行（可能修改了输入）
- `{ behavior: 'deny', message }` — 拒绝执行
- `{ behavior: 'ask', ... }` — 需要询问用户

**分层权限设计**: `checkPermissions` 是工具级的权限检查（如 BashTool 检查命令是否在白名单中），而通用权限逻辑（deny rules、allow rules、hooks）在更上层的 `toolExecution.ts` 中处理。

### 3.7 渲染方法矩阵

Tool 接口定义了一组完整的 UI 渲染方法：

| 方法 | 用途 | 可选性 |
|------|------|--------|
| `renderToolUseMessage` | 渲染工具调用（输入） | **必须** |
| `renderToolResultMessage` | 渲染工具结果（输出） | 可选 |
| `renderToolUseProgressMessage` | 渲染执行进度 | 可选 |
| `renderToolUseRejectedMessage` | 渲染权限被拒 | 可选（有默认 fallback） |
| `renderToolUseErrorMessage` | 渲染执行错误 | 可选（有默认 fallback） |
| `renderToolUseQueuedMessage` | 渲染排队等待 | 可选 |
| `renderGroupedToolUse` | 渲染并发工具组 | 可选 |
| `renderToolUseTag` | 渲染工具标签（如超时信息） | 可选 |
| `userFacingName` | 用户可见的工具名 | 有默认值 |
| `getToolUseSummary` | 紧凑视图摘要 | 可选 |
| `getActivityDescription` | Spinner 活动描述 | 可选 |

**设计思路**: 渲染完全由工具自己控制，而非集中式模板。这使得每个工具可以有完全不同的 UI 表现：BashTool 显示终端输出，FileEditTool 显示 diff，GrepTool 显示搜索结果高亮。

### 3.8 其他重要属性

```typescript
// src/Tool.ts:L466
maxResultSizeChars: number
// 结果超过此大小时，持久化到磁盘，给模型发预览 + 文件路径
// FileReadTool 设为 Infinity（防止循环：Read→file→Read）

// src/Tool.ts:L442
readonly shouldDefer?: boolean
// ToolSearch 延迟加载标记

// src/Tool.ts:L472
readonly strict?: boolean
// 是否启用 API 的 strict 模式

// src/Tool.ts:L436
isMcp?: boolean
// 是否为 MCP 工具

// src/Tool.ts:L480-L481
backfillObservableInput?(input: Record<string, unknown>): void
// 在 hooks/canUseTool 看到输入前回填派生字段
```

---

## 4. ToolResult — 不仅仅是数据

```typescript
// src/Tool.ts:L321-L336
export type ToolResult<T> = {
  data: T                          // 工具输出数据
  newMessages?: (                  // 附加消息（如 AgentTool 的子代理消息）
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  // 上下文修改器：工具执行后修改后续工具的运行环境
  // 注意：仅对非并发安全的工具有效！
  mcpMeta?: {                      // MCP 协议元数据透传
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

`contextModifier` 的典型用途：BashTool 执行 `cd /new/dir` 后修改工作目录，使后续工具在新目录下执行。

**约束**: `contextModifier` 仅在串行执行的工具上生效。并发工具的 context modifier 在批次结束后按顺序应用（见 `toolOrchestration.ts:L54-L63`），避免并发修改冲突。

---

## 5. ToolUseContext — 工具的运行时世界

```typescript
// src/Tool.ts:L158-L300
export type ToolUseContext = {
  options: {
    commands: Command[]              // 可用命令列表
    debug: boolean                   // 调试模式
    mainLoopModel: string            // 当前模型
    tools: Tools                     // 可用工具列表
    verbose: boolean                 // 详细输出
    thinkingConfig: ThinkingConfig   // 思考配置
    mcpClients: MCPServerConnection[] // MCP 客户端连接
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean // 非交互模式
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number            // 预算限制
    refreshTools?: () => Tools       // 动态刷新工具列表
  }
  abortController: AbortController   // 中断信号
  readFileState: FileStateCache      // 文件读取缓存
  getAppState(): AppState            // 获取全局状态
  setAppState(f: (prev: AppState) => AppState): void
  setToolJSX?: SetToolJSXFn          // 设置工具渲染内容
  messages: Message[]                // 当前对话消息列表
  setInProgressToolUseIDs: ...       // 标记正在执行的工具
  updateFileHistoryState: ...        // 文件历史状态
  updateAttributionState: ...        // 归因状态
  agentId?: AgentId                  // 子代理标识
  contentReplacementState?: ...      // 工具结果预算管理
  // ... 更多字段
}
```

ToolUseContext 是一个**巨大的上下文包**，包含了工具执行需要的一切：全局状态、中断控制、消息历史、UI 回调等。这种"传递上下文对象"的模式在整个代码库中一致使用。

---

## 6. ToolPermissionContext — 权限世界

```typescript
// src/Tool.ts:L123-L138
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode                // 'default' | 'auto' | 'plan'
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean  // 后台代理
  prePlanMode?: PermissionMode       // plan 模式之前的模式
}>
```

注意 `DeepImmutable` 包装——权限上下文是完全只读的，防止工具意外修改权限规则。

---

## 7. buildTool() 工厂 — 为什么不用抽象类？

```typescript
// src/Tool.ts:L783-L792
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,           // 先铺默认值
    userFacingName: () => def.name,  // 默认用工具名
    ...def,                     // 再铺用户定义（覆盖默认）
  } as BuiltTool<D>
}
```

### 默认值策略

```typescript
// src/Tool.ts:L757-L769
const TOOL_DEFAULTS = {
  isEnabled: () => true,                               // 默认启用
  isConcurrencySafe: (_input?: unknown) => false,      // 默认不安全（保守）
  isReadOnly: (_input?: unknown) => false,             // 默认非只读（保守）
  isDestructive: (_input?: unknown) => false,          // 默认非破坏性
  checkPermissions: (input, _ctx?) =>                  // 默认允许
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',     // 默认跳过分类器
  userFacingName: (_input?: unknown) => '',            // 默认空
}
```

**Fail-closed 设计**: 默认值在安全敏感的方向上是保守的：
- `isConcurrencySafe` 默认 `false` — 如果忘了实现，工具不会被意外并发
- `isReadOnly` 默认 `false` — 如果忘了实现，工具不会被自动允许
- 而 `isEnabled` 默认 `true` — 这是合理的，因为注册的工具通常应该可用

### 为什么用工厂函数而不用抽象类？

| 维度 | 工厂函数 `buildTool()` | 抽象类 `class BaseTool` |
|------|----------------------|----------------------|
| 定义方式 | 对象字面量 + 类型推导 | 类继承 + 方法覆盖 |
| 类型安全 | `BuiltTool<D>` 精确保留字面量类型 | 继承链中类型容易丢失 |
| 默认值 | 对象展开，简单直接 | 需要 `super()` 调用链 |
| 组合性 | 可以随意混入任何属性 | 受限于单继承 |
| 可测试性 | 普通对象，易于 mock | 需要实例化类 |
| MCP 兼容 | MCP 工具也是对象，统一处理 | MCP 工具需要适配器 |

**实际收益**: 代码库中 60+ 个工具定义零类型错误，因为 `BuiltTool<D>` 类型精确地模拟了 `{ ...TOOL_DEFAULTS, ...def }` 的运行时行为。

### ToolDef — buildTool 的输入类型

```typescript
// src/Tool.ts:L721-L726
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>
```

`ToolDef` 就是 `Tool` 去掉可默认字段后再把它们变成可选的。这样 `buildTool` 的调用方只需要提供必须的字段。

### DefaultableToolKeys — 哪些方法可以省略

```typescript
// src/Tool.ts:L707-L715
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'
```

---

## 8. 设计分析：组合优于继承

### 典型的工具定义（GrepTool 为例）

```typescript
// src/tools/GrepTool/GrepTool.ts（简化）
export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  inputSchema: lazySchema(() => z.strictObject({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
  })),

  isConcurrencySafe() { return true },     // Grep 始终可以并发
  isReadOnly() { return true },             // Grep 只读

  async call(args, context) {
    // 调用 ripgrep...
  },

  async description() { return getDescription() },
  async prompt() { return getPromptContent() },
  async checkPermissions(input, context) {
    return checkReadPermissionForTool(...)
  },

  renderToolUseMessage(...) { ... },
  renderToolResultMessage(...) { ... },
  mapToolResultToToolResultBlockParam(...) { ... },
  maxResultSizeChars: 120_000,
})
```

### 模式总结

```
┌──────────────────────────────────────────────────────┐
│                   Tool 接口（~30 个方法/属性）          │
│                                                       │
│  身份: name, aliases, searchHint                       │
│  输入: inputSchema, inputJSONSchema, validateInput     │
│  执行: call()                                          │
│  行为: isReadOnly, isConcurrencySafe, isDestructive   │
│  权限: checkPermissions, preparePermissionMatcher      │
│  渲染: renderToolUse/Result/Progress/Error/Rejected    │
│  序列化: mapToolResultToToolResultBlockParam            │
│  元信息: maxResultSizeChars, strict, shouldDefer       │
└──────────────────────────────────────────────────────┘
                         ▲
                         │ buildTool() 填充默认值
                         │
┌──────────────────────────────────────────────────────┐
│                    ToolDef（部分可选）                   │
│  省略 7 个 DefaultableToolKeys                          │
│  GrepTool / BashTool / FileEditTool / MCPTool...       │
└──────────────────────────────────────────────────────┘
```

---

## 9. 重要辅助类型

### Tools — 工具集合

```typescript
// src/Tool.ts:L701
export type Tools = readonly Tool[]
```

使用 `readonly` 防止工具列表被意外修改。这个类型在整个代码库中用于传递工具集合。

### ValidationResult

```typescript
// src/Tool.ts:L95-L101
export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }
```

`validateInput()` 返回此类型。比简单的 boolean 多了错误信息和错误码，给模型更有用的反馈。

### ToolProgress

```typescript
// src/Tool.ts:L307-L310
export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string  // 关联到具体的 tool_use block
  data: P            // 进度数据
}
```

---

## 10. 关键总结

| 设计决策 | 选择 | 原因 |
|----------|------|------|
| 接口 vs 类 | 接口（TS type） | 组合灵活，MCP 工具统一处理 |
| 默认值策略 | fail-closed（保守） | 安全第一：忘实现的方法不会导致权限漏洞 |
| 输入验证 | Zod schema | 类型推导 + 运行时验证一体 |
| 渲染策略 | 每个工具自定义 | UI 差异大，集中模板不现实 |
| 泛型参数 | 3 个（Input, Output, Progress） | 端到端类型安全，从 API 到 UI |
| 工厂模式 | `buildTool()` 对象展开 | 简洁定义，精确类型推导 |

这套设计使得新增工具只需要编写一个对象字面量调用 `buildTool()`，大部分样板代码（默认值、类型推导、接口一致性）由框架自动处理。
