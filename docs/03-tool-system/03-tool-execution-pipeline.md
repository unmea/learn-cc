# Q: 从 API 返回 tool_use 到结果回传，中间经历了什么？

> 本文追踪一次完整的工具执行管线，从 API 响应中的 `tool_use` block 到 `tool_result` 回传。

---

## 1. 管线全景

```
API 响应 (stream)
  │
  ▼
┌─ query.ts ─────────────────────────────────────────────┐
│ 1. 流式接收 assistant message                           │
│ 2. 提取 tool_use blocks                                │
│ 3. (可选) streaming tool executor 提前执行               │
│ 4. 流式结束后收集所有 toolUseBlocks                      │
│ 5. 调用 runTools()                                      │
└────────────────────────────────┬────────────────────────┘
                                 │
                                 ▼
┌─ toolOrchestration.ts ─────────────────────────────────┐
│ 6. partitionToolCalls() — 分批                          │
│ 7. 并发批次 → runToolsConcurrently()                    │
│    串行批次 → runToolsSerially()                        │
└────────────────────────────────┬────────────────────────┘
                                 │
                                 ▼
┌─ toolExecution.ts ─────────────────────────────────────┐
│ 8. runToolUse() — 单个工具执行入口                       │
│    a. 查找工具（含别名 fallback）                        │
│    b. 检查 abort 信号                                   │
│    c. streamedCheckPermissionsAndCallTool()             │
│       ├─ Zod 输入验证                                   │
│       ├─ validateInput() — 工具自定义验证                │
│       ├─ PreToolUse hooks                               │
│       ├─ 权限解析 (resolveHookPermissionDecision)       │
│       ├─ tool.call() — 实际执行                         │
│       ├─ PostToolUse hooks                              │
│       └─ mapToolResultToToolResultBlockParam()          │
│ 9. 生成 tool_result message                             │
└────────────────────────────────┬────────────────────────┘
                                 │
                                 ▼
┌─ query.ts ─────────────────────────────────────────────┐
│ 10. 收集 tool_result messages                           │
│ 11. 追加到 messagesForQuery                             │
│ 12. 递归调用 API（下一轮对话）                           │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 阶段一：API 响应接收与 tool_use 提取

### 2.1 流式接收

```typescript
// src/query.ts:L554-L557
// Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
// Set during streaming whenever a tool_use block arrives — the sole
// loop-exit signal. If false after streaming, we're done.
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false
```

在流式接收过程中，`query.ts` 逐步接收 assistant message 的 content blocks。当检测到 `tool_use` 类型的 block 时，将其收集起来。

### 2.2 Streaming Tool Executor（优化路径）

```typescript
// src/query.ts:L561-L568
const useStreamingToolExecution = config.gates.streamingToolExecution
let streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  : null
```

当启用 streaming tool execution 时，工具执行可以在 API 流式输出还在进行时就开始——不需要等待整个 assistant 响应完成。这是一个重要的延迟优化。

### 2.3 tool_use 的 backfill 处理

```typescript
// src/query.ts:L742-L765
// Backfill tool_use inputs on a cloned message before yield so
// SDK stream output and transcript serialization see legacy/derived fields.
// The original message is left untouched — mutating it would break prompt caching.
let yieldMessage: typeof message = message
if (message.type === 'assistant') {
  for (let i = 0; i < message.message.content.length; i++) {
    const block = message.message.content[i]!
    if (block.type === 'tool_use' && typeof block.input === 'object') {
      const tool = findToolByName(toolUseContext.options.tools, block.name)
      if (tool?.backfillObservableInput) {
        // Clone once, then backfill on the clone
        // 保留原始消息不变（prompt cache 需要字节一致）
      }
    }
  }
}
```

关键点：**原始消息绝不修改**，因为它会回传给 API，修改会破坏 prompt cache（字节不匹配）。

---

## 3. 阶段二：工具执行分发

### 3.1 进入 runTools

```typescript
// src/query.ts:L1380-L1382
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

如果使用了 streaming executor，此时获取剩余结果；否则走标准路径 `runTools()`。

### 3.2 runTools — 编排入口

```typescript
// src/services/tools/toolOrchestration.ts:L19-L82
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages, currentContext,
  )) {
    if (isConcurrencySafe) {
      // 并发执行批次
      for await (const update of runToolsConcurrently(blocks, ...)) {
        yield { message: update.message, newContext: currentContext }
      }
      // 批次结束后按序应用 context modifiers
      for (const block of blocks) {
        for (const modifier of queuedContextModifiers[block.id]) {
          currentContext = modifier(currentContext)
        }
      }
    } else {
      // 串行执行批次
      for await (const update of runToolsSerially(blocks, ...)) {
        if (update.newContext) currentContext = update.newContext
        yield { message: update.message, newContext: currentContext }
      }
    }
  }
}
```

**核心逻辑**: `runTools` 是一个 `AsyncGenerator`——它不是一次性返回所有结果，而是逐个 `yield` 消息更新，使 UI 能实时显示每个工具的执行进度。

### 3.3 分区策略 — partitionToolCalls

```typescript
// src/services/tools/toolOrchestration.ts:L91-L116
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            return false  // 保守处理：异常时当作不安全
          }
        })()
      : false

    // 连续的并发安全工具合并为一个批次
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

分区示例：
```
[Grep, Grep, Edit, Read, Read, Bash("rm")] 
→ [
    {concurrent: true,  blocks: [Grep, Grep]},   // 并发
    {concurrent: false, blocks: [Edit]},           // 串行
    {concurrent: true,  blocks: [Read, Read]},    // 并发
    {concurrent: false, blocks: [Bash("rm")]},     // 串行
  ]
```

---

## 4. 阶段三：单工具执行管线

### 4.1 runToolUse — 总入口

```typescript
// src/services/tools/toolExecution.ts:L337-L490
export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name

  // 步骤 1: 查找工具
  let tool = findToolByName(toolUseContext.options.tools, toolName)

  // 步骤 1b: 别名 fallback
  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolName)
    if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
      tool = fallbackTool  // 使用废弃名称调用也能成功
    }
  }

  // 步骤 2: 工具不存在 → 返回错误
  if (!tool) {
    yield { message: createUserMessage({
      content: [{
        type: 'tool_result',
        content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUse.id,
      }],
    }) }
    return
  }

  // 步骤 3: 检查 abort 信号
  if (toolUseContext.abortController.signal.aborted) {
    yield { message: /* 取消消息 */ }
    return
  }

  // 步骤 4: 进入核心执行流
  for await (const update of streamedCheckPermissionsAndCallTool(...)) {
    yield update
  }
}
```

### 4.2 Zod 输入验证

```typescript
// src/services/tools/toolExecution.ts:L614-L680
const parsedInput = tool.inputSchema.safeParse(input)
if (!parsedInput.success) {
  let errorContent = formatZodValidationError(tool.name, parsedInput.error)

  // 特殊处理：延迟加载的工具可能 schema 未发送
  const schemaHint = buildSchemaNotSentHint(tool, toolUseContext.messages, ...)
  if (schemaHint) {
    errorContent += schemaHint  // 提示模型先用 ToolSearch 加载 schema
  }

  return [{ message: createUserMessage({
    content: [{
      type: 'tool_result',
      content: `<tool_use_error>InputValidationError: ${errorContent}</tool_use_error>`,
      is_error: true,
      tool_use_id: toolUseID,
    }],
  }) }]
}
```

### 4.3 工具自定义验证

```typescript
// src/services/tools/toolExecution.ts:L682-L733
const isValidCall = await tool.validateInput?.(parsedInput.data, toolUseContext)
if (isValidCall?.result === false) {
  // 返回错误消息，包含工具提供的自定义错误信息
}
```

### 4.4 PreToolUse Hooks

```typescript
// src/services/tools/toolExecution.ts:L800-L862
for await (const result of runPreToolUseHooks(
  toolUseContext, tool, processedInput, toolUseID, ...
)) {
  switch (result.type) {
    case 'message':           // Hook 产生消息（如进度、附件）
    case 'hookPermissionResult':  // Hook 做出权限决定
    case 'hookUpdatedInput':      // Hook 修改了输入
    case 'preventContinuation':   // Hook 要求停止后续执行
    case 'stopReason':            // Hook 提供停止原因
    case 'additionalContext':     // Hook 添加额外上下文
    case 'stop':                  // Hook 要求立即终止
  }
}
```

Hooks 可以：
- 修改工具输入（如路径扩展）
- 做出权限决定（允许/拒绝）
- 阻止工具执行
- 添加额外上下文信息

### 4.5 Speculative Classifier（Bash 专属）

```typescript
// src/services/tools/toolExecution.ts:L740-L752
if (tool.name === BASH_TOOL_NAME && parsedInput.data && 'command' in parsedInput.data) {
  startSpeculativeClassifierCheck(
    (parsedInput.data as BashToolInput).command,
    appState.toolPermissionContext,
    toolUseContext.abortController.signal,
    toolUseContext.options.isNonInteractiveSession,
  )
}
```

对 Bash 命令，在权限检查之前就启动分类器——与 hooks 并行运行，减少总延迟。

### 4.6 权限解析

```typescript
// src/services/tools/toolExecution.ts:L921-L931
const resolved = await resolveHookPermissionDecision(
  hookPermissionResult,   // PreToolUse hook 的决定
  tool,
  processedInput,
  toolUseContext,
  canUseTool,             // 交互式权限检查
  assistantMessage,
  toolUseID,
)
const permissionDecision = resolved.decision
```

权限解析的优先级：
1. Hook 决定 > 工具级 checkPermissions > 通用权限规则
2. deny > ask > allow（安全优先）

### 4.7 实际执行 — tool.call()

```typescript
// src/services/tools/toolExecution.ts:L1206-L1222
const result = await tool.call(
  callInput,
  {
    ...toolUseContext,
    toolUseId: toolUseID,
    userModified: permissionDecision.userModified ?? false,
  },
  canUseTool,
  assistantMessage,
  progress => {
    onToolProgress({
      toolUseID: progress.toolUseID,
      data: progress.data,
    })
  },
)
```

注意 `callInput` vs `processedInput` 的区别：
- `processedInput`：经过 hooks 修改、backfill 后的输入（用于权限、遥测）
- `callInput`：传给 `tool.call()` 的输入——如果 hook 没有修改，使用原始 model 输入（保持 VCR fixture hash 稳定）

### 4.8 结果映射

```typescript
// src/services/tools/toolExecution.ts:L1292-L1295
const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
  result.data,
  toolUseID,
)
```

每个工具负责将自己的输出转换为 API 格式的 `ToolResultBlockParam`。

### 4.9 PostToolUse Hooks

```typescript
// src/services/tools/toolExecution.ts:L1483-L1531
for await (const hookResult of runPostToolUseHooks(
  toolUseContext, tool, toolUseID, ...,
  processedInput, toolOutput, ...
)) {
  if ('updatedMCPToolOutput' in hookResult) {
    if (isMcpTool(tool)) {
      toolOutput = hookResult.updatedMCPToolOutput  // MCP 工具输出可被 hook 修改
    }
  } else {
    resultingMessages.push(hookResult)  // Hook 产生的额外消息
  }
}
```

---

## 5. 阶段四：结果回传与循环

```typescript
// src/query.ts:L1384-L1408
for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message  // 向 UI 推送消息

    // 检查 hook 是否要求停止
    if (update.message.type === 'attachment' &&
        update.message.attachment.type === 'hook_stopped_continuation') {
      shouldPreventContinuation = true
    }

    // 收集 tool_result 用于下一轮 API 调用
    toolResults.push(
      ...normalizeMessagesForAPI([update.message], toolUseContext.options.tools)
        .filter(_ => _.type === 'user'),
    )
  }
  if (update.newContext) {
    updatedToolUseContext = { ...update.newContext, queryTracking }
  }
}
```

所有 tool_result 消息被收集后，追加到消息列表，然后 query.ts 的外层循环会发起下一轮 API 调用——形成 `用户消息 → API 响应 → 工具执行 → 工具结果 → API 响应 → ...` 的循环。

---

## 6. 实战追踪：FileEditTool 执行全过程

假设模型返回：
```json
{
  "type": "tool_use",
  "id": "toolu_01Abc",
  "name": "Edit",
  "input": {
    "file_path": "src/utils.ts",
    "old_string": "const x = 1",
    "new_string": "const x = 2"
  }
}
```

### 步骤追踪

```
1. [query.ts] 流式接收到 tool_use block
   toolUseBlocks.push({id: "toolu_01Abc", name: "Edit", input: {...}})

2. [query.ts] 流结束，进入 runTools()

3. [toolOrchestration.ts] partitionToolCalls():
   - FileEditTool.isConcurrencySafe() → false
   - 创建批次: {isConcurrencySafe: false, blocks: [toolu_01Abc]}

4. [toolOrchestration.ts] runToolsSerially():
   - setInProgressToolUseIDs(add "toolu_01Abc")

5. [toolExecution.ts] runToolUse():
   - findToolByName → FileEditTool
   - abort 检查: 未中断

6. [toolExecution.ts] checkPermissionsAndCallTool():
   a. Zod 验证: z.strictObject({file_path, old_string, new_string}).safeParse()
      → success: true
   
   b. validateInput(): 检查 file_path 是否在允许范围内
      → result: true
   
   c. backfillObservableInput(): 扩展相对路径为绝对路径
      processedInput.file_path = "/Users/wulei/projects/.../src/utils.ts"
      callInput.file_path = "src/utils.ts"  (保持原始)
   
   d. PreToolUse hooks: 运行所有注册的 hooks
   
   e. 权限检查:
      - resolveHookPermissionDecision()
      - 在 auto 模式下，可能调用分类器
      - 在 default 模式下，弹出用户确认对话框
      → {behavior: 'allow', updatedInput: {...}}
   
   f. startToolSpan() — 开始 OTel tracing
   
   g. tool.call():
      - 读取 src/utils.ts
      - 搜索 "const x = 1"
      - 替换为 "const x = 2"
      - 写入文件
      - 返回 {data: {diff: "...", filePath: "src/utils.ts"}}
   
   h. mapToolResultToToolResultBlockParam():
      → {type: "tool_result", content: "Successfully edited...", tool_use_id: "toolu_01Abc"}
   
   i. PostToolUse hooks: 运行所有注册的 hooks
   
   j. endToolSpan()

7. [toolOrchestration.ts] 更新 currentContext（如果有 contextModifier）
   markToolUseAsComplete("toolu_01Abc")

8. [query.ts] 收集 tool_result，准备下一轮 API 调用
```

---

## 7. 错误处理

### 7.1 工具不存在

```typescript
// src/services/tools/toolExecution.ts:L369-L411
if (!tool) {
  yield { message: createUserMessage({
    content: [{
      type: 'tool_result',
      content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
      is_error: true, tool_use_id: toolUse.id,
    }],
  }) }
}
```

### 7.2 输入验证失败

Zod 错误被格式化为人类可读的消息，告诉模型哪个字段不对。对于延迟加载的工具，还会提示使用 ToolSearch 先加载 schema。

### 7.3 权限被拒

```typescript
// src/services/tools/toolExecution.ts:L995-L1103
if (permissionDecision.behavior !== 'allow') {
  // 返回 is_error: true 的 tool_result
  // 如果是分类器拒绝，运行 PermissionDenied hooks
  // 如果 hook 说 {retry: true}，告诉模型可以重试
}
```

### 7.4 工具执行异常

```typescript
// src/services/tools/toolExecution.ts:L1589-L1600
} catch (error) {
  const durationMs = Date.now() - startTime
  addToToolDuration(durationMs)
  endToolExecutionSpan({ success: false, error: errorMessage(error) })

  // 特殊处理: MCP 认证错误
  // 特殊处理: MCP 工具调用错误
  // 特殊处理: Shell 错误
  // 通用: 返回 is_error: true 的 tool_result
}
```

### 7.5 用户中断

```typescript
// src/query.ts:L1015-L1029
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      // executor 为每个被中断的工具生成合成 tool_result
    }
  } else {
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Interrupted by user')
  }
}
```

**关键约束**: 每个 `tool_use` block 必须有对应的 `tool_result`——API 要求消息配对。即使工具被中断或出错，也必须生成 tool_result（通常包含错误信息和 `is_error: true`）。

---

## 8. 遥测与可观测性

整个管线中嵌入了密集的遥测点：

| 事件 | 位置 | 用途 |
|------|------|------|
| `tengu_tool_use_error` | 工具不存在、输入验证失败 | 追踪模型错误率 |
| `tengu_tool_use_cancelled` | abort 信号触发 | 追踪中断率 |
| `tengu_tool_use_can_use_tool_allowed` | 权限通过 | 权限分析 |
| `tengu_tool_use_can_use_tool_rejected` | 权限拒绝 | 权限分析 |
| `tengu_tool_use_progress` | 进度更新 | 执行监控 |
| `tengu_tool_use_success` | 执行成功 | 性能指标 |
| `tool_decision` (OTel) | 权限决定 | 合规审计 |
| `tool_result` (OTel) | 执行完成 | 端到端追踪 |

---

## 9. 关键总结

| 设计决策 | 选择 | 原因 |
|----------|------|------|
| 执行模型 | AsyncGenerator | 实时 yield 进度和结果，UI 可以增量渲染 |
| 分区策略 | 连续并发安全合并 | 保持工具调用的因果顺序，同时最大化并发 |
| 错误处理 | 总是返回 tool_result | API 要求 tool_use/tool_result 配对 |
| Context 传递 | 不可变 + modifier 函数 | 串行工具可以修改上下文，并发工具延迟应用 |
| 流式优化 | Streaming Tool Executor | 工具执行与 API 流式输出重叠 |
