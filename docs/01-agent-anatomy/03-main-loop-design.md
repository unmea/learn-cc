# Q: Agent 的"心脏"是什么？为什么选 AsyncGenerator 实现主循环？

> **一句话回答**：`queryLoop` 是一个 `async function*`（AsyncGenerator），它在 `while(true)` 中不断执行"准备消息 → 调用 API → 流式处理 → 执行工具 → 判断继续/停止"，而 AsyncGenerator 模式天然支持流式输出、取消控制、背压管理，是实现 Agent 循环的最佳原语。

---

## 为什么这个问题重要

`src/query.ts` 的 `queryLoop` 函数是整个 Claude Code 的核心引擎——1500 行代码，驱动着每一次用户交互。理解它的结构，就理解了 Agent 如何思考、行动和自我修复。

更重要的是理解**为什么选择 AsyncGenerator**。这不是一个随意的技术选择——回调、Observable、简单 while 循环都可以实现类似功能，但 AsyncGenerator 在流式系统中有独特优势。弄清楚这个选择背后的权衡，你就能理解为什么现代 AI Agent 框架普遍采用这种模式。

---

## 深度解答

### 子问题 1：queryLoop 的函数签名意味什么？

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

解读这个签名：

| 部分 | 含义 |
|------|------|
| `async function*` | 异步生成器——可以 `yield` 值也可以 `await` Promise |
| `params: QueryParams` | 不可变输入参数 |
| `consumedCommandUuids: string[]` | 通过引用共享的消费命令追踪 |
| `AsyncGenerator<YieldType, ReturnType>` | yield 流式事件，return 终止原因 |
| yield 类型：`StreamEvent \| Message \| ...` | 5 种不同的输出事件 |
| return 类型：`Terminal` | 终止信息（包含 reason 字段） |

关键设计点：**yield 用于流式输出，return 用于终止信号**。消费者通过 `for await...of` 逐个处理 yield 的值，循环的 return 值通过 generator 的 `.next()` 的 `done: true` 分支获取。

### 子问题 2：State 类型——循环的记忆

```typescript
// src/query.ts:204-217
type State = {
  messages: Message[]                                  // 完整消息历史
  toolUseContext: ToolUseContext                        // 工具执行上下文
  autoCompactTracking: AutoCompactTrackingState | undefined  // 自动压缩状态
  maxOutputTokensRecoveryCount: number                 // 输出超限恢复计数
  hasAttemptedReactiveCompact: boolean                 // 是否尝试过响应式压缩
  maxOutputTokensOverride: number | undefined          // 输出 token 上限覆写
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined  // 异步工具摘要
  stopHookActive: boolean | undefined                  // 停止钩子是否激活
  turnCount: number                                    // 轮次计数器
  transition: Continue | undefined                     // 上一次继续的原因
}
```

逐字段分析：

**`messages: Message[]`** —— 最核心的状态。每轮迭代后追加 assistant 消息和 tool results。这就是 LLM 的"记忆"。

**`autoCompactTracking`** —— 追踪自动压缩的状态：是否已压缩过、压缩后的轮次计数、连续失败次数。当消息历史过长时，触发自动压缩。

**`maxOutputTokensRecoveryCount`** —— 模型输出被截断（max_output_tokens）时的恢复尝试计数。上限为 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`。超过后停止重试。

**`hasAttemptedReactiveCompact`** —— 响应式压缩的一次性保护标志。防止 prompt-too-long → compact → still too long → compact → ... 的无限循环。

**`pendingToolUseSummary`** —— 一个 Promise！上一轮的工具摘要（Haiku 生成，~1s）在当前轮模型调用期间（5-30s）并行解析。下一轮开始时 await。这是一个精巧的并行化。

**`transition: Continue | undefined`** —— 记录上一次迭代为什么继续。这是调试金矿——当循环行为异常时，可以追踪每一步的决策原因。

#### State 的更新模式

注意代码中 State 的更新方式：

```typescript
// src/query.ts:265-279 — 初始化
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}

// 每次 continue 时整体替换（不是逐字段修改）
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  // ...
  transition: { reason: 'next_turn' },
}
state = next
```

**设计选择**：用 `state = { ...全部字段 }` 替代 `state.messages = ...`。注释解释：

> Continue sites write `state = { ... }` instead of 9 separate assignments.

这避免了遗漏某个字段更新的 bug。每个 continue 站点都必须声明所有字段的值。

### 子问题 3：循环的完整结构

```
while (true) {
  ┌─────────────────────────────────────────────────────────┐
  │ Phase 1: 消息准备 (Perceive)                             │
  │   ├── 解构 state                                         │
  │   ├── 启动 skill discovery 预取                           │
  │   ├── yield stream_request_start 事件                     │
  │   ├── 初始化/递增 queryTracking                            │
  │   ├── 获取 compact boundary 后的消息                       │
  │   ├── applyToolResultBudget（工具结果大小限制）              │
  │   ├── snipCompact（历史裁剪）                              │
  │   ├── microcompact（微压缩）                               │
  │   ├── contextCollapse（上下文折叠）                         │
  │   ├── 组装 systemPrompt                                   │
  │   ├── autocompact（自动压缩）                              │
  │   └── 更新 toolUseContext.messages                        │
  ├─────────────────────────────────────────────────────────┤
  │ Phase 2: 模型调用 (Think)                                 │
  │   ├── 创建 StreamingToolExecutor（可选）                   │
  │   ├── 解析当前模型                                        │
  │   ├── 检查 blocking limit                                │
  │   ├── deps.callModel() — API 流式调用                     │
  │   ├── for await: 处理每个流式 chunk                        │
  │   │   ├── 处理 streaming fallback                         │
  │   │   ├── backfill tool 输入                              │
  │   │   ├── withhold 可恢复错误                              │
  │   │   ├── yield 消息（如果未 withhold）                    │
  │   │   ├── 记录 assistant messages                         │
  │   │   ├── 收集 tool_use blocks                            │
  │   │   └── 提交工具给 StreamingToolExecutor                 │
  │   └── 处理 FallbackTriggeredError → 切换模型重试           │
  ├─────────────────────────────────────────────────────────┤
  │ Phase 3: 后处理与恢复                                     │
  │   ├── executePostSamplingHooks                           │
  │   ├── 处理 abort（中断）                                  │
  │   ├── yield pendingToolUseSummary（上轮工具摘要）           │
  │   │                                                      │
  │   ├── if (!needsFollowUp):  【无工具调用 → 可能结束】       │
  │   │   ├── prompt-too-long 恢复                            │
  │   │   │   ├── context collapse drain                     │
  │   │   │   └── reactive compact                           │
  │   │   ├── max_output_tokens 恢复                          │
  │   │   │   ├── escalate（8k → 64k）                       │
  │   │   │   └── recovery message（最多 3 次）               │
  │   │   ├── API error → return                             │
  │   │   ├── stop hooks 检查                                 │
  │   │   ├── token budget 检查                               │
  │   │   └── return { reason: 'completed' }                 │
  │   │                                                      │
  │   └── if (needsFollowUp):  【有工具调用 → 继续循环】       │
  ├─────────────────────────────────────────────────────────┤
  │ Phase 4: 工具执行 (Act)                                   │
  │   ├── runTools() 或 streamingToolExecutor.getRemainingResults() │
  │   ├── for await: 处理每个工具结果                           │
  │   │   ├── yield 工具结果消息                               │
  │   │   ├── 检查 hook_stopped_continuation                  │
  │   │   └── 收集 toolResults                               │
  │   └── 生成 nextPendingToolUseSummary（异步，下轮消费）      │
  ├─────────────────────────────────────────────────────────┤
  │ Phase 5: 结果收集与续行 (Observe & Continue)               │
  │   ├── 处理 abort during tools                            │
  │   ├── 处理 hook prevented continuation                   │
  │   ├── 更新 autoCompactTracking.turnCounter               │
  │   ├── 收集 attachment messages                            │
  │   ├── 消费 memory prefetch                                │
  │   ├── 收集 skill discovery prefetch                       │
  │   ├── 消费队列命令                                        │
  │   ├── 刷新 MCP tools                                     │
  │   ├── 生成 task summary（后台会话）                        │
  │   ├── 检查 maxTurns 限制                                  │
  │   └── state = { ...next, transition: 'next_turn' }       │
  └── continue (while true)                                  │
      ─────────────────────────────────────────────────────┘
```

### 子问题 4：所有 Continue 条件

`queryLoop` 有 **8 种** 导致循环继续的原因（即 `state = next; continue`）：

#### 1. `next_turn` —— 正常工具执行后继续

```typescript
// src/query.ts:1715-1727
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  // ...
  turnCount: nextTurnCount,
  transition: { reason: 'next_turn' },
}
state = next
// while(true) 继续
```

**触发条件**：模型返回了 `tool_use` block → 工具执行完成 → 没有中断/超限 → 收集结果后继续。这是最常见的路径。

#### 2. `reactive_compact_retry` —— 响应式压缩后重试

```typescript
// src/query.ts:1152-1165
const next: State = {
  messages: postCompactMessages,
  // ...
  hasAttemptedReactiveCompact: true,
  transition: { reason: 'reactive_compact_retry' },
}
state = next
continue
```

**触发条件**：API 返回 prompt-too-long (413) 或 media-size 错误 → 响应式压缩成功 → 用压缩后的消息重试。注意 `hasAttemptedReactiveCompact: true` 确保只尝试一次。

#### 3. `collapse_drain_retry` —— 上下文折叠排空后重试

```typescript
// src/query.ts:1099-1116
const next: State = {
  messages: drained.messages,
  // ...
  transition: {
    reason: 'collapse_drain_retry',
    committed: drained.committed,
  },
}
state = next
continue
```

**触发条件**：prompt-too-long → 尚有待提交的 context collapses → 排空后重试。如果排空后仍然 413，下次不再尝试（检查 `state.transition?.reason !== 'collapse_drain_retry'`）。

#### 4. `max_output_tokens_escalate` —— 输出限制升级

```typescript
// src/query.ts:1207-1221
const next: State = {
  messages: messagesForQuery,
  // ...
  maxOutputTokensOverride: ESCALATED_MAX_TOKENS,  // 8k → 64k
  transition: { reason: 'max_output_tokens_escalate' },
}
state = next
continue
```

**触发条件**：模型输出被 8k 默认上限截断 → 无用户自定义覆写 → 用 64k 重试同一请求。这是一种"单次升级"策略——不注入恢复消息，只增大上限。

#### 5. `max_output_tokens_recovery` —— 输出超限恢复

```typescript
// src/query.ts:1231-1252
const recoveryMessage = createUserMessage({
  content: `Output token limit hit. Resume directly — no apology, no recap...`,
  isMeta: true,
})

const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
  // ...
  maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
  transition: {
    reason: 'max_output_tokens_recovery',
    attempt: maxOutputTokensRecoveryCount + 1,
  },
}
state = next
continue
```

**触发条件**：升级后仍超限（或升级未启用）→ 注入元消息要求模型"继续，不要道歉" → 最多 3 次（`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`）。注意恢复消息的措辞精心设计——防止模型浪费 token 在"抱歉，我被截断了"上。

#### 6. `stop_hook_blocking` —— 停止钩子阻塞

```typescript
// src/query.ts:1283-1305
const next: State = {
  messages: [
    ...messagesForQuery,
    ...assistantMessages,
    ...stopHookResult.blockingErrors,
  ],
  // ...
  stopHookActive: true,
  transition: { reason: 'stop_hook_blocking' },
}
state = next
continue
```

**触发条件**：模型本轮无 tool_use → stop hooks 检查发现阻塞错误 → 把错误注入消息让模型修复 → 继续循环。`stopHookActive: true` 标记后续仍处于 stop hook 活动状态。

#### 7. `token_budget_continuation` —— Token 预算续行

```typescript
// src/query.ts:1321-1340
state = {
  messages: [
    ...messagesForQuery,
    ...assistantMessages,
    createUserMessage({
      content: decision.nudgeMessage,
      isMeta: true,
    }),
  ],
  // ...
  transition: { reason: 'token_budget_continuation' },
}
continue
```

**触发条件**：模型 stop 了但 token 预算未用完 → 注入 nudge 消息鼓励继续 → 直到预算耗尽或出现 diminishing returns。

#### 8. 模型 Fallback（在 streaming 循环内）

```typescript
// src/query.ts:894-950
if (innerError instanceof FallbackTriggeredError && fallbackModel) {
  currentModel = fallbackModel
  attemptWithFallback = true  // 内层 while 循环重试
  // 清理 orphaned messages
  // yield fallback system message
  continue  // 内层 continue，非外层
}
```

**触发条件**：API 调用触发 `FallbackTriggeredError` → 切换到 fallback model → 清理已有 assistant messages → 重试 API 调用。

### 子问题 5：所有 Stop 条件

循环终止通过 `return { reason: '...' }` 实现：

| reason | 触发条件 | 行号 |
|--------|---------|------|
| `'blocking_limit'` | Token 数达到阻塞限制（autocompact 关闭时） | L646 |
| `'image_error'` | 图片大小/调整错误 | L977 |
| `'model_error'` | API 调用抛出异常 | L996 |
| `'aborted_streaming'` | 用户在 streaming 期间中断 | L1051 |
| `'prompt_too_long'` | prompt-too-long 恢复全部失败 | L1175, L1182 |
| `'completed'` | 正常完成（无 tool_use + 无恢复需要） | L1264, L1357 |
| `'stop_hook_prevented'` | Stop hook 阻止继续 | L1279 |
| `'aborted_tools'` | 用户在工具执行期间中断 | L1515 |
| `'hook_stopped'` | Hook 停止了续行 | L1520 |
| `'max_turns'` | 达到最大轮次限制 | L1711 |

### 子问题 6：为什么选 AsyncGenerator？

四种备选方案的对比：

#### 方案 A：简单 while 循环 + 回调

```typescript
// 假想的回调实现
async function queryLoop(params, onEvent: (event) => void): Promise<Terminal> {
  while (true) {
    const response = await callModel(messages)
    onEvent(response)  // 如何处理背压？
    if (response.stop) return { reason: 'completed' }
    const results = await runTools(response.tools)
    for (const r of results) onEvent(r)  // 如果消费者处理慢呢？
  }
}
```

**问题**：
- 无背压控制：如果消费者处理慢，事件会堆积
- 取消困难：需要额外的取消机制
- 无法暂停：消费者不能控制生产速度
- 返回值丢失：回调模式下很难传递终止信号

#### 方案 B：Observable（RxJS 风格）

```typescript
// 假想的 Observable 实现
function queryLoop(params): Observable<StreamEvent> {
  return new Observable(subscriber => {
    const loop = async () => {
      while (true) {
        for await (const chunk of callModel(messages)) {
          subscriber.next(chunk)  // 背压？需要额外机制
        }
        // ...
      }
    }
    loop()
    return () => { /* cleanup */ }
  })
}
```

**问题**：
- 引入重量级依赖（RxJS）
- Push 模型不适合需要背压的场景
- 取消通过 unsubscribe，不如 AbortController 直观
- Observable 的终态（complete/error）不能携带结构化数据（Terminal 类型）

#### 方案 C：Node.js Stream（Readable）

```typescript
// 假想的 Stream 实现
function queryLoop(params): Readable {
  return new Readable({
    async read() {
      // 复杂的状态管理
      // 需要手动处理对象模式
    }
  })
}
```

**问题**：
- Stream 是 Node.js 特有的，不跨平台
- 对象模式 Stream 的类型安全差
- 内部状态管理复杂
- 不支持 `return` 语义

#### 方案 D：AsyncGenerator（Claude Code 的选择）✓

```typescript
async function* queryLoop(params): AsyncGenerator<Event, Terminal> {
  while (true) {
    yield { type: 'stream_request_start' }
    for await (const chunk of callModel(messages)) {
      yield chunk  // 天然背压：消费者不 next() 就暂停
    }
    if (!needsFollowUp) return { reason: 'completed' }
    for await (const result of runTools(tools)) {
      yield result
    }
  }
}
```

**优势**：

1. **天然背压**：`yield` 暂停生产者直到消费者调用 `.next()`。如果 UI 渲染慢，循环自动减速——不需要任何额外代码。

2. **协作式取消**：消费者可以调用 `generator.return()`，循环立即终止。配合 `try/finally`，清理逻辑自然执行。

3. **结构化终止**：`return { reason: 'completed' }` 是类型安全的，消费者通过 `{ done: true, value: terminal }` 获取。

4. **流式组合**：`yield*` 可以委托给子 generator：
   ```typescript
   // src/query.ts:230
   const terminal = yield* queryLoop(params, consumedCommandUuids)
   ```
   外层 `query()` 用 `yield*` 转发 `queryLoop()` 的所有值。

5. **零依赖**：AsyncGenerator 是 ES2018 原生特性，不需要额外库。

6. **调试友好**：generator 的暂停/恢复特性让你可以在任何 `yield` 点设置断点，检查当时的状态。

### 子问题 7：运行时示例——追踪一次真实对话

用户输入："请帮我读取 main.ts 的前 10 行"

```
Turn 1: 用户消息
────────────────
queryLoop 启动
state = { messages: [userMsg], turnCount: 1, transition: undefined }

Phase 1: 消息准备
  - getMessagesAfterCompactBoundary → [userMsg]
  - applyToolResultBudget → 无变化
  - microcompact → 无变化（首次，无历史）
  - autocompact → 无变化（消息太少）

Phase 2: 调用模型
  - deps.callModel({ messages: [userMsg], ... })
  - 流式返回:
    yield AssistantMessage {
      content: [
        { type: 'text', text: '我来帮你读取文件...' },
        { type: 'tool_use', id: 'tu_123', name: 'Read',
          input: { file_path: 'main.ts', offset: 0, limit: 10 } }
      ]
    }
  - needsFollowUp = true（有 tool_use block）
  - toolUseBlocks = [{ id: 'tu_123', name: 'Read', ... }]

Phase 3: 无停止检查（needsFollowUp = true）

Phase 4: 工具执行
  - runTools([toolBlock], assistantMessages, canUseTool, context)
  - Read 工具:
    1. validateInput → OK
    2. checkPermissions → isReadOnly=true → 自动允许
    3. call() → 读取 main.ts 前 10 行
    4. yield UserMessage {
         content: [{ type: 'tool_result', tool_use_id: 'tu_123',
                    content: '// Line 1\n// Line 2\n...' }]
       }

Phase 5: 收集结果
  - toolResults = [toolResultMsg]
  - 获取 attachments → 无
  - memory prefetch → 未就绪或无相关记忆
  - maxTurns 检查 → OK
  - state = {
      messages: [userMsg, assistantMsg, toolResultMsg],
      turnCount: 2,
      transition: { reason: 'next_turn' },
    }
  → continue

Turn 2: 工具结果后继续
────────────────────
Phase 1: 消息准备
  - messages = [userMsg, assistantMsg, toolResultMsg]
  - compact 等 → 消息较少，无操作

Phase 2: 调用模型
  - deps.callModel({ messages: [userMsg, assistantMsg, toolResult], ... })
  - 流式返回:
    yield AssistantMessage {
      content: [
        { type: 'text', text: '以下是 main.ts 的前 10 行：\n```\n...\n```' }
      ]
      // 注意：没有 tool_use block！
    }
  - needsFollowUp = false

Phase 3: 停止检查
  - prompt-too-long? NO
  - max_output_tokens? NO
  - API error? NO
  - stop hooks → 无阻塞
  - token budget → 未启用或已完成
  → return { reason: 'completed' }

循环结束 ✓
```

整个过程经历了 2 次循环迭代（2 个 turn），1 次工具调用。

### 子问题 8：Withhold 机制——延迟 yield 的智慧

循环中有一个精妙的模式：**withhold（扣留）**。

```typescript
// src/query.ts:799-825
let withheld = false
if (feature('CONTEXT_COLLAPSE')) {
  if (contextCollapse?.isWithheldPromptTooLong(message, ...)) {
    withheld = true
  }
}
if (reactiveCompact?.isWithheldPromptTooLong(message)) {
  withheld = true
}
if (mediaRecoveryEnabled && reactiveCompact?.isWithheldMediaSizeError(message)) {
  withheld = true
}
if (isWithheldMaxOutputTokens(message)) {
  withheld = true
}
if (!withheld) {
  yield yieldMessage  // 只有非扣留消息才 yield
}
```

**为什么要扣留？** 

当 API 返回 prompt-too-long 或 max-output-tokens 错误时，这些"错误消息"不应立即发送给 UI——因为循环可能能恢复（通过 compact 或 recovery）。如果过早 yield 错误消息，SDK 消费者（如桌面应用）会认为会话失败并终止连接，而实际上恢复正在后台进行。

注释中明确指出了这个设计原因：

> Yielding early leaks an intermediate error to SDK callers (e.g. cowork/desktop) that terminate the session on any `error` field — the recovery loop keeps running but nobody is listening.

---

## 源码对照

### 并行化策略：pendingToolUseSummary

```typescript
// src/query.ts:1412-1482
// 工具执行完毕后，异步生成摘要（不阻塞下一轮 API 调用）
nextPendingToolUseSummary = generateToolUseSummary({
  tools: toolInfoForSummary,
  signal: toolUseContext.abortController.signal,
  // ...
}).then(summary => summary ? createToolUseSummaryMessage(summary, toolUseIds) : null)
  .catch(() => null)

// 下一轮迭代开始时消费
// src/query.ts:1054-1060
if (pendingToolUseSummary) {
  const summary = await pendingToolUseSummary
  if (summary) yield summary
}
```

时间线图：

```
Turn N:     [API call 5-30s] → [Tool execution 1-5s] → [摘要生成 ~1s ──────┐]
Turn N+1:   [消费摘要] → [准备消息] → [API call 5-30s]  ← 摘要早已完成 ──────┘
```

Haiku 生成摘要只需 ~1s，但如果串行放在 Turn N 末尾，就会延迟 Turn N+1 的开始。通过 Promise 并行化，摘要在下一轮 API 调用（5-30s）的 前几秒 就绑定完成了。

### 流式工具执行：StreamingToolExecutor

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

// API 流式返回时，立即提交工具
// src/query.ts:838-844
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const toolBlock of msgToolUseBlocks) {
    streamingToolExecutor.addTool(toolBlock, message)
  }
}

// 流式期间就收集已完成的结果
// src/query.ts:851-862
for (const result of streamingToolExecutor.getCompletedResults()) {
  if (result.message) {
    yield result.message
    toolResults.push(...)
  }
}
```

时间线图（对比传统模式）：

```
传统模式:
[API streaming ═══════════] → [Tool A ═══] → [Tool B ═══] → [Tool C ═══]
                              ↑ 工具串行执行，等 API 完成才开始

流式模式:
[API streaming ═══════════]
  ├─ tool_use A arrives → [Tool A ═══]  ← API 还在流式传输时就开始
  ├─ tool_use B arrives ──→ [Tool B ═══]
  └─ tool_use C arrives ────→ [Tool C ═══]
     └─ stream done ─→ [collect remaining results]
```

### QueryConfig：不可变环境快照

```typescript
// src/query.ts:295-296
const config = buildQueryConfig()
```

`buildQueryConfig()` 在循环入口处拍一次快照，包含 feature gates、session 信息等。注释解释：

> Snapshot immutable env/statsig/session state once at entry. feature() gates are intentionally excluded.

这确保循环内部看到的环境状态一致——不会因为 GrowthBook 在循环中途刷新而导致行为不一致。

### 预算追踪器：taskBudgetRemaining

```typescript
// src/query.ts:291
let taskBudgetRemaining: number | undefined = undefined
```

这个变量追踪 API 侧的 task budget 剩余量。关键设计点在注释中：

> Loop-local (not on State) to avoid touching the 7 continue sites.

`taskBudgetRemaining` 故意不放在 `State` 类型里——因为 State 的每个 continue 站点都需要显式声明所有字段。一个只在 compact 时更新的字段不值得在 7 个 continue 站点中都声明。这是一个务实的设计取舍。

---

## 设计动机分析

### 为什么 `while(true)` 而非递归？

早期版本的 Agent 循环常用递归实现：

```typescript
// 递归版本（Claude Code 没用这个）
async function* queryRecursive(messages) {
  const response = await callModel(messages)
  yield response
  if (response.hasToolUse) {
    const results = await runTools(response)
    yield* queryRecursive([...messages, response, ...results])  // 递归
  }
}
```

`while(true)` + `state` 替代递归的好处：
1. **无栈溢出风险**：循环 100 轮不会 stack overflow
2. **状态显式**：所有状态在 `State` 类型中，而非隐含在调用栈
3. **易于添加 continue 条件**：新增一个 `continue` 分支即可
4. **性能**：无函数调用开销

### 为什么把 continue 条件分散在循环体中？

8 个 continue 站点分布在循环的不同位置，而非集中在一个 switch/if-else 中。这是因为**不同的 continue 条件需要不同的状态更新**——collapse drain 需要新的消息列表，max-output-tokens 需要恢复计数递增，reactive compact 需要设置 `hasAttemptedReactiveCompact`。

集中处理意味着需要先收集所有信号再统一决策，这增加了复杂性。分散处理的代价是代码较长，但每个 continue 站点都是自包含的、可独立理解的。

### `transition` 字段的调试价值

```typescript
transition: Continue | undefined
```

每个 continue 站点都写入一个 `transition`，记录 *为什么* 循环继续了。这在生产环境中极有价值：

- 发现无限循环时：检查 `transition` 序列，看到 `reactive_compact_retry → reactive_compact_retry → ...` 就知道是 compact 恢复逻辑的 bug
- 分析性能时：`next_turn` 次数 = 实际工具调用轮数，其他 reason 的次数 = 错误恢复尝试次数

注释明确说明了这个设计意图：

> Lets tests assert recovery paths fired without inspecting message contents.

---

## 启发与超越

### 启发 1：AsyncGenerator 是 Agent Loop 的理想原语

AsyncGenerator 提供的三个特性完美匹配 Agent 需求：
- **yield**（流式输出）→ 实时显示 LLM 思考过程
- **背压**（消费者控制生产者）→ UI 渲染跟上数据生产
- **return**（结构化终止）→ 精确传递终止原因

如果要设计新的 Agent 框架，AsyncGenerator 应该是默认选择。

### 启发 2：错误恢复比正常路径更重要

`queryLoop` 中正常路径（next_turn）只有一个 continue 站点，但恢复路径有 7 个。在生产 Agent 系统中，大部分代码在处理"出错了怎么办"：
- 上下文太长？压缩
- 输出被截断？恢复
- 模型过载？切换
- 权限被拒？通知

### 启发 3：State 的"全量替换"模式值得借鉴

`state = { ...所有字段 }` 而非 `state.field = value` 的模式，虽然代码看起来冗长，但有两个重要好处：
1. **编译时安全**：遗漏任何字段都会 TypeScript 报错
2. **可审计性**：每个 continue 站点的完整状态一目了然

### 启发 4：并行化隐藏在细节中

`pendingToolUseSummary`（上轮工具摘要 Promise 在下轮消费）、`startRelevantMemoryPrefetch`（循环入口预取，迭代中消费）、`pendingSkillPrefetch`（每轮预取 skill discovery）——这些并行化不是宏观架构决策，而是逐步优化的结果。每一个都只节省 1-2 秒，但累积效果显著。

---

## 延伸阅读

- **Agent 定义**：`learn/01-agent-anatomy/01-what-is-coding-agent.md` — 什么是编码代理
- **启动流程**：`learn/01-agent-anatomy/02-bootstrap-and-lifecycle.md` — 从进程启动到循环就绪
- **上下文管理**：`learn/06-context-engineering/` — autocompact/microcompact/reactive compact 详解
- **源码文件**：
  - `src/query.ts` — 核心循环（1730 行）
  - `src/query/config.ts` — QueryConfig 构建
  - `src/query/deps.ts` — 可注入依赖
  - `src/query/stopHooks.ts` — Stop hook 处理
  - `src/query/tokenBudget.ts` — Token 预算管理
  - `src/services/tools/StreamingToolExecutor.ts` — 流式工具执行器
  - `src/services/tools/toolOrchestration.ts` — 工具编排（runTools）
  - `src/services/compact/autoCompact.ts` — 自动压缩
  - `src/services/compact/reactiveCompact.ts` — 响应式压缩
