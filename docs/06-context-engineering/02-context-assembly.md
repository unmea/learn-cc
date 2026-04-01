# 每次 API 调用前，上下文是如何组装的？

> **深度学习笔记**
>

---

## Q1: 上下文组装的总体流程是什么？

**A:** 每次 API 调用前，上下文经历 **6 个阶段** 的组装和变换：

```
用户发送消息
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 1: 消息预处理 & 多层压缩              │
│  snip → microcompact → context collapse      │
│  → auto compact                              │
├─────────────────────────────────────────────┤
│  Stage 2: 系统提示词组装                     │
│  systemPrompt + systemContext                │
├─────────────────────────────────────────────┤
│  Stage 3: 工具 Schema 生成                   │
│  Zod → JSON Schema + description             │
├─────────────────────────────────────────────┤
│  Stage 4: 消息规范化                         │
│  过滤虚拟消息 → 修复配对 → 去除无效字段      │
├─────────────────────────────────────────────┤
│  Stage 5: 用户上下文注入                     │
│  prependUserContext (as <system-reminder>)    │
├─────────────────────────────────────────────┤
│  Stage 6: 缓存断点 & 最终请求               │
│  addCacheBreakpoints → 发送 API 请求         │
└─────────────────────────────────────────────┘
```

这个流程在 `queryLoop()` 函数中编排，每轮迭代（模型每次响应后）都会重新执行。

---

## Q2: queryLoop 的入口参数长什么样？

**A:** `QueryParams` 定义了进入查询循环所需的全部上下文：

```typescript
// src/query.ts:181-199
export type QueryParams = {
  messages: Message[]                    // 对话历史
  systemPrompt: SystemPrompt             // 系统提示词（string[]）
  userContext: { [k: string]: string }   // 用户上下文（KV 对）
  systemContext: { [k: string]: string } // 系统上下文（KV 对）
  canUseTool: CanUseToolFn              // 工具权限检查函数
  toolUseContext: ToolUseContext         // 工具执行上下文
  fallbackModel?: string                 // 后备模型
  querySource: QuerySource               // 来源标识
  maxOutputTokensOverride?: number       // 输出 token 上限覆盖
  maxTurns?: number                      // 最大对话轮次
  skipCacheWrite?: boolean               // 跳过缓存写入
  taskBudget?: { total: number }         // 任务 token 预算
}
```

**三种上下文的区别：**

| 上下文类型 | 注入位置 | 格式 | 用途 |
|-----------|---------|------|------|
| `systemPrompt` | API `system` 参数 | `string[]` | 静态行为规则 |
| `systemContext` | 追加到系统提示词末尾 | `key: value` 键值对 | 模型能力等元信息 |
| `userContext` | 作为第一条用户消息 | `<system-reminder>` 标签包裹 | 运行时环境数据（CWD、Git、文件等） |

---

## Q3: Stage 1 — 消息预处理和压缩是怎么工作的？

**A:** 消息在发送 API 前经历**四层渐进式压缩**。每层都在上一层基础上操作：

```typescript
// src/query.ts:365-468

// 第 0 步：获取压缩边界之后的消息
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

// 第 0.5 步：工具结果预算（per-message 大小限制）
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records => void recordContentReplacement(...) : undefined,
  new Set(tools.filter(t => !Number.isFinite(t.maxResultSizeChars)).map(t => t.name)),
)

// 第 1 步：Snip Compact（历史裁剪）
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
}

// 第 2 步：Microcompact（工具结果缓存编辑）
const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages

// 第 3 步：Context Collapse（渐进式摘要替换）
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}

// 第 4 步：Auto Compact（完整摘要化）
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages },
  querySource,
  tracking,
  snipTokensFreed,
)
```

### 四层压缩对比

```
┌─────────────────┬─────────────┬──────────────┬──────────────┐
│     策略        │   成本      │  信息损失    │  触发条件    │
├─────────────────┼─────────────┼──────────────┼──────────────┤
│ Snip            │  零成本     │  高（裁剪）  │  feature gate│
│ Microcompact    │  零成本     │  中（清内容）│  每轮执行    │
│ Context Collapse│  低API成本  │  低（渐进）  │  feature gate│
│ Auto Compact    │  高API成本  │  中（摘要化）│  token 阈值  │
└─────────────────┴─────────────┴──────────────┴──────────────┘
```

**执行顺序很重要：**
- Snip 在 Microcompact 之前 → snip 释放的 token 传给 autocompact 阈值检查
- Microcompact 在 Autocompact 之前 → 如果 MC 释放足够 token，可能避免 autocompact
- Context Collapse 在 Autocompact 之前 → collapse 可能让 autocompact 变成 no-op

---

## Q4: Stage 2 — 系统提示词是怎么和系统上下文合并的？

**A:** 通过 `appendSystemContext()` 将系统上下文追加到系统提示词末尾：

```typescript
// src/query.ts:449-451
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)

// src/utils/api.ts:437-447
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

**结果示例：**

```
[
  "You are an interactive agent...",           // intro
  "# System\n - All text you output...",       // system
  "# Doing tasks\n - The user will...",        // tasks
  ...                                          // 更多 sections
  "model_capabilities: extended_thinking\n"    // systemContext 追加
  + "features: tools,mcp"
]
```

---

## Q5: Stage 3 — 工具 Schema 怎么从 Zod 变成 JSON Schema？

**A:** 每个工具用 Zod 定义输入参数，通过 `zodToJsonSchema()` 转换为 JSON Schema 7，再通过 `toolToAPISchema()` 包装成 API 格式。

### 转换链

```
工具定义 (Tool)
├─ name: string                    // "Read"
├─ inputSchema: z.object({...})    // Zod v4 schema
├─ prompt: async () => string      // 描述生成函数
└─ strict?: boolean                // 是否严格模式

       ↓ zodToJsonSchema()

JSON Schema 7
{
  type: "object",
  properties: {
    file_path: { type: "string", description: "..." },
    offset: { type: "number" },
    limit: { type: "number" }
  },
  required: ["file_path"]
}

       ↓ toolToAPISchema()

API Tool Schema
{
  name: "Read",
  description: "Read the contents of a file...",
  input_schema: { ... },              // JSON Schema
  strict: true,                        // 可选
  eager_input_streaming: true,         // 可选：流式参数
  defer_loading: true,                 // 可选：延迟加载
  cache_control: { type: 'ephemeral' } // 可选：缓存标记
}
```

### Zod 转换的缓存策略

```typescript
// src/utils/zodToJsonSchema.ts
import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  // WeakMap 缓存——按 Zod schema 对象 identity 查找
  // 每轮约 60-250 次工具转换，缓存对性能至关重要
  const hit = cache.get(schema)
  if (hit) return hit

  const result = toJSONSchema(schema) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
```

### 工具 Schema 的完整缓存

```typescript
// src/utils/api.ts:119-260
export async function toolToAPISchema(
  tool: Tool,
  options: { ... }
): Promise<BetaToolUnion> {
  // 两级缓存：
  // 1. 内层：base schema（name + description + input_schema）→ session 级缓存
  // 2. 外层：per-request overlay（defer_loading, cache_control）→ 每次创建新对象

  const cacheKey = tool.name + (tool.inputJSONSchema ? ":" + jsonStringify(tool.inputJSONSchema) : "")
  let base = cache.get(cacheKey)

  if (!base) {
    let input_schema = (
      'inputJSONSchema' in tool && tool.inputJSONSchema
        ? tool.inputJSONSchema                    // MCP 工具直接提供 JSON Schema
        : zodToJsonSchema(tool.inputSchema)       // 内置工具从 Zod 转换
    )

    base = {
      name: tool.name,
      description: await tool.prompt({...}),      // 动态生成描述
      input_schema,
    }
    cache.set(cacheKey, base)
  }

  // Per-request overlays（不影响缓存）
  return {
    ...base,
    ...(options.deferLoading && { defer_loading: true }),
    ...(options.cacheControl && { cache_control: options.cacheControl }),
  }
}
```

---

## Q6: Stage 4 — 消息规范化的完整流程是什么？

**A:** 消息在 `claude.ts` 的 `queryModel` 中经历多步规范化：

```typescript
// src/services/api/claude.ts:1259-1301 (简化)

// 第 1 步：基础规范化
let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  // → 过滤虚拟消息（SystemMessage, ProgressMessage, TombstoneMessage）
  // → 重排 attachments（提升到 tool_result 之前）
  // → 合并连续 user 消息（Bedrock 要求）

// 第 2 步：去除工具搜索字段（如果模型不支持）
if (!useToolSearch) {
  messagesForAPI = messagesForAPI.map(msg => {
    case 'user': return stripToolReferenceBlocksFromUserMessage(msg)
    case 'assistant': return stripCallerFieldFromAssistantMessage(msg)
  })
}

// 第 3 步：修复孤立的 tool_use/tool_result 配对
messagesForAPI = ensureToolResultPairing(messagesForAPI)

// 第 4 步：去除 advisor 块（如果不支持）
if (!betas.includes(ADVISOR_BETA_HEADER)) {
  messagesForAPI = stripAdvisorBlocks(messagesForAPI)
}

// 第 5 步：限制媒体数量
messagesForAPI = stripExcessMediaItems(messagesForAPI, API_MAX_MEDIA_PER_REQUEST)
// API 最多允许 100 个媒体项
```

### normalizeMessagesForAPI 内部细节

```typescript
// src/utils/messages.ts:1989-2200+

export function normalizeMessagesForAPI(
  messages: Message[],
  tools: Tool[],
): (UserMessageParam | AssistantMessageParam)[] {
  const result: MessageParam[] = []

  for (const msg of messages) {
    // 跳过非 API 消息类型
    if (msg.type === 'system') continue
    if (msg.type === 'progress') continue
    if (msg.type === 'tombstone') continue

    if (msg.type === 'user') {
      // 将内部 UserMessage 转为 API 的 UserMessageParam
      result.push(userMessageToMessageParam(msg))
    } else if (msg.type === 'assistant') {
      // 将内部 AssistantMessage 转为 API 的 AssistantMessageParam
      result.push(assistantMessageToMessageParam(msg))
    } else if (msg.type === 'attachment') {
      // Attachment 作为 user content 块注入
      result.push(attachmentToUserMessageParam(msg))
    }
  }

  // 合并相邻的 user 消息
  return mergeAdjacentUserMessages(result)
}
```

---

## Q7: 消息格式的 user/assistant 交替和 tool_use/tool_result 配对是怎么保证的？

**A:** Anthropic API 要求严格的消息交替，Claude Code 通过 `ensureToolResultPairing()` 和合并逻辑保证。

### 消息交替规则

```
必须遵循的模式：
  user → assistant → user → assistant → user → ...

不能出现：
  user → user           ← 合并为一条
  assistant → assistant  ← 不允许
  assistant 开头        ← 必须 user 先
```

### tool_use / tool_result 配对

```
assistant: [
  { type: "text", text: "Let me read that file..." },
  { type: "tool_use", id: "call_abc", name: "Read", input: { file_path: "src/main.ts" } }
]
    ↓ 必须紧跟一条 user 消息包含对应的 tool_result
user: [
  { type: "tool_result", tool_use_id: "call_abc", content: "file contents..." }
]
```

### 修复孤立配对

```typescript
// src/utils/messages.ts:5133-5220 (简化)
export function ensureToolResultPairing(
  messages: MessageParam[],
): MessageParam[] {
  for (const assistantMsg of messages) {
    if (assistantMsg.role !== 'assistant') continue

    // 收集所有 tool_use ID
    const toolUseIds = new Set(
      assistantMsg.content
        .filter(b => b.type === 'tool_use')
        .map(b => b.id)
    )

    // 在后续 user 消息中查找匹配的 tool_result
    const nextUserMsg = findNextUserMessage(...)
    const foundResults = new Set(
      nextUserMsg?.content
        .filter(b => b.type === 'tool_result')
        .map(b => b.tool_use_id)
    )

    // 为缺失的 tool_result 插入合成错误
    for (const id of toolUseIds) {
      if (!foundResults.has(id)) {
        nextUserMsg.content.push({
          type: 'tool_result',
          tool_use_id: id,
          content: 'Error: tool execution was interrupted',
          is_error: true,
        })
      }
    }
  }
  return messages
}
```

**这种修复在什么时候发生？** 主要在 compact 之后——compact 可能删除一些消息导致 tool_use 和 tool_result 分离。修复确保 API 请求始终有效。

---

## Q8: Stage 5 — 用户上下文是怎么注入的？

**A:** `prependUserContext()` 将用户上下文包装在 `<system-reminder>` 标签中，作为第一条用户消息注入。

```typescript
// src/utils/api.ts:449-474
export function prependUserContext(
  messages: MessageParam[],
  userContext: { [k: string]: string },
): MessageParam[] {
  if (Object.keys(userContext).length === 0) return messages

  const contextContent = Object.entries(userContext)
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n\n')

  const contextMessage: UserMessageParam = {
    role: 'user',
    content: `<system-reminder>\n${contextContent}\n</system-reminder>`,
  }

  return [contextMessage, ...messages]
}
```

**用户上下文包含什么？**

```
<system-reminder>
# pwd
/Users/user/my-project

# git_status
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  modified:   src/app.ts

# recently_edited_files
src/app.ts (5 minutes ago)
src/utils.ts (12 minutes ago)
</system-reminder>
```

### 为什么用 `<system-reminder>` 而不是直接放在系统提示词中？

| 方案 | 问题 |
|------|------|
| 放在系统提示词 | 每次上下文变化都会打破 prompt cache |
| 放在用户消息中 | 只有最新的用户消息内容需要重新处理 |

用户上下文（CWD、Git 状态、最近编辑的文件）在每轮都可能变化，如果放在系统提示词中，会导致 prompt cache 频繁失效。放在用户消息中，系统提示词保持稳定，cache 命中率更高。

---

## Q9: Stage 6 — 最终 API 请求的完整结构是什么？

**A:** `queryModel` 在 `claude.ts` 中构建最终请求体：

```typescript
// src/services/api/claude.ts:1699-1729 (简化)
const request = {
  // 模型
  model: normalizeModelStringForAPI(options.model),

  // 消息（带缓存断点）
  messages: addCacheBreakpoints(
    messagesForAPI,
    enablePromptCaching,
    options.querySource,
    useCachedMC,
    consumedCacheEdits,
    consumedPinnedEdits,
    options.skipCacheWrite,
  ),

  // 系统提示词（带缓存范围标记）
  system: buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  }),

  // 工具定义
  tools: allTools,  // [...toolSchemas, ...extraToolSchemas]

  // 输出控制
  max_tokens: maxOutputTokens,
  thinking: { type: 'adaptive' },   // 或 { type: 'enabled', budget_tokens: N }

  // 可选参数
  tool_choice: options.toolChoice,       // 工具选择覆盖
  betas: betasParams,                    // Beta 功能头
  metadata: getAPIMetadata(),            // 元数据
  temperature: temperature,              // 温度（仅 thinking 关闭时）
}
```

### 请求结构可视化

```
┌─ API Request ────────────────────────────────────────┐
│                                                      │
│  model: "claude-sonnet-4-20250514"                 │
│                                                      │
│  system: [                                           │
│    { type: "text",                                   │
│      text: "You are an interactive agent...",        │
│      cache_control: { type: "ephemeral",             │
│                       scope: "global" } },           │
│    { type: "text",                                   │
│      text: "# Session guidance\n...\n# Memory\n...",│
│      cache_control: null }                           │
│  ]                                                   │
│                                                      │
│  tools: [                                            │
│    { name: "Bash", description: "...",               │
│      input_schema: {...} },                          │
│    { name: "Edit", description: "...",               │
│      input_schema: {...} },                          │
│    ...30+ tools                                      │
│  ]                                                   │
│                                                      │
│  messages: [                                         │
│    { role: "user",                                   │
│      content: "<system-reminder>..." },              │
│    { role: "user",                                   │
│      content: "请帮我编辑 src/app.ts..." },          │
│    { role: "assistant",                              │
│      content: [                                      │
│        { type: "text", text: "..." },                │
│        { type: "tool_use", id: "call_1",             │
│          name: "Read", input: {...} }                │
│      ] },                                            │
│    { role: "user",                                   │
│      content: [                                      │
│        { type: "tool_result",                        │
│          tool_use_id: "call_1",                      │
│          content: "file contents..." }               │
│      ],                                              │
│      cache_control: { type: "ephemeral" }            │
│    }                                                 │
│  ]                                                   │
│                                                      │
│  max_tokens: 16384                                   │
│  thinking: { type: "adaptive" }                      │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Q10: Token 计数是在哪里做的？用什么方法？

**A:** Token 计数在多个地方进行，核心函数是 `tokenCountWithEstimation()`。

### 核心计数函数

```typescript
// src/utils/tokens.ts:226-261
export function tokenCountWithEstimation(
  messages: readonly Message[]
): number {
  // 策略：用最后一次 API 响应的真实 token 数 + 新消息的估算

  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = getTokenUsage(message)  // 从 API 响应中提取

    if (message && usage) {
      // 处理并行 tool_use 的情况：
      // 一个 assistant 响应可能包含多个 tool_use，
      // 每个 tool_use 后面跟一个 tool_result（在 user 消息中）
      // 需要回溯到第一个同源消息
      const responseId = getAssistantMessageId(message)
      if (responseId) {
        let j = i - 1
        while (j >= 0) {
          const prior = messages[j]
          if (getAssistantMessageId(prior) === responseId) {
            i = j  // 锚定到第一个分片
          } else if (getAssistantMessageId(prior) !== undefined) {
            break
          }
          j--
        }
      }

      // 真实值 + 估算值
      return (
        getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(messages.slice(i + 1))
      )
    }
    i--
  }

  // 没有 API 响应记录：全部估算
  return roughTokenCountEstimationForMessages(messages)
}
```

### Token 计数公式

```typescript
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}
```

### 计数使用场景

```
┌────────────────────────┬───────────────────────────────────┐
│ 使用位置               │ 目的                              │
├────────────────────────┼───────────────────────────────────┤
│ shouldAutoCompact()    │ 判断是否需要 autocompact          │
│ calculateTokenWarning  │ 计算 token 预警状态               │
│ isAtBlockingLimit      │ 是否达到硬阻断限制                │
│ UI 百分比显示          │ 给用户展示上下文使用率            │
│ compact 前后对比       │ 衡量压缩效果                      │
└────────────────────────┴───────────────────────────────────┘
```

### 阻断限制检查

```typescript
// src/query.ts:628-648
// 在 API 调用前主动阻断
const { isAtBlockingLimit } = calculateTokenWarningState(
  tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
  toolUseContext.options.mainLoopModel,
)
if (isAtBlockingLimit) {
  yield createAssistantAPIErrorMessage({
    content: PROMPT_TOO_LONG_ERROR_MESSAGE,
    error: 'invalid_request',
  })
  return { reason: 'blocking_limit' }
}
```

---

## Q11: 内部消息类型有哪些？哪些会发送给 API？

**A:** Claude Code 有 7 种内部消息类型，但只有 UserMessage 和 AssistantMessage（以及 AttachmentMessage 作为 user 内容）到达 API。

```typescript
type Message =
  | UserMessage              // → API user 消息 ✅
  | AssistantMessage         // → API assistant 消息 ✅
  | AttachmentMessage        // → API user 消息内容块 ✅
  | ToolUseSummaryMessage    // → 过滤掉 ❌
  | SystemMessage            // → 过滤掉 ❌（UI 状态提示）
  | ProgressMessage          // → 过滤掉 ❌（进度指示器）
  | TombstoneMessage         // → 过滤掉 ❌（删除标记）
```

### 消息内容块类型

**Assistant 消息可以包含：**

```typescript
// assistant.content: ContentBlock[]
type ContentBlock =
  | { type: 'text', text: string }                    // 文本输出
  | { type: 'thinking', thinking: string }            // 思考过程
  | { type: 'tool_use', id: string, name: string,     // 工具调用
      input: object }
```

**User 消息可以包含：**

```typescript
// user.content: ContentBlock[]
type ContentBlock =
  | { type: 'text', text: string }                     // 用户输入
  | { type: 'tool_result', tool_use_id: string,        // 工具结果
      content: string | ContentBlock[], is_error?: boolean }
  | { type: 'image', source: { ... } }                // 图片
  | { type: 'document', source: { ... } }             // 文档
```

---

## Q12: 完整运行时示例——一个简单的 "编辑文件" 请求

**A:** 让我们追踪一个完整的请求："请把 src/app.ts 第 10 行的 `foo` 改成 `bar`"

### 第 1 轮：用户输入 → 模型决定读取文件

```
━━━ 输入 ━━━

messages: [
  { type: "user",
    content: "请把 src/app.ts 第 10 行的 foo 改成 bar" }
]

━━━ Stage 1: 压缩 ━━━

消息太短，所有压缩策略均为 no-op。

━━━ Stage 2: 系统提示词 ━━━

fullSystemPrompt = [
  "You are an interactive agent...",        // ~200 tokens
  "# System\n...",                          // ~150 tokens
  "# Doing tasks\n...",                     // ~400 tokens
  "# Executing actions with care\n...",     // ~300 tokens
  "# Using your tools\n...",               // ~200 tokens
  "# Tone and style\n...",                 // ~100 tokens
  "# Output efficiency\n...",              // ~100 tokens
  "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",     // 标记
  "# Session guidance\n...",               // ~100 tokens
  "CLAUDE.md content...",                  // ~500 tokens（视项目而定）
  "Working directory: /Users/user/project",// ~50 tokens
  ...                                      // 更多动态 sections
]
// 总计约 2000-4000 tokens

━━━ Stage 3: 工具 Schema ━━━

tools = [
  { name: "Bash", description: "Execute a bash command...",
    input_schema: { type: "object", properties: { command: {...}, timeout: {...} } } },
  { name: "Edit", description: "Edit a file with a search-and-replace...",
    input_schema: { type: "object", properties: { file_path: {...}, old_string: {...}, new_string: {...} } } },
  { name: "Glob", ... },
  { name: "Grep", ... },
  { name: "Read", description: "Read the contents of a file...",
    input_schema: { type: "object", properties: { file_path: {...}, offset: {...}, limit: {...} } } },
  { name: "Write", ... },
  ...  // 30+ 工具
]
// 约 3000-5000 tokens

━━━ Stage 4: 消息规范化 ━━━

messagesForAPI = [
  { role: "user", content: "请把 src/app.ts 第 10 行的 foo 改成 bar" }
]

━━━ Stage 5: 用户上下文注入 ━━━

messagesForAPI = [
  { role: "user",
    content: "<system-reminder>\n# pwd\n/Users/user/project\n# git_status\n...\n</system-reminder>" },
  { role: "user", content: "请把 src/app.ts 第 10 行的 foo 改成 bar" }
]
// → 合并为一条 user 消息（API 要求交替）
messagesForAPI = [
  { role: "user",
    content: [
      { type: "text", text: "<system-reminder>\n..." },
      { type: "text", text: "请把 src/app.ts 第 10 行的 foo 改成 bar" }
    ] }
]

━━━ Stage 6: API 请求 ━━━

POST /v1/messages
{
  model: "claude-sonnet-4-20250514",
  system: [...],  // 系统提示词块
  tools: [...],   // 工具 schema
  messages: [{ role: "user", content: [...] }],
  max_tokens: 16384,
  thinking: { type: "adaptive" }
}
```

### 模型响应：决定先读取文件

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "让我先看一下这个文件的内容。" },
    { "type": "tool_use", "id": "call_read_1",
      "name": "Read",
      "input": { "file_path": "src/app.ts" } }
  ]
}
```

### 第 2 轮：工具结果 → 模型执行编辑

```
━━━ 新的消息状态 ━━━

messages = [
  { type: "user",
    content: "请把 src/app.ts 第 10 行的 foo 改成 bar" },
  { type: "assistant",
    content: [
      { type: "text", text: "让我先看一下这个文件的内容。" },
      { type: "tool_use", id: "call_read_1", name: "Read", input: {...} }
    ] },
  { type: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_read_1",
        content: "1. import express...\n2. ...\n10. const foo = 42;\n..." }
    ] }
]

━━━ 经过 6 个 Stage 后的 API 请求 ━━━

messages: [
  { role: "user", content: "<system-reminder>...</system-reminder>\n请把..." },
  { role: "assistant", content: [text + tool_use] },
  { role: "user", content: [tool_result],
    cache_control: { type: "ephemeral" } }  // ← 缓存断点在最后一条消息
]
```

### 模型响应：执行编辑

```json
{
  "role": "assistant",
  "content": [
    { "type": "tool_use", "id": "call_edit_1",
      "name": "Edit",
      "input": {
        "file_path": "src/app.ts",
        "old_string": "const foo = 42;",
        "new_string": "const bar = 42;"
      } }
  ]
}
```

### 第 3 轮：编辑结果 → 最终回复

```
messages 继续追加 tool_result → 模型返回文本确认

最终回复：
"已将 src/app.ts 第 10 行的 `foo` 改为 `bar`。"
```

---

## Q13: queryLoop 中的迭代控制是怎么工作的？

**A:** `queryLoop` 是一个 `AsyncGenerator`，每次 API 响应后检查是否需要继续迭代：

```typescript
// src/query.ts (简化逻辑)
async function* queryLoop(params, consumedCommandUuids) {
  let state = { messages: params.messages, ... }

  while (true) {
    // === 6 个 Stage 的上下文组装 ===

    // 调用 API
    for await (const message of deps.callModel({
      messages: prependUserContext(messagesForQuery, userContext),
      systemPrompt: fullSystemPrompt,
      ...
    })) {
      if (message.type === 'assistant') {
        yield message

        // 检查是否有 tool_use → 需要继续迭代
        const toolUseBlocks = message.content.filter(b => b.type === 'tool_use')
        if (toolUseBlocks.length > 0) {
          // 执行工具 → 生成 tool_result → 追加到 messages
          for (const toolUse of toolUseBlocks) {
            const result = await executeTool(toolUse, ...)
            state.messages.push(result)
          }
          continue  // 继续 while 循环 → 下一轮 API 调用
        } else {
          // 没有 tool_use → 对话结束
          return { reason: 'done' }
        }
      }
    }
  }
}
```

### 迭代终止条件

```
继续迭代的条件：
  1. 模型返回了 tool_use → 需要执行工具并回传结果
  2. 模型返回 stop_reason: 'max_tokens' → 可能被截断，需要继续

终止条件：
  1. 模型返回纯文本（无 tool_use）且 stop_reason: 'end_turn'
  2. 达到 maxTurns 限制
  3. 达到 blocking limit（token 超限）
  4. 用户中断
  5. API 不可恢复的错误
```

---

## Q14: context assembly 中有哪些值得注意的性能优化？

### 优化 1: 延迟加载 Tool Schema

```typescript
// 使用 defer_loading 标志延迟加载不常用的工具
...(options.deferLoading && { defer_loading: true }),
```

工具搜索（tool search）模式下，不常用的工具标记为 `defer_loading: true`，API 会在模型真正选择该工具时才发送完整 schema。

### 优化 2: 并行数据获取

```typescript
// src/constants/prompts.ts:457-461
const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
  getSkillToolCommands(cwd),
  getOutputStyleConfig(),
  computeSimpleEnvInfo(model, additionalWorkingDirectories),
])
```

多个数据源并行获取，不串行等待。

### 优化 3: Schema 两级缓存

```
Level 1: zodToJsonSchema() → WeakMap(Zod identity → JSON Schema)
Level 2: toolToAPISchema() → Map(name+hash → base schema)
```

避免每轮重复序列化 60-250 个工具 schema。

### 优化 4: 系统提示词 Section 缓存

```
Level 1: systemPromptSection → session 级缓存
Level 2: 静态 section → global prompt cache (Anthropic server)
Level 3: 动态 section → ephemeral prompt cache (5min/1h TTL)
```

### 优化 5: 消息不变性

```typescript
// src/services/api/claude.ts:623-625
// Clone array content to prevent in-place mutations
content: Array.isArray(message.message.content)
  ? [...message.message.content]  // Clone!
  : message.message.content
```

复制消息内容而非原地修改，保护 prompt cache 的前缀稳定性。

---

## 总结：上下文组装的设计哲学

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  1. 分层处理：压缩 → 提示词 → schema → 规范化 → 注入    │
│     → 每层关注单一职责                                   │
│                                                          │
│  2. 渐进式压缩：snip → MC → collapse → autocompact      │
│     → 从低成本到高成本，能不压就不压                     │
│                                                          │
│  3. Cache 优先：一切设计都考虑 prompt cache 命中率       │
│     → 不变性、排序稳定性、分区策略                       │
│                                                          │
│  4. 安全修复：消息规范化兜底配对修复                     │
│     → 确保 API 请求永远有效                              │
│                                                          │
│  5. 可观测性：queryCheckpoint 打点                       │
│     → 每个阶段都有性能追踪                               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

