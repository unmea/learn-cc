# Q: 如何支持多模型切换和回退？


一个成熟的 AI Agent 不能只绑定一个模型——它需要支持模型选择、运行时切换、性能调优和故障回退。Claude Code 的模型管理系统覆盖了从别名解析到 1M 上下文、从 thinking 配置到 529 过载回退的完整链路。

---

## 目录

1. [模型注册表](#1-模型注册表)
2. [选择优先级链](#2-选择优先级链)
3. [模型别名系统](#3-模型别名系统)
4. [Extended Thinking 配置](#4-extended-thinking-配置)
5. [Fallback 回退策略](#5-fallback-回退策略)
6. [模型特定参数](#6-模型特定参数)
7. [/model 命令：运行时切换](#7-model-命令运行时切换)
8. [设计启发](#8-设计启发)

---

## 1. 模型注册表

### 1.1 模型配置定义

每个模型在 4 种后端（First-Party、Bedrock、Vertex、Foundry）上有不同的标识符：

```typescript
// src/utils/model/configs.ts:1-77
export type ModelConfig = Record<APIProvider, ModelName>

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6-v1',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
} as const satisfies ModelConfig
```

### 1.2 完整模型列表

```typescript
// src/utils/model/configs.ts — ALL_MODEL_CONFIGS
export const ALL_MODEL_CONFIGS = {
  haiku35:   CLAUDE_3_5_HAIKU_CONFIG,
  haiku45:   CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35:  CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37:  CLAUDE_3_7_SONNET_CONFIG,
  sonnet40:  CLAUDE_SONNET_4_CONFIG,
  sonnet45:  CLAUDE_SONNET_4_5_CONFIG,
  sonnet46:  CLAUDE_SONNET_4_6_CONFIG,
  opus40:    CLAUDE_OPUS_4_CONFIG,
  opus41:    CLAUDE_OPUS_4_1_CONFIG,
  opus45:    CLAUDE_OPUS_4_5_CONFIG,
  opus46:    CLAUDE_OPUS_4_6_CONFIG,
}
```

| 短名称 | First-Party 标识符 | 发布日期 |
|--------|-------------------|----------|
| haiku35 | `claude-3-5-haiku-20241022` | 2024-10 |
| haiku45 | `claude-haiku-4-5-20251001` | 2025-10 |
| sonnet35 | `claude-3-5-sonnet-20241022` | 2024-10 |
| sonnet37 | `claude-3-7-sonnet-20250219` | 2025-02 |
| sonnet40 | `claude-sonnet-4-20250514` | 2025-05 |
| sonnet45 | `claude-sonnet-4-5-20250929` | 2025-09 |
| sonnet46 | `claude-sonnet-4-6` | 最新 |
| opus40 | `claude-opus-4-20250514` | 2025-05 |
| opus41 | `claude-opus-4-1-20250805` | 2025-08 |
| opus45 | `claude-opus-4-5-20251101` | 2025-11 |
| opus46 | `claude-opus-4-6` | 最新 |

### 1.3 跨后端名称映射

同一个模型在不同云上的名称完全不同：

```
Claude Opus 4.6:
  First-Party:  claude-opus-4-6
  Bedrock:      us.anthropic.claude-opus-4-6-v1
  Vertex:       claude-opus-4-6
  Foundry:      claude-opus-4-6

Claude Sonnet 4:
  First-Party:  claude-sonnet-4-20250514
  Bedrock:      us.anthropic.claude-sonnet-4-20250514-v1:0
  Vertex:       claude-sonnet-4@20250514
  Foundry:      claude-sonnet-4
```

`getCanonicalName()` 函数负责将任何后端格式的名称统一为**规范短名称**（如 `claude-opus-4-6`），用于内部比较。

---

## 2. 选择优先级链

### 2.1 五级优先级

```typescript
// src/utils/model/model.ts:50-98
/**
 * Priority order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}
```

```
优先级从高到低：
──────────────────────────────────────────────────

1. /model 命令覆盖（会话级）
   └── getMainLoopModelOverride()
   └── 通过 setMainLoopModelOverride() 设置
   └── 最高优先级，立即生效

2. --model CLI 标志（启动时）
   └── options.model
   └── 命令行参数传入

3. ANTHROPIC_MODEL 环境变量
   └── process.env.ANTHROPIC_MODEL
   └── 适合 CI/CD 场景

4. 用户设置（持久化）
   └── settings.model
   └── ~/.claude/settings.json

5. 内置默认值
   └── getDefaultMainLoopModelSetting()
   └── 根据订阅类型决定
```

### 2.2 解析实现

```typescript
// src/utils/model/model.ts:61-78
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()   // /model 命令
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // 验证模型是否在允许列表中
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined   // 不允许的模型静默忽略
  }

  return specifiedModel
}
```

> **安全设计**: `isModelAllowed()` 检查确保组织管理员可以通过 `availableModels` 配置限制用户可选模型范围。非法模型不会报错，而是静默回退到默认——避免泄露模型列表信息。

### 2.3 默认模型按订阅类型

```typescript
// src/utils/model/model.ts:178-208
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // 内部用户 (ant)
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'    // Opus + 1M 上下文
    )
  }

  // Max 订阅用户
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium 订阅
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG、Enterprise、Team Standard、Pro → Sonnet
  return getDefaultSonnetModel()
}
```

| 用户类型 | 默认模型 | 上下文 |
|----------|----------|--------|
| 内部用户 (ant) | Opus 4.6 | 1M |
| Max 订阅 | Opus 4.6 | 200K/1M |
| Team Premium | Opus 4.6 | 200K/1M |
| Pro/PAYG/Enterprise | Sonnet 4.6 | 200K |

---

## 3. 模型别名系统

### 3.1 别名定义

```typescript
// src/utils/model/aliases.ts:1-25
export const MODEL_ALIASES = [
  'sonnet',        // 最新 Sonnet
  'opus',          // 最新 Opus
  'haiku',         // 最新 Haiku
  'best',          // 当前最佳模型
  'sonnet[1m]',    // 最新 Sonnet + 1M 上下文
  'opus[1m]',      // 最新 Opus + 1M 上下文
  'opusplan',      // Opus 规划模式
] as const
```

### 3.2 别名解析

```typescript
// src/utils/model/model.ts:445-506
export function parseUserSpecifiedModel(modelInput: string): ModelName {
  // 处理 [1m] 后缀
  // 解析别名为具体模型版本
  // 返回对应当前后端的模型标识符
}
```

别名解析是**动态的**——`opus` 别名今天指向 `claude-opus-4-6`，新版本发布后可能指向 `claude-opus-5-0`。

### 3.3 家族通配符

```typescript
// src/utils/model/aliases.ts:21-25
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
```

家族别名在 `availableModels` 允许列表中作为**通配符**使用：
- 允许 `opus` → 任何 Opus 版本都被允许
- 允许 `claude-opus-4-5` → 只允许这个特定版本

---

## 4. Extended Thinking 配置

### 4.1 ThinkingConfig 类型

```typescript
// src/utils/thinking.ts:10-13
export type ThinkingConfig =
  | { type: 'adaptive' }                    // 模型自动管理思考深度
  | { type: 'enabled'; budgetTokens: number } // 固定思考预算
  | { type: 'disabled' }                     // 关闭思考
```

### 4.2 默认行为

```typescript
// src/utils/thinking.ts:146-162
export function shouldEnableThinkingByDefault(): boolean {
  // 环境变量覆盖
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  // 用户设置
  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // 默认启用
  // IMPORTANT: Do not change default thinking enabled value without
  // notifying the model launch DRI and research.
  return true
}
```

> **默认启用思考** 是一个深思熟虑的决策——代码注释反复强调"不要在未通知模型团队和研究团队的情况下更改此默认值"，因为它直接影响模型质量。

### 4.3 模型思考能力检测

```typescript
// src/utils/thinking.ts:90-110
export function modelSupportsThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()

  // 1P / Foundry: 所有 Claude 4+ 模型（含 Haiku 4.5）
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }

  // 3P (Bedrock/Vertex): 仅 Opus 4+ 和 Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}
```

### 4.4 Adaptive Thinking

```typescript
// src/utils/thinking.ts:113-144
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model)

  // 仅 Opus 4.6 和 Sonnet 4.6 支持
  if (canonical.includes('opus-4-6') || canonical.includes('sonnet-4-6')) {
    return true
  }

  // 已知旧模型不支持
  if (canonical.includes('opus') || canonical.includes('sonnet') ||
      canonical.includes('haiku')) {
    return false
  }

  // 未知新模型：1P/Foundry 默认支持
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}
```

Adaptive Thinking 与固定 Budget 的区别：

```
Adaptive Thinking (type: 'adaptive'):
  └── 模型根据问题复杂度自动决定思考深度
  └── 简单问题少思考，复杂问题多思考
  └── 仅 Opus 4.6 和 Sonnet 4.6 支持

Fixed Budget (type: 'enabled', budgetTokens: N):
  └── 固定思考 token 预算
  └── 所有支持思考的模型可用
  └── budgetTokens 上限 = max_tokens - 1
```

### 4.5 CLI 控制

```typescript
// src/main.tsx — CLI 选项
.addOption(new Option('--thinking <mode>',
  'Thinking mode: enabled (equivalent to adaptive), disabled')
  .choices(['enabled', 'adaptive', 'disabled']))

.addOption(new Option('--max-thinking-tokens <tokens>',
  '[DEPRECATED. Use --thinking instead] Maximum thinking tokens')
  .argParser(Number))
```

### 4.6 Ultrathink

```typescript
// src/utils/thinking.ts:19-24
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) { return false }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}
```

用户在消息中输入 `ultrathink` 关键词可以触发超深度思考模式——当编译时 feature flag 和运行时 GrowthBook flag 同时开启时。

---

## 5. Fallback 回退策略

### 5.1 触发条件

```typescript
// src/services/api/withRetry.ts:160-168
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}
```

### 5.2 回退逻辑

```typescript
// src/services/api/withRetry.ts:326-365
// 追踪连续 529 错误
if (
  is529Error(error) &&
  (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
    (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
) {
  consecutive529Errors++
  if (consecutive529Errors >= MAX_529_RETRIES) {   // >= 3 次
    if (options.fallbackModel) {
      logEvent('tengu_api_opus_fallback_triggered', {
        original_model: options.model,
        fallback_model: options.fallbackModel,
      })
      throw new FallbackTriggeredError(
        options.model,
        options.fallbackModel,
      )
    }
  }
}
```

回退触发的**完整条件链**：

```
是否 529 错误？
  ├── 否 → 正常重试
  └── 是 → 是否允许 fallback？
        ├── FALLBACK_FOR_ALL_PRIMARY_MODELS=1 → 允许
        ├── Claude.ai 订阅用户 → 不允许
        └── 非自定义 Opus 模型 → 允许
              └── 连续 529 次数 >= 3？
                    ├── 否 → 继续重试
                    └── 是 → 有 fallback 模型？
                          ├── 否 → 继续重试
                          └── 是 → 抛出 FallbackTriggeredError
```

### 5.3 使用方式

```bash
# CLI 指定回退模型
claude --model opus --fallback-model sonnet --print "复杂任务"
```

当 Opus 过载时，自动切换到 Sonnet 继续执行——用户无感知。

### 5.4 前台查询的差异化处理

不是所有查询都会触发回退——只有**前台查询**才值得重试：

```typescript
// src/services/api/withRetry.ts:84-88
function shouldRetry529(querySource: QuerySource | undefined): boolean {
  return (
    querySource === undefined ||
    FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}
```

后台任务（标题生成、分类器、摘要）在 529 时直接放弃——减少对过载后端的压力。

---

## 6. 模型特定参数

### 6.1 上下文窗口

```typescript
// src/utils/context.ts:35-49
export function has1mContext(model: string): boolean {
  return /\[1m\]/i.test(model)
}

export function modelSupports1M(model: string): boolean {
  const canonical = getCanonicalName(model)
  // Sonnet 4+ 和 Opus 4.6 支持 1M
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6')
}
```

| 模型系列 | 默认窗口 | 支持 1M |
|----------|---------|---------|
| Haiku 3.5 / 4.5 | 200K | ❌ |
| Sonnet 3.5 / 3.7 | 200K | ❌ |
| Sonnet 4 / 4.5 / 4.6 | 200K | ✅ |
| Opus 4 / 4.1 / 4.5 | 200K | ❌ |
| Opus 4.6 | 200K | ✅ |

### 6.2 输出 Token 上限

```typescript
// src/utils/context.ts:14-25
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// 槽位预留优化
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000     // 默认上限
export const ESCALATED_MAX_TOKENS = 64_000          // 截断后升级
```

所有模型共享同一套输出 token 管理逻辑，但实际上限可能因模型能力缓存中的 `max_tokens` 字段而异。

### 6.3 Effort 级别

```typescript
// src/services/api/claude.ts:440-466
function configureEffortParams(
  effortValue,
  outputConfig,
  extraBodyParams,
  betas,
  model,
): void {
  if (!modelSupportsEffort(model)) return

  if (typeof effortValue === 'string') {
    outputConfig.effort = effortValue     // 'low' | 'medium' | 'high'
  }
}
```

Effort 级别影响模型推理深度——内部模型配置可以指定默认 effort：

```typescript
// src/utils/model/antModels.ts:4-16
export type AntModel = {
  alias: string
  model: string
  label: string
  description?: string
  defaultEffortValue?: number
  defaultEffortLevel?: EffortLevel
  contextWindow?: number
  defaultMaxTokens?: number
  upperMaxTokensLimit?: number
  alwaysOnThinking?: boolean
}
```

### 6.4 定价差异

不同模型的价格差异巨大（详见 `src/utils/modelCost.ts`）：

```
价格梯度（$/百万 token，输入/输出）：

  Haiku 3.5:        $0.80 / $4       ← 最便宜
  Haiku 4.5:        $1    / $5
  Sonnet 系列:       $3    / $15      ← 性价比之选
  Opus 4.5/4.6:      $5    / $25
  Opus 4/4.1:        $15   / $75
  Opus 4.6 快速模式:  $30   / $150     ← 最贵（6 倍标准）
```

---

## 7. /model 命令：运行时切换

### 7.1 命令定义

```
/model              → 打开交互式模型选择器
/model opus         → 直接切换到 Opus
/model sonnet[1m]   → 切换到 Sonnet + 1M 上下文
/model default      → 重置为默认模型
```

### 7.2 实现逻辑

```typescript
// src/commands/model/model.tsx

// 两种模式：
// 1. 交互式 UI (ModelPickerWrapper) — 模型选择菜单
// 2. 直接设置 (SetModelAndClose) — 从参数设置

// 验证模型可用性
if (model && !isModelAllowed(model)) {
  onDone(`Model '${model}' is not available.
  Your organization restricts model selection.`, {
    display: 'system'
  })
  return
}
```

### 7.3 状态管理

```typescript
// src/bootstrap/state.ts
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}
```

`/model` 命令设置的是**会话级覆盖**——优先级最高，但不持久化。重启 Claude Code 后恢复为配置的默认模型。

### 7.4 遥测追踪

```typescript
// src/commands/model/model.tsx:47-52
logEvent("tengu_model_command_menu", {
  action: "cancel" | "select",
  from_model: previousModel,
  to_model: newModel,
})
```

---

## 8. 设计启发

### 8.1 模型管理架构总结

```
┌────────────────────────────────────────────────┐
│                 模型管理全景                      │
├────────────────────────────────────────────────┤
│                                                │
│  别名层:  sonnet → claude-sonnet-4-6           │
│           opus[1m] → claude-opus-4-6 + 1M ctx  │
│                                                │
│  选择层:  /model > --model > env > settings    │
│           > default(按订阅类型)                 │
│                                                │
│  验证层:  isModelAllowed() 组织级限制           │
│                                                │
│  映射层:  firstParty → bedrock/vertex/foundry  │
│                                                │
│  能力层:  thinking, adaptive, effort, 1M ctx   │
│                                                │
│  回退层:  3×529 → FallbackTriggeredError       │
│                                                │
│  定价层:  MODEL_COSTS 注册表                    │
│                                                │
└────────────────────────────────────────────────┘
```

### 8.2 关键设计决策

| 决策 | 选择 | 替代方案 | 理由 |
|------|------|----------|------|
| 别名 vs 版本号 | 两者都支持 | 只用版本号 | 别名对用户友好，版本号确保确定性 |
| 默认模型按订阅 | 分层默认 | 统一默认 | 平衡成本与体验 |
| 思考默认启用 | `true` | `false` | 显著提升模型质量 |
| 回退触发 | 3 次 529 | 1 次或无 | 平衡可用性与成本 |
| 非法模型处理 | 静默忽略 | 报错 | 不泄露模型列表 |

### 8.3 如果你在设计多模型支持

1. **别名系统是必须的**——用户不应该记住 `claude-sonnet-4-6-20260115`，`sonnet` 就够了。
2. **优先级链要清晰**——运行时覆盖 > CLI 参数 > 环境变量 > 配置文件 > 默认值。
3. **能力检测要自动化**——不要硬编码"这个模型支持 X"，通过 API 或缓存的能力表查询。
4. **回退不是降级**——从 Opus 回退到 Sonnet 时，用户应该无感知（或仅有轻微提示）。
5. **思考模式默认启用**——除非你有充分的理由关闭，否则总是给模型思考空间。
6. **组织级别的模型限制**——企业客户需要控制团队可以使用哪些模型（成本控制、合规需求）。
7. **跨云后端透明**——用户说 `opus`，系统自动映射到当前后端的正确标识符。

### 8.4 模型选择决策树

```
用户场景 → 推荐模型
────────────────────────────────────────
日常编码问答        → Sonnet (默认)
复杂重构/架构决策    → Opus
快速批量操作        → Haiku
长文件/大型代码库    → Sonnet[1m] 或 Opus[1m]
CI/CD 自动化       → Sonnet + --fallback-model haiku
不限预算追求质量     → Opus 快速模式
```

---

## 延伸阅读

- [Q: 如何设计健壮的 LLM API 客户端？](01-api-client-design.md) — 不同后端的客户端初始化
- [Q: 流式响应如何变成终端实时文字？](02-streaming-architecture.md) — 模型参数在流式请求中的传递
- [Q: 如何精确管理 token 预算？](03-token-management.md) — 不同模型的上下文窗口与成本
