# Q: 如何精确管理 token 预算，避免超限又不浪费？


Token 管理是 LLM 应用的"燃料经济学"——花多了浪费钱，花少了跑不完。Claude Code 的方案涵盖了从精确计量到自动压缩、从预算分配到成本追踪的完整链路。

---

## 目录

1. [Token 预算全景](#1-token-预算全景)
2. [上下文窗口计算](#2-上下文窗口计算)
3. [Token 计数方法](#3-token-计数方法)
4. [自动压缩触发机制](#4-自动压缩触发机制)
5. [输出 Token 管理](#5-输出-token-管理)
6. [成本追踪系统](#6-成本追踪系统)
7. [Token 预算追踪器](#7-token-预算追踪器)
8. [设计启发](#8-设计启发)

---

## 1. Token 预算全景

```
┌─────────────────── 上下文窗口（200K / 1M）─────────────────────┐
│                                                                │
│  ┌──────────────┐  ┌──────────┐  ┌──────────────────────────┐  │
│  │ System Prompt │  │  Tools   │  │     对话历史 Messages     │  │
│  │  (~4K tokens) │  │ (变动)   │  │   (持续增长)              │  │
│  └──────────────┘  └──────────┘  └──────────────────────────┘  │
│                                                                │
│  ┌───────────────────────────────┐  ┌──────────────────────┐  │
│  │    输出预算 (8K-64K tokens)    │  │  预留缓冲 (13K)      │  │
│  │    max_output_tokens           │  │  AUTOCOMPACT_BUFFER  │  │
│  └───────────────────────────────┘  └──────────────────────┘  │
│                                                                │
│  ← 有效上下文 = 窗口 - max_output_tokens - buffer →           │
│                                                                │
│  当对话历史接近有效上下文边界 → 触发 Auto-Compact               │
└────────────────────────────────────────────────────────────────┘
```

### 核心常量速查

| 常量 | 值 | 位置 | 用途 |
|------|-----|------|------|
| `MODEL_CONTEXT_WINDOW_DEFAULT` | 200,000 | `context.ts:9` | 默认上下文窗口 |
| `COMPACT_MAX_OUTPUT_TOKENS` | 20,000 | `context.ts:12` | 压缩操作的输出上限 |
| `MAX_OUTPUT_TOKENS_DEFAULT` | 32,000 | `context.ts:15` | 默认最大输出 token |
| `MAX_OUTPUT_TOKENS_UPPER_LIMIT` | 64,000 | `context.ts:16` | 输出 token 硬上限 |
| `CAPPED_DEFAULT_MAX_TOKENS` | 8,000 | `context.ts:24` | 槽位预留优化的默认上限 |
| `ESCALATED_MAX_TOKENS` | 64,000 | `context.ts:25` | 被截断后重试的升级上限 |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | `autoCompact.ts:62` | 自动压缩缓冲区 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | `autoCompact.ts:63` | 警告阈值缓冲 |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | `autoCompact.ts:64` | 错误阈值缓冲 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | `autoCompact.ts:65` | 手动压缩最低缓冲 |

---

## 2. 上下文窗口计算

### 2.1 窗口大小解析

```typescript
// src/utils/context.ts:51-98
export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // 1. 环境变量覆盖（内部专用）
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // 2. [1m] 后缀 — 显式 1M 上下文
  if (has1mContext(model)) {
    return 1_000_000
  }

  // 3. 查询模型能力缓存
  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    return cap.max_input_tokens
  }

  // 4. Beta header 判断
  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }

  // 5. 默认 200K
  return MODEL_CONTEXT_WINDOW_DEFAULT
}
```

解析优先级：

```
环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS
    ↓ (未设置)
[1m] 后缀检测
    ↓ (无后缀)
模型能力缓存 (~/.claude/cache/model-capabilities.json)
    ↓ (未命中)
Beta Header 检查
    ↓ (未匹配)
默认值 200,000
```

### 2.2 1M 上下文支持

```typescript
// src/utils/context.ts:35-49
export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) { return false }
  return /\[1m\]/i.test(model)
}

export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) { return false }
  const canonical = getCanonicalName(model)
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6')
}
```

用户通过在模型名后添加 `[1m]` 后缀来启用 1M 上下文（如 `opus[1m]`、`sonnet[1m]`）。管理员可通过 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 禁用此功能（HIPAA 合规场景）。

### 2.3 有效上下文窗口

```typescript
// src/services/compact/autoCompact.ts:33-49
export function getEffectiveContextWindowSize(model: string): number {
  const contextWindow = getContextWindowForModel(model)
  const MAX_OUTPUT_TOKENS_FOR_SUMMARY = Math.min(
    getMaxOutputTokensForModel(model),
    COMPACT_MAX_OUTPUT_TOKENS,          // 20,000
  )
  return contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY
}
```

有效上下文 = 总窗口 - 为输出预留的空间：

```
200K 窗口:  有效 = 200,000 - min(8,000, 20,000) = 192,000
1M 窗口:    有效 = 1,000,000 - min(8,000, 20,000) = 992,000
```

---

## 3. Token 计数方法

Claude Code 使用**多层计数策略**，从精确到估算逐级回退。

### 3.1 从 API Usage 精确计数

```typescript
// src/utils/tokens.ts:46-53
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}
```

这是最精确的方法——直接使用 API 响应中的 `usage` 字段。包含了所有 token 类型：
- `input_tokens`: 实际发送的输入 token
- `cache_creation_input_tokens`: 写入 prompt cache 的 token
- `cache_read_input_tokens`: 从 prompt cache 读取的 token
- `output_tokens`: 模型生成的 token

### 3.2 基于上次响应 + 估算的混合计数

```typescript
// src/utils/tokens.ts:226-261
export function tokenCountWithEstimation(messages: Message[]): number
```

这是**规范的上下文大小度量函数**（代码注释称其为 "CANONICAL function"）。策略是：

1. 找到最近一次 API 响应的 `usage`
2. 在此基础上，对后续新增消息用粗略估算
3. 这样既利用了 API 的精确数据，又不需要为每条消息单独调 token 计数 API

### 3.3 粗略估算

```typescript
// src/services/tokenEstimation.ts:327-339
export function roughTokenCountEstimationForMessages(
  messages: Message[],
): number {
  // 按 4 字节/token 估算（JSON 按 2 字节/token）
}

// src/services/tokenEstimation.ts:391-435
export function roughTokenCountEstimationForBlock(block): number {
  // 不同内容类型的估算规则：
  // - text: 字符数 / 4
  // - image: 固定 2000 tokens
  // - tool_use: JSON.stringify 后字符数 / 2
  // - thinking: 字符数 / 4
}
```

| 内容类型 | 估算方法 | 精度 |
|----------|----------|------|
| 文本 | 字符数 ÷ 4 | 中等 |
| JSON/工具 | 字符数 ÷ 2 | 中等 |
| 图片 | 固定 2,000 | 粗略 |
| 思考内容 | 字符数 ÷ 4 | 中等 |

### 3.4 通过 API 精确计数（回退方案）

```typescript
// src/services/tokenEstimation.ts:140-201
export async function countMessagesTokensWithAPI(
  messages, model, signal
): Promise<number>
```

调用 Anthropic 的 `countTokens` 端点获取精确 token 数。作为最后手段使用——因为需要额外的 API 调用。

```typescript
// src/services/tokenEstimation.ts:251-325
export async function countTokensViaHaikuFallback(
  messages, model
): Promise<number>
```

如果 `countTokens` API 不可用（如第三方后端），回退到用 Haiku 模型估算。

---

## 4. 自动压缩触发机制

### 4.1 阈值计算

```typescript
// src/services/compact/autoCompact.ts:62-91
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS   // 有效窗口 - 13K

  // 环境变量覆盖（用于测试）
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}
```

以 200K 窗口为例：

```
总窗口:           200,000
有效窗口:          192,000  (200K - 8K 输出预留)
自动压缩阈值:      179,000  (192K - 13K 缓冲)
警告阈值:          159,000  (179K - 20K)
错误阈值:          159,000  (179K - 20K)
阻塞阈值:          189,000  (192K - 3K)
```

```
Token 使用量
  0                                                    200K
  ├──────────────────────────────────────────────────────┤
  │  正常区域     │ 警告 │ 自动压缩 │ 阻塞 │  输出预留  │
  │              │ 区域 │  缓冲区  │      │           │
  │              159K  179K      189K   192K         200K
```

### 4.2 警告状态计算

```typescript
// src/services/compact/autoCompact.ts:93-145
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
} {
  const threshold = getAutoCompactThreshold(model)
  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  return {
    percentLeft: ((threshold - tokenUsage) / threshold) * 100,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold: tokenUsage >= threshold,
  }
}
```

UI 根据这些状态显示不同的提示：
- **正常**: 无提示
- **警告**: 黄色提示 "Context getting long"
- **错误**: 红色提示 "Context near limit"
- **阻塞**: 阻止新请求，强制压缩

### 4.3 是否触发自动压缩

```typescript
// src/services/compact/autoCompact.ts:160-239
export function shouldAutoCompact(
  tokenUsage: number,
  model: string,
  querySource: QuerySource,
  // ...
): boolean {
  // 禁用检查
  if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) {
    return false
  }

  // 防止死循环：压缩任务本身不能触发压缩
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }

  const threshold = getAutoCompactThreshold(model)
  return tokenUsage >= threshold
}
```

### 4.4 断路器机制

```typescript
// src/services/compact/autoCompact.ts:70
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// src/services/compact/autoCompact.ts:241-351
export async function autoCompactIfNeeded(
  messages, model, ...
): Promise<CompactResult> {
  // 检查连续失败次数
  if ((state.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { compacted: false }   // 断路器打开，停止重试
  }

  // 尝试执行压缩
  try {
    // ... 执行压缩
    state.consecutiveFailures = 0   // 成功则重置
  } catch (error) {
    state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1
  }
}
```

> **为什么需要断路器？** 数据显示，1,279 个会话曾出现 50+ 次连续压缩失败（最多 3,272 次），每天浪费约 250K 次 API 调用（注释 `autoCompact.ts:68-69`）。3 次失败上限可以有效避免这种浪费。

---

## 5. 输出 Token 管理

### 5.1 输出 Token 上限解析

```typescript
// src/services/api/claude.ts — getMaxOutputTokensForModel()
export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // 槽位预留优化：默认降到 8K
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)  // 8,000
    : maxOutputTokens.default                                        // 32,000

  // 环境变量覆盖
  const envOverride = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  const capTokens = envOverride
    ? parseInt(envOverride, 10)
    : ESCALATED_MAX_TOKENS                                           // 64,000

  return Math.min(defaultTokens, capTokens)
}
```

### 5.2 槽位预留优化

数据显示 p99 输出仅 4,911 token，默认 32K/64K 会 **8-16 倍过度预留**推理资源。槽位预留策略：首次请求 `max_tokens = 8,000`，被截断时重试升级到 `64,000`。99% 的请求不超 8K，1% 多一次重试——整体资源利用率大幅提升。

### 5.3 运行时输出 Token 解析

```typescript
// src/services/api/claude.ts:1590-1594
maxOutputTokens = retryContext?.maxTokensOverride ||    // 1. 重试时的覆盖值
                  options.maxOutputTokensOverride ||    // 2. 调用方覆盖
                  getMaxOutputTokensForModel(options.model)  // 3. 模型默认
```

三级解析优先级：
1. **重试覆盖**: Context overflow 时自动计算的缩减值
2. **调用方覆盖**: 特定场景指定（如 compact 操作使用 `COMPACT_MAX_OUTPUT_TOKENS`）
3. **模型默认**: 通过上述 `getMaxOutputTokensForModel()` 计算

### 5.4 max_tokens 停止原因处理

当模型输出被截断时：

```typescript
// src/services/api/claude.ts:2266-2292
if (stopReason === 'max_tokens') {
  logEvent('tengu_max_tokens_reached', {
    max_tokens: maxOutputTokens,
  })
  yield createAssistantAPIErrorMessage({
    content: `Claude's response exceeded the ${maxOutputTokens} output token maximum.
    To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
    apiError: 'max_output_tokens',
    error: 'max_output_tokens',
  })
}

if (stopReason === 'model_context_window_exceeded') {
  logEvent('tengu_context_window_exceeded', {
    max_tokens: maxOutputTokens,
    output_tokens: usage.output_tokens,
  })
  yield createAssistantAPIErrorMessage({
    content: `The model has reached its context window limit.`,
    apiError: 'max_output_tokens',
    error: 'max_output_tokens',
  })
}
```

两种截断共用 `max_output_tokens` 恢复路径——查询循环在下一轮会让模型"继续上次中断的地方"。

### 5.5 Thinking Budget 约束

思考预算上限 = `max_tokens - 1`。支持 adaptive thinking 的模型（Opus/Sonnet 4.6）自动管理思考深度；其他模型使用固定 `budget_tokens`。

---

## 6. 成本追踪系统

### 6.1 定价模型

```typescript
// src/utils/modelCost.ts:27-88
// 所有价格单位：$/百万 token

// Sonnet 系列 (3.5, 3.7, 4, 4.5, 4.6)
COST_TIER_3_15 = {
  inputTokens: 3,          // $3/M 输入
  outputTokens: 15,         // $15/M 输出
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,  // $10/千次搜索
}

// Opus 4/4.1
COST_TIER_15_75 = {
  inputTokens: 15,          // $15/M 输入
  outputTokens: 75,          // $75/M 输出
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
}

// Opus 4.5/4.6（标准模式）
COST_TIER_5_25 = {
  inputTokens: 5,           // $5/M 输入
  outputTokens: 25,          // $25/M 输出
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
}

// Opus 4.6（快速模式）
COST_TIER_30_150 = {
  inputTokens: 30,           // $30/M 输入
  outputTokens: 150,          // $150/M 输出
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
}

// Haiku 3.5
COST_HAIKU_35 = {
  inputTokens: 0.8,          // $0.80/M 输入
  outputTokens: 4,            // $4/M 输出
}

// Haiku 4.5
COST_HAIKU_45 = {
  inputTokens: 1,            // $1/M 输入
  outputTokens: 5,            // $5/M 输出
}
```

### 6.2 成本计算公式

```typescript
// src/utils/modelCost.ts:131-142
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}
```

### 6.3 Opus 4.6 的双定价

Opus 4.6 在快速模式下价格是标准模式的 **6 倍**（输入 $30 vs $5，输出 $150 vs $25）：

```typescript
// src/utils/modelCost.ts:94-99
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150     // 快速模式
  }
  return COST_TIER_5_25         // 标准模式
}
```

### 6.4 模型成本注册表

```typescript
// src/utils/modelCost.ts:104-126
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [CLAUDE_3_5_HAIKU]:    COST_HAIKU_35,
  [CLAUDE_HAIKU_4_5]:    COST_HAIKU_45,
  [CLAUDE_3_5_V2_SONNET]: COST_TIER_3_15,
  [CLAUDE_3_7_SONNET]:   COST_TIER_3_15,
  [CLAUDE_SONNET_4]:     COST_TIER_3_15,
  [CLAUDE_SONNET_4_5]:   COST_TIER_3_15,
  [CLAUDE_SONNET_4_6]:   COST_TIER_3_15,
  [CLAUDE_OPUS_4]:       COST_TIER_15_75,
  [CLAUDE_OPUS_4_1]:     COST_TIER_15_75,
  [CLAUDE_OPUS_4_5]:     COST_TIER_5_25,
  [CLAUDE_OPUS_4_6]:     COST_TIER_5_25,    // 标准模式价格，快速模式另算
}
```

未知模型默认使用 `COST_TIER_5_25`（`modelCost.ts:89`）。

### 6.5 实时成本追踪

成本在流式响应的 `message_delta` 事件中实时更新：

```typescript
// src/services/api/claude.ts:2250-2256
const costUSDForPart = calculateUSDCost(resolvedModel, usage)
costUSD += addToTotalSessionCost(costUSDForPart, usage, options.model)
```

`addToTotalSessionCost()`（`src/cost-tracker.ts:278-323`）同时更新：模型使用量、遥测计数器（input/output/cacheRead/cacheCreation 分类型计数）。

### 6.6 每模型使用量追踪

```typescript
// src/cost-tracker.ts:250-276
type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}
```

每个模型独立追踪，最终汇总为会话级别的总成本。

---

## 7. Token 预算追踪器

### 7.1 任务级预算

```typescript
// src/query/tokenBudget.ts:13-93
type BudgetTracker = {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string,
  budget: number,
  globalTurnTokens: number,
): {
  action: 'continue' | 'stop'
  nudgeMessage?: string
  pct: number
  turnTokens: number
  budget: number
  diminishingReturns: boolean
  durationMs: number
}
```

这个追踪器用于**子 Agent 任务**——当分配了固定 token 预算时，追踪消耗进度并在接近预算时发出"收尾"提示（nudge message）。

### 7.2 每轮输出 Token 追踪

```typescript
// src/bootstrap/state.ts
let outputTokensAtTurnStart = 0

export function getOutputTokensThisTurn(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}

export function resetOutputTokensThisTurn(): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
}
```

每轮对话开始时重置，用于 UI 显示当前轮次的 token 消耗。

### 7.3 会话持久化

会话结束时，`saveCurrentSessionCosts()`（`src/bootstrap/state.ts:87-175`）将累积成本数据（总 token、每模型分解、USD 费用）持久化到项目配置中。下次启动时通过 `getStoredSessionCosts()` 恢复——状态栏的累积成本显示不会因重启而丢失。

---

## 8. 设计启发

### 8.1 Token 管理的分层架构

```
层级                 职责                    关键函数
──────────────────────────────────────────────────────────────
API 层              精确 usage 数据          getTokenCountFromUsage()
估算层              消息级粗略估算            roughTokenCountEstimation()
混合层              API数据 + 估算           tokenCountWithEstimation()
阈值层              触发压缩/警告            calculateTokenWarningState()
预算层              任务级预算控制            checkTokenBudget()
成本层              USD 费用追踪             tokensToUSDCost()
```

### 8.2 核心设计模式

| 模式 | 实现 | 收益 |
|------|------|------|
| **渐进精确** | 粗估 → API 精确 → 混合 | 平衡性能和准确度 |
| **断路器** | 3 次压缩失败 → 停止 | 防止无谓的 API 调用浪费 |
| **槽位预留** | 8K 默认 → 截断后 64K | 99% 请求省资源，1% 多一次重试 |
| **双通道追踪** | 遥测 + 持久化 | 实时监控 + 会话恢复 |
| **阈值梯度** | 警告 → 错误 → 自动压缩 → 阻塞 | 渐进式响应 |

### 8.3 如果你在设计 Token 管理系统

1. **不要每条消息都调 token 计数 API**——用上次 API 响应的 usage + 新增消息估算。
2. **设置多级阈值**——不是一刀切"满了就压缩"，而是警告 → 自动压缩 → 阻塞。
3. **断路器必不可少**——当压缩反复失败时，停止重试比无限循环好。
4. **输出 token 默认值不要太大**——大多数响应用不了 32K，默认 8K + 按需升级更高效。
5. **成本追踪要实时**——不要等会话结束才算，每个 `message_delta` 就更新。
6. **区分 5 种 token 类型**——input、output、cache_read、cache_write、web_search 各有不同价格。

### 8.4 典型场景成本估算

以 Sonnet 4.6（$3/$15 per Mtok）为例：

| 场景 | 输入 Token | 输出 Token | 缓存读取 | 估算成本 |
|------|-----------|-----------|----------|----------|
| 简单问答 | 2,000 | 500 | 0 | $0.014 |
| 代码修改（含工具） | 10,000 | 3,000 | 5,000 | $0.077 |
| 长对话压缩后继续 | 50,000 | 5,000 | 30,000 | $0.234 |
| 复杂重构任务 | 150,000 | 20,000 | 100,000 | $0.780 |

---

## 延伸阅读

- [Q: 如何设计健壮的 LLM API 客户端？](01-api-client-design.md) — max_tokens 在 API 调用中的传递
- [Q: 流式响应如何变成终端实时文字？](02-streaming-architecture.md) — message_delta 中的 usage 更新
- [Q: 对话太长怎么办？三层压缩策略](/06-context-engineering/03-compaction-strategies) — 自动压缩的具体实现
