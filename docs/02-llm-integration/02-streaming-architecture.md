# Q: 流式响应如何从 SSE 事件变成终端上的实时文字？


当你在终端输入一个问题，Claude Code 的文字是**逐字出现**的——这不是魔术，而是一条精密的流式管线。从 API 返回的 SSE 事件，经过解析、累积、标准化，最终 yield 给 UI 层进行增量渲染。

---

## 目录

1. [流式管线全景](#1-流式管线全景)
2. [发起流式请求](#2-发起流式请求)
3. [六种 SSE 事件类型](#3-六种-sse-事件类型)
4. [事件处理主循环](#4-事件处理主循环)
5. [Tool Use 中流累积](#5-tool-use-中流累积)
6. [错误恢复机制](#6-错误恢复机制)
7. [运行时追踪示例](#7-运行时追踪示例)
8. [设计启发](#8-设计启发)

---

## 1. 流式管线全景

```
用户输入 "Hello, 写一个函数"
         │
         ▼
  ┌─────────────────┐
  │  query()         │ src/query.ts:219
  │  queryLoop()     │ 主循环入口
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ queryModel       │ src/services/api/claude.ts
  │ WithStreaming()  │ 发起 API 请求
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ withRetry()      │ src/services/api/withRetry.ts
  │ 包装重试逻辑      │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐
  │ anthropic.beta   │ Anthropic SDK
  │ .messages.create │ { stream: true }
  │ .withResponse()  │
  └────────┬────────┘
           │
  ─────────┼──── HTTP SSE 流 ────
           │
           ▼
  ┌─────────────────────────────────┐
  │  for await (const part of stream)│ claude.ts:1940
  │                                  │
  │  switch (part.type) {            │
  │    message_start    → 初始化     │
  │    content_block_start → 开辟块  │
  │    content_block_delta → 累积    │
  │    content_block_stop  → yield   │
  │    message_delta    → 最终统计   │
  │    message_stop     → 结束标记   │
  │  }                               │
  └────────┬─────────────────────────┘
           │
           │ yield AssistantMessage
           │ yield StreamEvent
           │
           ▼
  ┌─────────────────┐
  │  UI 层消费       │ REPL.tsx / components
  │  增量渲染        │
  └─────────────────┘
```

### 关键类型定义

```typescript
// 流式响应生成器的 yield 类型
AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
>
```

- **`StreamEvent`**: 原始 SSE 事件的透传包装（供 UI 做进度显示）
- **`AssistantMessage`**: 完成的内容块（供消息列表和工具执行使用）
- **`SystemAPIErrorMessage`**: API 错误信息（显示给用户）

---

## 2. 发起流式请求

### 2.1 入口函数

```typescript
// src/services/api/claude.ts:752-779
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(...)
  })
}
```

`withStreamingVCR` 是录制/回放层——在开发调试时可以录制 API 响应。

### 2.2 实际 API 调用：为什么用 Raw Stream？

```typescript
// src/services/api/claude.ts:1818-1836
// Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    { signal, ...(clientRequestId && {
        headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
    }) },
  )
  .withResponse()

streamRequestId = result.request_id    // 请求追踪 ID
streamResponse = result.response       // HTTP Response（用于取消流）
return result.data   // Stream<BetaRawMessageStreamEvent>
```

SDK 提供两种流消费方式：
1. **`BetaMessageStream`**（高级封装）：每次 `input_json_delta` 执行 `partialParse()` → **O(n²)**
2. **Raw Stream**（Claude Code 的选择）：原始事件 + 手动累积 → **O(n)**

> **性能洞察**: 工具参数可能很长（如 `write_to_file` 的 `content`），O(n²) 的部分 JSON 解析会显著拖慢渲染。Claude Code 手动累积字符串，只在块结束时一次性解析。

---

## 3. 六种 SSE 事件类型

Anthropic Messages API 的流式响应由 6 种事件类型组成：

```
时间轴 →
──────────────────────────────────────────────────────────────
  message_start
  │
  ├── content_block_start[0]  (text)
  │   ├── content_block_delta  "Hello"
  │   ├── content_block_delta  "! 这是"
  │   ├── content_block_delta  "一个函数"
  │   └── content_block_stop[0]         ← yield AssistantMessage
  │
  ├── content_block_start[1]  (tool_use: write_to_file)
  │   ├── content_block_delta  {"file_path":
  │   ├── content_block_delta  "\"src/he
  │   ├── content_block_delta  llo.ts\","
  │   ├── content_block_delta  "content":...}
  │   └── content_block_stop[1]         ← yield AssistantMessage
  │
  ├── content_block_start[2]  (thinking)
  │   ├── content_block_delta  "Let me think..."
  │   ├── content_block_delta  signature_delta
  │   └── content_block_stop[2]         ← yield AssistantMessage
  │
  message_delta  (usage, stop_reason)
  message_stop
──────────────────────────────────────────────────────────────
```

### 事件类型速查表

| 事件类型 | 触发时机 | 关键数据 |
|----------|----------|----------|
| `message_start` | 流开始 | `message` 元信息、初始 `usage` |
| `content_block_start` | 每个内容块开始 | `index`、`content_block.type` |
| `content_block_delta` | 增量数据到达 | `delta.text` / `delta.partial_json` / `delta.thinking` |
| `content_block_stop` | 内容块结束 | `index`（触发 yield） |
| `message_delta` | 消息元信息更新 | `stop_reason`、最终 `usage` |
| `message_stop` | 流结束 | 无额外数据 |

---

## 4. 事件处理主循环

### 4.1 循环结构

```typescript
// src/services/api/claude.ts:1940-2304
for await (const part of stream) {
  resetStreamIdleTimer()       // 每个事件都重置空闲定时器
  const now = Date.now()

  // 停顿检测
  if (lastEventTime !== null) {
    const timeSinceLastEvent = now - lastEventTime
    if (timeSinceLastEvent > STALL_THRESHOLD_MS) {  // 30 秒
      stallCount++
      totalStallTime += timeSinceLastEvent
      logEvent('tengu_streaming_stall', { ... })
    }
  }
  lastEventTime = now

  switch (part.type) {
    case 'message_start': { ... }
    case 'content_block_start': { ... }
    case 'content_block_delta': { ... }
    case 'content_block_stop': { ... }
    case 'message_delta': { ... }
    case 'message_stop': break
  }

  // 每个事件都透传给 UI
  yield {
    type: 'stream_event',
    event: part,
    ...(part.type === 'message_start' ? { ttftMs } : undefined),
  }
}
```

### 4.2 message_start：初始化阶段

```typescript
// src/services/api/claude.ts:1980-1993
case 'message_start': {
  partialMessage = part.message      // 存储消息框架
  ttftMs = Date.now() - start        // 计算首 token 延迟
  usage = updateUsage(usage, part.message?.usage)
  break
}
```

`ttftMs`（Time To First Token）是关键性能指标，附加在 `StreamEvent` 上供遥测系统收集。

### 4.3 content_block_start：开辟内容块

```typescript
// src/services/api/claude.ts:1995-2050
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '',                   // 空字符串，用于累积 JSON 片段
      }
      break
    case 'server_tool_use':
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '' as unknown as { [key: string]: unknown },
      }
      break
    case 'text':
      contentBlocks[part.index] = {
        ...part.content_block,
        text: '',                    // 空字符串，用于累积文本
      }
      break
    case 'thinking':
      contentBlocks[part.index] = {
        ...part.content_block,
        thinking: '',                // 空字符串，用于累积思考内容
        signature: '',
      }
      break
  }
  break
```

> **关键设计**: 每种内容块类型在 `start` 时初始化为**空字符串**，后续 `delta` 事件通过字符串拼接累积。这比每次解析完整对象高效得多。

### 4.4 content_block_delta：增量累积

```typescript
// src/services/api/claude.ts:2053-2160
case 'content_block_delta': {
  const contentBlock = contentBlocks[part.index]
  const delta = part.delta

  switch (delta.type) {
    case 'input_json_delta':
      // Tool Use 参数累积
      contentBlock.input += delta.partial_json
      break

    case 'text_delta':
      // 文本内容累积
      contentBlock.text += delta.text
      break

    case 'thinking_delta':
      // 思考内容累积
      contentBlock.thinking += delta.thinking
      break

    case 'signature_delta':
      // 思考签名累积
      contentBlock.signature += delta.signature
      break

    case 'citations_delta':
      // TODO: 引用处理
      break
  }
  break
}
```

delta 累积的数据结构演变：

```
content_block_start: { type: 'text', text: '' }
content_block_delta: { type: 'text', text: 'Hello' }
content_block_delta: { type: 'text', text: 'Hello! 这是' }
content_block_delta: { type: 'text', text: 'Hello! 这是一个函数' }
content_block_stop:  → yield AssistantMessage
```

### 4.5 content_block_stop：yield 完成的消息

这是整个流式管线中**最关键的事件**——每当一个内容块完成，就立即构造并 yield 一个 `AssistantMessage`：

```typescript
// src/services/api/claude.ts:2171-2210
case 'content_block_stop': {
  const contentBlock = contentBlocks[part.index]
  if (!contentBlock) {
    throw new RangeError('Content block not found')
  }
  if (!partialMessage) {
    throw new Error('Message not found')
  }

  const m: AssistantMessage = {
    message: {
      ...partialMessage,
      content: normalizeContentFromAPI(
        [contentBlock] as BetaContentBlock[],
        tools,
        options.agentId,
      ),
    },
    requestId: streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  newMessages.push(m)
  yield m                // ← 这里！消息流向 UI 和工具执行层
  break
}
```

> **设计洞察**: 一次 API 调用可能产生**多个** `AssistantMessage`——比如先一个 text 块（解释），再一个 tool_use 块（执行操作）。每个块独立 yield，UI 可以在文字出完后立即开始工具执行。

### 4.6 message_delta：最终统计

```typescript
// src/services/api/claude.ts:2213-2293
case 'message_delta': {
  usage = updateUsage(usage, part.usage)
  stopReason = part.delta.stop_reason

  // 直接突变已 yield 的消息（关键！）
  const lastMsg = newMessages.at(-1)
  if (lastMsg) {
    lastMsg.message.usage = usage
    lastMsg.message.stop_reason = stopReason
  }

  // 更新费用
  const costUSDForPart = calculateUSDCost(resolvedModel, usage)
  costUSD += addToTotalSessionCost(costUSDForPart, usage, options.model)

  // 处理 max_tokens
  if (stopReason === 'max_tokens') {
    yield createAssistantAPIErrorMessage({
      content: `Claude's response exceeded the ${maxOutputTokens} output token maximum...`,
      apiError: 'max_output_tokens',
    })
  }

  // 处理 context_window_exceeded
  if (stopReason === 'model_context_window_exceeded') {
    yield createAssistantAPIErrorMessage({
      content: `The model has reached its context window limit.`,
      apiError: 'max_output_tokens',
    })
  }
  break
}
```

> **注意直接突变**: 代码注释（行 2236-2241）解释了为什么用 `lastMsg.message.usage = usage` 而不是对象替换——因为 transcript 写入队列持有 `message.message` 的引用，100ms 一次懒刷新。对象替换会断开引用，导致写入的是旧值。

### 4.7 透传 StreamEvent

在 `switch` 语句之后，**每个事件**都被包装成 `StreamEvent` yield 给调用方：

```typescript
// src/services/api/claude.ts:2299-2303
yield {
  type: 'stream_event',
  event: part,                                         // 原始 SSE 事件
  ...(part.type === 'message_start' ? { ttftMs } : undefined),  // TTFB
}
```

这意味着 UI 层同时收到两种 yield：
1. **`StreamEvent`**：用于实时更新（进度条、字符逐个显示）
2. **`AssistantMessage`**：用于消息列表和工具执行

---

## 5. Tool Use 中流累积

Tool Use 是流式处理中最复杂的部分——工具参数是 JSON 格式，但以**片段**形式到达。

### 5.1 累积过程

```
Phase 1: content_block_start → input: '' (空字符串)
Phase 2: content_block_delta × N → input += partial_json (字符串拼接)
Phase 3: content_block_stop → normalizeContentFromAPI() 一次性解析完整 JSON
         → yield AssistantMessage { tool_use: { name: 'write_to_file', input: {...} } }
```

### 5.2 为什么不用 SDK 的 partialParse？

SDK 的 `BetaMessageStream` 在每个 `input_json_delta` 上调用 `partialParse()`。对于 K 个 delta，每次 parse 耗时 O(累积长度)，总复杂度 O(K²)。Claude Code 只在 `content_block_stop` 时解析一次——O(K)。

### 5.3 normalizeContentFromAPI

```typescript
// content_block_stop 时调用
content: normalizeContentFromAPI(
  [contentBlock] as BetaContentBlock[],
  tools,
  options.agentId,
)
```

这个函数将累积的字符串 `contentBlock.input`（此时是完整 JSON 字符串）解析为结构化对象，同时处理工具名称映射等转换。

---

## 6. 错误恢复机制

### 6.1 流式空闲看门狗

```typescript
// src/services/api/claude.ts:1868-1880
const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2

// 警告定时器（45 秒）
streamIdleWarningTimer = setTimeout(() => {
  logForDebugging(`Streaming idle warning: no chunks for ${STREAM_IDLE_WARNING_MS / 1000}s`)
}, STREAM_IDLE_WARNING_MS)

// 超时定时器（90 秒）
streamIdleTimer = setTimeout(() => {
  streamIdleAborted = true
  releaseStreamResources()   // 杀死流
}, STREAM_IDLE_TIMEOUT_MS)
```

**为什么需要这个？** SDK 的 `timeout` 只覆盖初始 HTTP 请求。一旦 SSE 流建立，连接可以**无声断开**（网络问题但 TCP 未检测到），导致会话永远挂起。看门狗确保最多 90 秒就能发现。

每个 SSE 事件到达时重置看门狗：

```typescript
// src/services/api/claude.ts:1941
for await (const part of stream) {
  resetStreamIdleTimer()   // 每个事件重置
  // ...
}
```

### 6.2 停顿检测（Stall Detection）

```typescript
// src/services/api/claude.ts:1944-1966
const STALL_THRESHOLD_MS = 30_000   // 30 秒

if (lastEventTime !== null) {
  const timeSinceLastEvent = now - lastEventTime
  if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
    stallCount++
    totalStallTime += timeSinceLastEvent
    logEvent('tengu_streaming_stall', {
      stall_duration_ms: timeSinceLastEvent,
      stall_count: stallCount,
      total_stall_time_ms: totalStallTime,
      event_type: part.type,
    })
  }
}
```

与空闲看门狗的区别：
- **看门狗**: 主动杀死流（90 秒无事件 → abort）
- **停顿检测**: 被动记录（30 秒间隔 → 日志），不中止流

停顿检测的数据送入遥测系统，帮助后端团队识别性能瓶颈。

### 6.3 流验证

```typescript
// src/services/api/claude.ts:2350-2364
if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
  logEvent('tengu_stream_no_events', {
    model: options.model,
    request_id: streamRequestId ?? 'unknown',
  })
  throw new Error('Stream ended without receiving any events')
}
```

如果流结束但没收到有效数据（连 `message_start` 都没有），抛异常触发重试。

### 6.4 非流式回退

当流式请求完全失败时，Claude Code 会**自动回退到非流式模式**：

```typescript
// src/services/api/claude.ts:2469-2560
catch (streamingError) {
  const disableFallback = isEnvTruthy(
    process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
  )

  if (disableFallback) {
    throw streamingError
  }

  // 通知调用方已回退
  if (options.onStreamingFallback) {
    options.onStreamingFallback()
  }

  logEvent('tengu_streaming_fallback_to_non_streaming', {
    model, error: streamingError.name,
    fallback_cause: streamIdleAborted ? 'watchdog' : 'other',
  })

  // 用非流式模式重新发送完全相同的请求
  yield* executeNonStreamingRequest(...)
}
```

回退条件：
- 流式连接失败（网络错误）
- 空闲看门狗触发
- 流结束但无有效数据

### 6.5 max_tokens 停止原因

```typescript
// src/services/api/claude.ts:2266-2276
if (stopReason === 'max_tokens') {
  yield createAssistantAPIErrorMessage({
    content: `Claude's response exceeded the ${maxOutputTokens} output token maximum.
    To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
    apiError: 'max_output_tokens',
    error: 'max_output_tokens',
  })
}
```

当模型输出被截断时，错误消息被 yield 给 UI——用户看到提示后，查询循环会在下一轮自动让模型"继续"。

### 6.6 资源清理

```typescript
// src/services/api/claude.ts:1842-1848
function releaseStreamResources(): void {
  cleanupStream(stream)          // SDK 层清理
  stream = undefined
  if (streamResponse) {
    streamResponse.body?.cancel().catch(() => {})  // 取消 HTTP 响应体
    streamResponse = undefined
  }
}
```

三个清理触发点：
1. 空闲看门狗超时
2. `for await` 循环正常退出
3. AbortSignal 触发（用户按 ESC）

---

## 7. 运行时追踪示例

假设用户输入 `"Hello, 写一个 greet 函数"`，以下是事件流的典型追踪：

```
时间  事件类型                 数据摘要
─────────────────────────────────────────────────────────────
0ms   → API 请求发出           POST /v1/messages { stream: true }
150ms message_start            ttftMs=150, usage: { input_tokens: 1204 }
152ms content_block_start[0]   type: "thinking"
155ms content_block_delta      thinking: "用户想要一个 greet..."
225ms content_block_stop[0]    → yield AssistantMessage (thinking)
230ms content_block_start[1]   type: "text"
232ms content_block_delta ×4   text: "好的，我来为你写一个 greet 函数："
250ms content_block_stop[1]    → yield AssistantMessage (text)
255ms content_block_start[2]   type: "tool_use", name: "write_to_file"
258ms content_block_delta ×4   partial_json 累积完整 JSON
355ms content_block_stop[2]    → yield AssistantMessage (tool_use)
360ms message_delta             stop_reason: "end_turn", output_tokens: 287
362ms message_stop              流结束
─────────────────────────────────────────────────────────────
```

UI 同时收到两类 yield：`StreamEvent`（实时进度）和 `AssistantMessage`（完成的内容块）。每个 `content_block_stop` 产生一个 `AssistantMessage`，UI 可以在文本出完后立即开始工具执行。

---

## 8. 设计启发

### 8.1 流式架构的关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 流消费方式 | Raw Stream（而非 SDK 封装） | 避免 O(n²) 部分 JSON 解析 |
| yield 粒度 | 每个 content_block 结束 yield 一次 | 平衡实时性与处理简洁性 |
| 双重 yield | StreamEvent + AssistantMessage | UI 需要实时事件，逻辑层需要完整消息 |
| 错误恢复 | 回退到非流式 | 宁可慢一点也不能挂死 |
| 突变策略 | 直接突变已 yield 对象 | 避免断开 transcript 队列的引用 |

### 8.2 如果你在构建流式 LLM 消费管线

1. **不要信任流永远不会断**——始终设置空闲看门狗超时（90 秒是个好起点）。
2. **Tool Use JSON 累积用字符串拼接**，只在最后解析一次——避免 O(n²) 陷阱。
3. **双通道 yield**：一个给 UI（实时），一个给逻辑层（完整消息）。
4. **每个内容块独立 yield**——不要等 `message_stop` 才 yield 整个消息。
5. **流式失败要有 fallback**——非流式模式是最后的保障。
6. **直接突变 vs 不可变更新**——在有引用持有者的场景下（如异步写入队列），直接突变更安全。

### 8.3 性能监控要点

Claude Code 在流式管线中埋了丰富的监控点：

| 指标 | 计算方式 | 用途 |
|------|----------|------|
| TTFT (Time To First Token) | `message_start 时间 - 请求发出时间` | API 响应延迟 |
| Stall Count | 30 秒以上间隔的事件对数量 | 网络/后端稳定性 |
| Total Stall Time | 所有停顿的累积时间 | 对实际体验的影响 |
| Stream Idle Abort | 90 秒无事件 | 连接断开检测 |

---

## 延伸阅读

- [Q: 如何设计健壮的 LLM API 客户端？](01-api-client-design.md) — 流式请求的发起与重试
- [Q: 如何精确管理 token 预算？](03-token-management.md) — max_tokens 如何影响流式输出
- [Q: 如何支持多模型切换与回退？](04-model-selection.md) — 不同模型的流式行为差异
