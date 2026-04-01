# 对话太长怎么办？三层压缩策略详解

> **深度学习笔记**
>

---

## Q1: 为什么需要压缩？上下文窗口的硬限制是什么？

**A:** Claude 模型的上下文窗口有固定上限（如 200K tokens）。在 Agent 模式下，对话很容易超限：

```
一次典型的 "修复 bug" 任务消耗的 token：
┌─────────────────────────┬────────────────┐
│ 系统提示词              │  3,000-5,000   │
│ 工具 Schema（30+个）    │  3,000-5,000   │
│ CLAUDE.md 内容          │  500-2,000     │
│ 读取 5 个文件           │  15,000-30,000 │
│ grep/glob 搜索结果      │  5,000-10,000  │
│ 编辑操作的 diff         │  2,000-5,000   │
│ 测试输出                │  5,000-20,000  │
│ 模型的思考和回复        │  10,000-30,000 │
├─────────────────────────┼────────────────┤
│ 总计                    │  43,500-107,000│
└─────────────────────────┴────────────────┘

→ 一个稍微复杂的任务就可能用掉 50%+ 的上下文窗口
→ 多轮复杂修改可以在 10-20 轮内达到 180K+ tokens
```

Claude Code 的解决方案：**三层渐进式压缩**，从低成本到高成本依次尝试。

---

## Q2: 三层压缩策略的全景图是什么？

```
Token 使用量增长
──────────────────────────────────────────────────────►

     ┌──────────────────┐
     │  Tier 1:         │
     │  Microcompact    │  ← 每轮自动执行
     │  零 API 成本     │     清理旧工具结果
     │  快速            │
     └────────┬─────────┘
              │  如果仍然不够...
              ▼
     ┌──────────────────┐
     │  Tier 2:         │
     │  Reactive Compact│  ← API 返回 413 时触发
     │  低 API 成本     │     中途恢复
     │  被动响应        │
     └────────┬─────────┘
              │  如果仍然不够...
              ▼
     ┌──────────────────┐
     │  Tier 3:         │
     │  Auto Compact    │  ← token 超阈值时触发
     │  高 API 成本     │     完整摘要化
     │  主动预防        │
     └──────────────────┘
```

### 三层对比

| 维度 | Microcompact | Reactive Compact | Auto Compact |
|------|-------------|-------------------|-------------|
| **触发时机** | 每轮迭代 | API 返回 413 错误 | token > 阈值 |
| **API 成本** | 零 | 低（重试） | 高（摘要调用） |
| **信息损失** | 中（删工具输出） | 中（紧急压缩） | 中（摘要化） |
| **速度** | 毫秒级 | 秒级 | 秒-分钟级 |
| **可恢复性** | 内容已清理 | 部分恢复 | 完整重置 |
| **功能开关** | feature gate | feature gate | 默认开启 |

---

## Q3: Tier 1 — Microcompact 是怎么工作的？

**A:** Microcompact 通过**清理旧工具结果的内容**来释放 token。它不调用 API，只在本地修改消息内容。

### 可压缩的工具集合

```typescript
// src/services/compact/microCompact.ts:41-50
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,       // Read — 文件读取结果
  ...SHELL_TOOL_NAMES,       // Bash/Shell — 命令输出
  GREP_TOOL_NAME,            // Grep — 搜索结果
  GLOB_TOOL_NAME,            // Glob — 文件列表
  WEB_SEARCH_TOOL_NAME,      // WebSearch — 网页搜索结果
  WEB_FETCH_TOOL_NAME,       // WebFetch — 网页内容
  FILE_EDIT_TOOL_NAME,       // Edit — 编辑确认输出
  FILE_WRITE_TOOL_NAME,      // Write — 写入确认输出
])
```

**未被列入的工具（如 Agent、Task）的结果不会被清理。** 原因是这些工具的结果通常包含结构化的摘要，清理后无法恢复。

### 三条执行路径

Microcompact 有三条互斥的执行路径，按优先级排列：

```
microcompactMessages()
    │
    ├─ 路径 1: 基于时间的 Microcompact
    │  条件：上次 assistant 消息距今 > 60 分钟
    │  动作：清理所有旧工具结果（保留最近 5 个）
    │
    ├─ 路径 2: 缓存编辑 Microcompact (Ant-only)
    │  条件：主线程 + 支持的模型 + feature gate
    │  动作：通过 cache_edits API 通知服务端删除
    │
    └─ 路径 3: 不操作
       条件：以上都不满足
       动作：返回原始消息
```

### 路径 1: 基于时间的 Microcompact

```typescript
// src/services/compact/microCompact.ts:446-530 (简化)

// 触发条件：上次 assistant 消息的时间距今 > 60 分钟
// 原因：Anthropic 的 prompt cache 在 1 小时后过期
// 既然缓存已失效，清理旧内容不会影响 cache 命中率

function evaluateTimeBasedTrigger(messages: Message[]): boolean {
  const lastAssistantTime = findLastAssistantTimestamp(messages)
  const gapMinutes = (Date.now() - lastAssistantTime) / 60_000
  return gapMinutes > 60  // 默认阈值：60 分钟
}

// 清理策略：保留最近 N 个可压缩的工具结果
// src/services/compact/timeBasedMCConfig.ts
// keepRecent = 5
```

清理后的工具结果被替换为占位符：

```typescript
// src/services/compact/microCompact.ts:36
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

### 路径 2: 缓存编辑 Microcompact

```typescript
// 通过 cache_edits API 删除工具结果（不修改本地消息内容）

// 1. 按 user 消息分组工具结果
// 2. 为每组生成 cache_edits 指令
// 3. 在下次 API 调用时发送 cache_edits
// 4. 服务端在缓存层面删除内容
// 5. 实际的 token 释放在 API 响应后确认

// 优势：不修改本地消息 → prompt cache 前缀保持完整
// 劣势：需要 API 支持 cache_edits 功能
```

### 状态管理

```typescript
// microCompact.ts 导出的状态管理函数
export function consumePendingCacheEdits()    // 获取待发送的 cache edits
export function getPinnedCacheEdits()         // 获取已固定的 cache edits
export function pinCacheEdits()               // 固定新的 cache edits
export function markToolsSentToAPIState()     // 标记工具已发送
export function resetMicrocompactState()      // 清理状态（compact 后）
```

---

## Q4: Tier 2 — Reactive Compact 是如何做到中途恢复的？

**A:** 当 API 返回 413 (Prompt Too Long) 错误时，Reactive Compact 在当前对话轮次内执行紧急压缩，无需终止对话。

### 413 错误检测

```typescript
// src/services/api/errors.ts:560-573
// 两种触发方式：
// 1. Anthropic API 返回 400 + "prompt is too long"
// 2. Vertex API 返回 HTTP 413

if (error.message.toLowerCase().includes('prompt is too long')) {
  return createAssistantAPIErrorMessage({
    content: PROMPT_TOO_LONG_ERROR_MESSAGE,
    error: 'invalid_request',
    errorDetails: error.message,  // 原始错误用于解析 token 差值
  })
}

if (error instanceof APIError && error.status === 413) {
  return createAssistantAPIErrorMessage({
    content: getRequestTooLargeErrorMessage(),
    error: 'invalid_request',
  })
}
```

### Token 差值解析

```typescript
// src/services/api/errors.ts:85-118
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  // 解析 "prompt is too long: 205000 tokens > 200000"
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

// 计算超出量，用于决定压缩力度
export function getPromptTooLongTokenGap(msg: AssistantMessage): number | undefined {
  // 返回 actual - limit（超出了多少 token）
}
```

### 恢复流程（query.ts 中的实现）

```typescript
// src/query.ts:1062-1183 (简化)

// 检测是否有被扣留的 413 错误
const isWithheld413 =
  lastMessage?.type === 'assistant' &&
  lastMessage.isApiErrorMessage &&
  isPromptTooLongMessage(lastMessage)

if (isWithheld413) {
  // 第 1 步：尝试 Context Collapse Drain
  // 如果有已暂存的 collapse 可以释放
  if (feature('CONTEXT_COLLAPSE') && contextCollapse && !alreadyTriedDrain) {
    const drainResult = await contextCollapse.drainStagedCollapses(messages)
    if (drainResult.drained) {
      messagesForQuery = drainResult.messages
      continue  // 重试 API 调用
    }
  }

  // 第 2 步：尝试 Reactive Compact
  const recovered = await reactiveCompact?.tryReactiveCompact({
    hasAttempted: recoveryAttempted,
    messages: messagesForQuery,
    cacheSafeParams: { systemPrompt, userContext, tools },
  })

  if (recovered) {
    messagesForQuery = recovered.messages
    yield* recovered.yieldMessages  // 通知用户发生了压缩
    continue  // 重试 API 调用
  }

  // 第 3 步：恢复失败，暴露错误给用户
  yield lastMessage  // 显示 413 错误
  return { reason: 'prompt_too_long' }
}
```

### Reactive Compact 与 Auto Compact 的互斥

```typescript
// src/query.ts:628-635
// Reactive compact 会抑制 autocompact 的预防性检查
// 原因：它需要"接收到"真实的 413 错误来触发
// 如果 autocompact 在发送前就阻断了，reactive compact 就没有机会工作

if (reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()) {
  // 跳过 blocking limit 检查
  // 让 API 调用发出 → 收到 413 → reactive compact 处理
}
```

**注意：** Reactive Compact 是 Ant-only 的功能，在外部构建中被编译为空实现（stub）。

---

## Q5: Tier 3 — Auto Compact 的完整机制是什么？

### 触发阈值计算

```typescript
// src/services/compact/autoCompact.ts:33-91

// 有效上下文窗口 = 模型上下文窗口 - 摘要输出预留
function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,  // 20,000
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  // 环境变量覆盖（用于测试）
  const override = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (override) {
    contextWindow = Math.min(contextWindow, parseInt(override, 10))
  }

  return contextWindow - reservedTokensForSummary
}

// 自动压缩阈值 = 有效窗口 - 缓冲区
function getAutoCompactThreshold(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  return effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS  // - 13,000
}
```

### 数值常量

```typescript
// src/services/compact/autoCompact.ts:62-65
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000       // 自动压缩缓冲
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000  // 警告阈值缓冲
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000    // 错误阈值缓冲
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000      // 硬阻断限制
```

### 以 200K 上下文窗口为例

```
模型上下文窗口:  200,000 tokens
摘要输出预留:   -20,000 tokens
─────────────────────────────
有效上下文窗口:  180,000 tokens

各阈值线：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   0K   ──────────────────────────────── 180K
         │             │         │    │
         │         160K│     167K│177K│
         │         WARNING  AUTO  BLOCK
         │             │   COMPACT │
         │             │         │    │
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WARNING:     180K - 20K = 160K tokens  → UI 显示黄色警告
AUTO COMPACT: 180K - 13K = 167K tokens → 触发自动压缩
BLOCKING:     180K - 3K  = 177K tokens → 硬阻断，拒绝发送
```

### 是否触发的完整判断

```typescript
// src/services/compact/autoCompact.ts:160-239 (简化)
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,
): Promise<boolean> {
  // 抑制条件：
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) return false
  if (querySource === 'compact') return false        // 避免递归
  if (querySource === 'session_memory') return false // 避免递归
  if (/* reactive-only mode */) return false
  if (/* context-collapse enabled */) return false

  // 计算 token 使用量（减去 snip 释放的量）
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)

  return tokenCount >= threshold
}
```

### 百分比状态计算

```typescript
// src/services/compact/autoCompact.ts:93-145
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number                    // 剩余百分比
  isAboveWarningThreshold: boolean       // > WARNING (80%)
  isAboveErrorThreshold: boolean         // > ERROR (90%)
  isAboveAutoCompactThreshold: boolean   // > AUTO COMPACT
  isAtBlockingLimit: boolean             // > BLOCKING LIMIT
} {
  const threshold = isAutoCompactEnabled()
    ? getAutoCompactThreshold(model)
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= threshold - WARNING_THRESHOLD_BUFFER_TOKENS,
    isAboveErrorThreshold: tokenUsage >= threshold - ERROR_THRESHOLD_BUFFER_TOKENS,
    isAboveAutoCompactThreshold: isAutoCompactEnabled() && tokenUsage >= threshold,
    isAtBlockingLimit: tokenUsage >= getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS,
  }
}
```

---

## Q6: Auto Compact 的摘要化过程是怎样的？

**A:** Auto Compact 通过调用 Claude API 生成对话摘要，然后用摘要替换原始对话。

### 压缩流程

```
autoCompactIfNeeded()
    │
    ├─ shouldAutoCompact() → true
    │
    ├─ 尝试 Session Memory Compact（实验性）
    │  └─ 如果成功 → 返回结果
    │
    └─ 回退到完整对话压缩
       │
       ├─ compactConversation()
       │  │
       │  ├─ 构建压缩提示（prompt.ts 中的模板）
       │  ├─ 调用 queryModelWithStreaming()（用 Claude 生成摘要）
       │  ├─ 创建边界标记消息
       │  └─ 构建压缩结果
       │
       └─ buildPostCompactMessages()
          │
          └─ [边界标记, 摘要消息, 保留消息, 附件, Hook 结果]
```

### 压缩结果结构

```typescript
// src/services/compact/compact.ts:299-310
export interface CompactionResult {
  boundaryMarker: SystemMessage              // 压缩边界标记
  summaryMessages: UserMessage[]             // 模型的摘要输出
  attachments: AttachmentMessage[]           // 重新注入的附件（技能、计划等）
  hookResults: HookResultMessage[]           // 压缩后的 hook 结果
  messagesToKeep?: Message[]                 // 部分压缩时保留的消息
  userDisplayMessage?: string                // 给用户的提示
  preCompactTokenCount?: number              // 压缩前 token 数
  postCompactTokenCount?: number             // 压缩后 token 数
  truePostCompactTokenCount?: number         // 真实压缩后 token 数
  compactionUsage?: Usage                    // 压缩调用的 token 使用量
}
```

### 压缩后的消息顺序

```typescript
// src/services/compact/compact.ts:330-337
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,         // 1. 边界标记（系统消息）
    ...result.summaryMessages,     // 2. 摘要内容（用户消息格式）
    ...(result.messagesToKeep ?? []),  // 3. 保留的近期消息
    ...result.attachments,         // 4. 重新注入的附件
    ...result.hookResults,         // 5. Hook 结果
  ]
}
```

### 重要的数值常量

```typescript
// src/services/compact/compact.ts
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5      // 压缩后恢复的最大文件数
const POST_COMPACT_TOKEN_BUDGET = 50_000          // 压缩后 token 预算
const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000    // 每个文件的最大 token
const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000   // 每个技能的最大 token
const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000    // 技能总 token 预算
const MAX_COMPACT_STREAMING_RETRIES = 2            // 压缩流式重试次数
const MAX_PTL_RETRIES = 3                          // 压缩请求本身的 413 重试次数
```

---

## Q7: 边界消息（Boundary Message）是什么？

**A:** 边界消息是一个 `SystemMessage`，标记压缩发生的位置。它告诉后续逻辑"这条消息之前的内容已被压缩"。

```typescript
// src/services/compact/compact.ts:596-610
const boundaryMarker = createCompactBoundaryMessage(
  model,
  COMPACT_MAX_OUTPUT_TOKENS,
  toolUseContext.agentId,
  preDiscoveredTools,
)
```

### getMessagesAfterCompactBoundary

```typescript
// query.ts 的第一步就是获取边界之后的消息
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
```

这个函数在 REPL 的完整消息历史中找到最近的压缩边界，只返回边界之后的消息。这意味着压缩之前的原始消息虽然还在内存中（供 UI 展示），但不会发送给 API。

---

## Q8: Circuit Breaker（断路器）是怎么工作的？

**A:** 当 auto compact 连续失败 3 次后，断路器跳闸，停止继续尝试。

### 为什么需要断路器？

```typescript
// src/services/compact/autoCompact.ts:67-70
// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

**真实数据：** 在引入断路器之前，有 1,279 个会话出现了 50+ 次连续失败（最多 3,272 次），全球每天浪费约 250K 次 API 调用。

### 断路器实现

```typescript
// src/services/compact/autoCompact.ts:257-265, 334-350 (简化)

async function autoCompactIfNeeded(messages, toolUseContext, ..., tracking) {
  // 检查断路器
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }  // 跳过，不再尝试
  }

  try {
    const result = await compactConversation(messages, ...)

    // 成功 → 重置计数器
    return {
      wasCompacted: true,
      consecutiveFailures: 0,         // ← 重置！
      ...result
    }
  } catch (error) {
    // 失败 → 递增计数器
    const nextFailures = (tracking?.consecutiveFailures ?? 0) + 1

    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures`,
        { level: 'warn' },
      )
    }

    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,  // ← 递增
    }
  }
}
```

### 跟踪状态结构

```typescript
// src/services/compact/autoCompact.ts:51-60
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string                          // 每轮唯一 ID
  consecutiveFailures?: number            // 断路器计数器
}
```

**断路器的含义：** 如果上下文已经无法通过压缩恢复到阈值以下（比如系统提示词+工具 schema 就已经超限），继续重试只会浪费 API 调用。断路器跳闸后，系统回退到 reactive compact（被动处理 413 错误）。

---

## Q9: 压缩后的清理工作有哪些？

**A:** `postCompactCleanup.ts` 在压缩完成后清理各种缓存状态：

```typescript
// src/services/compact/postCompactCleanup.ts
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // 1. 清理 microcompact 状态
  resetMicrocompactState()

  // 2. 清理 context collapse 状态（如果启用）
  if (feature('CONTEXT_COLLAPSE')) {
    resetContextCollapse()
  }

  // 3. 清理用户上下文缓存（强制重新获取 CWD、Git 等）
  if (isMainThreadCompact) {
    getUserContext.cache.clear?.()
  }

  // 4. 清理 memory 文件缓存（强制重新读取 CLAUDE.md）
  if (isMainThreadCompact) {
    resetGetMemoryFilesCache('compact')
  }

  // 5. 清理系统提示词 section 缓存
  clearSystemPromptSections()

  // 6. 清理分类器批准状态
  clearClassifierApprovals()

  // 7. 清理推测性权限检查缓存
  clearSpeculativeChecks()

  // 8. 清理跟踪状态
  clearBetaTracingState()

  // 注意：不清理已调用技能内容
  // 原因：重新注入的技能数据是纯 cache_creation 收益

  // 9. 清理 session 消息缓存（UI）
  clearSessionMessagesCache()
}
```

**为什么要清理这么多？** 压缩等于"重新开始"——旧的缓存假设（用户上下文、系统提示词、权限状态）在新的上下文下可能不再有效。

---

## Q10: 完整运行时示例 — 对话从 10K 增长到 180K token

让我们模拟一个复杂任务，观察三层压缩如何依次激活：

### 阶段 1: 任务开始（10K tokens）

```
轮次 1: 用户输入 "帮我重构 auth 模块"
  系统提示词: 4,000 tokens
  工具 Schema: 4,000 tokens
  用户消息:      100 tokens
  ─────────────────────────
  总计:        ~10,000 tokens （距 167K 阈值很远）

Microcompact: no-op（没有旧工具结果可清理）
Auto Compact: no-op（远低于阈值）
```

### 阶段 2: 中期调查（80K tokens）

```
轮次 2-10: 模型读取文件、搜索代码、理解架构
  累积读取 15 个文件:    +40,000 tokens
  grep/glob 搜索:        +10,000 tokens
  模型思考和回复:        +20,000 tokens
  ─────────────────────────────
  总计:                ~80,000 tokens

Microcompact 开始工作：
  → 检测到旧的 Read 结果、Grep 结果
  → 基于时间的触发：如果距上次 > 60分钟 → 清理旧结果
  → 缓存编辑：如果 feature 启用 → 注册 cache_edits
  → 释放约 10,000-20,000 tokens
  → 实际 token: ~60,000-70,000

Auto Compact: 仍未触发（低于 167K 阈值）
```

### 阶段 3: 大量修改（140K tokens）

```
轮次 11-20: 模型修改多个文件、运行测试、修复错误
  更多文件读取/编辑:    +30,000 tokens
  测试输出（可能很长）: +20,000 tokens
  错误诊断:             +10,000 tokens
  ─────────────────────────────
  总计:              ~140,000 tokens

Microcompact 持续工作：
  → 每轮清理旧工具结果
  → 释放约 20,000-30,000 tokens
  → 实际 token: ~110,000-120,000

Auto Compact: 仍未触发（低于 167K 阈值）
但 UI 开始显示黄色警告（超过 160K WARNING 阈值的话）
```

### 阶段 4: 接近极限（170K tokens）

```
轮次 21-25: 继续修改，token 快速增长
  Microcompact 已无法跟上增长速度
  ─────────────────────────────
  总计: ~170,000 tokens（超过 167K 阈值！）

═══ Auto Compact 触发！═══

1. shouldAutoCompact() → true
2. compactConversation() 开始
   │
   ├─ 构建压缩提示：
   │  "请将以下对话历史压缩为简洁的摘要，
   │   保留所有关键决策、文件修改和待完成事项..."
   │
   ├─ 调用 Claude API 生成摘要
   │  输入: 完整对话历史
   │  输出: 压缩摘要（约 5,000-10,000 tokens）
   │
   └─ 重建消息:
      [边界标记] + [摘要] + [最近消息] + [附件]

压缩结果：
  压缩前: 170,000 tokens
  压缩后: ~25,000-35,000 tokens
  释放:   ~135,000-145,000 tokens ✅
  
  runPostCompactCleanup() → 清理所有缓存
```

### 阶段 5: 压缩后继续工作（35K → 重新增长）

```
轮次 26+: 基于摘要继续工作
  新的基线: ~25,000-35,000 tokens
  可以继续使用 ~132,000-142,000 tokens 的空间
  → 对话实质上"无限延续"

如果再次增长到 167K → 再次触发 Auto Compact
如果 Auto Compact 连续失败 3 次 → 断路器跳闸
```

### 异常分支: API 返回 413

```
如果在阶段 4 中，auto compact 被抑制（reactive 模式），
模型发送了 170K token 的请求给 API：

API 响应: 413 Prompt Too Long
  "prompt is too long: 172000 tokens > 200000"

═══ Reactive Compact 触发！═══

1. 解析 token 差值: 172000 - 200000 = -28000（实际是超限）
2. 尝试 Context Collapse Drain
3. 如果不够 → tryReactiveCompact()
4. 压缩 → 重试 API 调用
5. 如果成功 → 继续对话
6. 如果失败 → 向用户显示错误
```

---

## Q11: 为什么是三层而不是一层？如果只有一层会怎样？

### 只有 Auto Compact 的问题

```
场景：每轮都可能触发 auto compact

问题 1: API 成本高
  每次 auto compact = 一次额外的 API 调用（生成摘要）
  如果在 100K tokens 就触发 → 不必要的成本

问题 2: 信息损失
  摘要化必然丢失细节
  如果频繁触发 → 模型忘记关键上下文
  
问题 3: 延迟
  摘要生成需要 5-30 秒
  频繁触发 = 频繁中断用户体验

问题 4: 无法处理 413
  如果估算不准，实际 token 数超限
  没有 reactive 层 → 对话直接失败
```

### 只有 Microcompact 的问题

```
问题 1: 释放量有限
  只能清理工具结果内容
  如果模型输出大量思考文本 → 无法压缩

问题 2: 无摘要能力
  不会调用 API 生成摘要
  对话上下文永远只增不减

问题 3: 无法处理临界情况
  当 token 接近上限但还没超限 → 无能为力
```

### 三层协作的优雅之处

```
Microcompact (轻量、免费、每轮)
    │
    │  "尽可能多清理，推迟昂贵操作"
    │
    ▼  如果不够...
Reactive Compact (被动、低成本、兜底)
    │
    │  "已经超限了，紧急恢复"
    │
    ▼  主动预防...
Auto Compact (主动、高成本、彻底)
    │
    │  "快要超限了，生成摘要重新开始"
    │
    ▼  如果全部失败...
Circuit Breaker (保护、停止重试)
    │
    "放弃自动恢复，通知用户"
```

**核心设计原则：** 能用便宜的方法解决就不用贵的。Microcompact 零成本 → 优先执行。Auto compact 需要 API 调用 → 最后手段。

---

## Q12: 有哪些可通过环境变量控制的选项？

```
┌──────────────────────────────────────────────┬───────────────────────────┐
│ 环境变量                                     │ 用途                      │
├──────────────────────────────────────────────┼───────────────────────────┤
│ DISABLE_COMPACT=1                            │ 完全禁用压缩              │
│ DISABLE_AUTO_COMPACT=1                       │ 禁用自动压缩              │
│ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80           │ 自定义触发百分比 (0-100)  │
│ CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000       │ 自定义上下文窗口大小      │
│ CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=190000   │ 自定义硬阻断限制          │
└──────────────────────────────────────────────┴───────────────────────────┘
```

---

## Q13: Session Memory Compact 是什么？和 Auto Compact 有什么区别？

**A:** Session Memory Compact 是一种实验性的压缩策略，在 Auto Compact 之前尝试。

```typescript
// src/services/compact/sessionMemoryCompact.ts

// 与 Auto Compact 的区别：
// 1. 保留最近的消息原文（不全部摘要化）
// 2. 有更严格的 token 限制
// 3. 可以选择性保留重要片段

const SESSION_MEMORY_LIMITS = {
  minTokens: 10_000,        // 最少保留 10K tokens
  minTextBlockMessages: 5,   // 最少保留 5 条文本消息
  maxTokens: 40_000,        // 压缩后最多 40K tokens
}
```

**关系：**

```
autoCompactIfNeeded()
    │
    ├─ 先尝试 sessionMemoryCompact()
    │  └─ 成功 → 返回（比完整 compact 保留更多细节）
    │
    └─ 失败 → 回退到完整 compactConversation()
```

---

## Q14: compact 子目录的完整文件清单

```
src/services/compact/
├── autoCompact.ts              (12.9 KB) — 阈值计算、断路器、触发判断
├── compact.ts                  (60.8 KB) — 核心压缩逻辑、摘要生成
├── microCompact.ts             (19.5 KB) — 工具结果清理、缓存编辑
├── apiMicrocompact.ts          (5.0 KB)  — API 级上下文管理策略
├── sessionMemoryCompact.ts     (21.1 KB) — Session Memory 压缩
├── grouping.ts                 (2.8 KB)  — 消息按 API 轮次分组
├── prompt.ts                   (16.3 KB) — 压缩提示词模板
├── postCompactCleanup.ts       (3.8 KB)  — 压缩后清理
├── compactWarningState.ts      (693 B)   — 警告抑制状态
├── compactWarningHook.ts       (568 B)   — 警告钩子
└── timeBasedMCConfig.ts        (1.8 KB)  — 时间触发配置
```

---

## 总结：压缩系统的设计哲学

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  1. 渐进式成本：免费 → 低成本 → 高成本                    │
│     → 能用 Microcompact 解决就不用 Auto Compact            │
│                                                            │
│  2. 防御性设计：断路器 + 多层兜底                          │
│     → 连续失败自动停止，避免无限重试                       │
│                                                            │
│  3. 信息保留最大化：清理内容 > 摘要 > 截断                │
│     → 优先清理可再生的内容（工具输出），保留不可再生的      │
│                                                            │
│  4. Cache 感知：所有压缩策略都考虑 prompt cache 影响       │
│     → 时间触发（cache TTL 过期后才清理）                   │
│     → 缓存编辑（不修改消息，通过 API 通知服务端删除）      │
│                                                            │
│  5. 无限对话的幻觉：                                       │
│     "The conversation has unlimited context through         │
│      automatic summarization."                              │
│     → 系统提示词就是这么告诉模型的                         │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

