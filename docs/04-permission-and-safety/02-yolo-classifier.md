# 如何用 AI 自动判断命令安全性？

> **核心问题**：在 auto 模式下，每次工具调用都弹出权限提示会严重打断工作流。能否用一个独立的 AI 调用来替代人工判断——让 AI 自己判断 AI 的行为是否安全？
>

---

## 1. 元问题：用 AI 评估 AI

这是 Claude Code 最具创新性的设计之一——**Meta-AI Pattern**：

```
用户提问 → Agent（主循环）决定调用工具
                ↓
         权限系统判断 → 静态规则无法决定
                ↓
         启动独立 AI 调用（分类器）
                ↓
         分类器评估：这个工具调用安全吗？
                ↓
         allow / block（附带理由）
```

这引发了一个哲学问题：**如果主 AI 可能被 prompt injection 诱导执行危险操作，用另一个 AI 来评估它是否更安全？** Claude Code 的答案是肯定的，因为：

1. 分类器有**独立的 system prompt**，不受用户对话影响
2. 分类器只看到**操作摘要**（transcript），不看完整对话
3. 分类器用**两阶段级联**降低误判率
4. 解析失败时**默认阻止**（fail-closed）

---

## 2. 分类器何时触发？

### 2.1 触发条件

```typescript
// src/utils/permissions/permissions.ts:L520-L530

// 当 hasPermissionsToUseToolInner 返回 'ask' 时：
if (
  feature('TRANSCRIPT_CLASSIFIER') &&
  (appState.toolPermissionContext.mode === 'auto' ||
   (appState.toolPermissionContext.mode === 'plan' &&
    autoModeStateModule?.isAutoModeActive()))
) {
  // → 进入 AI 分类器流程
}
```

### 2.2 安全工具白名单（跳过分类器）

```typescript
// src/utils/permissions/classifierDecision.ts:L56-98

// 这些工具 100% 安全，无需 API 调用
const AUTO_MODE_ALLOWLISTED_TOOLS = [
  // 只读工具
  'FileReadTool', 'GrepTool', 'GlobTool', 'LSPTool',
  // 元数据工具
  'TodoWriteTool', 'TaskCreateTool', 'TaskGetTool',
  // UI/协调工具
  'AskUserQuestionTool', 'EnterPlanModeTool',
  // 其他无副作用工具
  'SleepTool', 'WorkflowTool',
]

function isAutoModeAllowlistedTool(toolName: string): boolean {
  return AUTO_MODE_ALLOWLISTED_TOOLS.includes(toolName)
}
```

**注意**：Edit/Write 工具**不在**白名单中——它们由 `acceptEdits` 快速通道处理（CWD 内自动允许，CWD 外需要分类器判断）。

---

## 3. 两阶段级联架构

### 3.1 为什么需要两阶段？

单阶段分类器面临经典的精度/召回率权衡：
- **太宽松**：放过危险操作 → 安全风险
- **太严格**：频繁阻止安全操作 → 用户体验差

两阶段解决了这个问题：

```
                  Stage 1 (Fast)
                  max_tokens: 64
                  "快速初筛"
                       │
            ┌──────────┼──────────┐
            │          │          │
       block=false  block=true  解析失败
       (安全 ✅)       │          │
       立即放行     ┌───┘     ┌───┘
                    ▼         ▼
              Stage 2 (Thinking)
              max_tokens: 4096
              "深度推理"
                    │
            ┌───────┼───────┐
            │       │       │
       block=false  │  block=true
       (放行 ✅)    │  (阻止 🚫)
                    │
              解析失败
              → 默认阻止 🚫
```

### 3.2 Stage 1：快速初筛

```typescript
// src/utils/permissions/yoloClassifier.ts:L771-857

// Stage 1 配置
const stage1Opts = {
  max_tokens: 64,           // 极小 token 限制 → 快速响应
  stop_sequences: ['</block>'],  // 遇到 </block> 立即停止
  // 后缀提示："宁可阻止也不要放过"
  suffix: "\nErr on the side of blocking. <block> immediately.",
}

// 期望响应格式
// 安全：<block>no</block>
// 危险：<block>yes</block><reason>...</reason>
```

**Stage 1 的核心逻辑**：
- 如果返回 `<block>no</block>` → **立即放行**（不进入 Stage 2）
- 如果返回 `<block>yes</block>` → 进入 Stage 2 深度检查
- 如果解析失败 → 进入 Stage 2

### 3.3 Stage 2：深度推理

```typescript
// src/utils/permissions/yoloClassifier.ts:L860-940

// Stage 2 配置
const stage2Opts = {
  max_tokens: 4096,         // 充足的推理空间
  // 无 stop_sequences → 允许完整思考
  // 后缀要求链式思考
  suffix: "Think step by step with <thinking> tags...",
}

// 期望响应格式
// <thinking>Let me analyze this step by step...</thinking>
// <block>yes/no</block>
// <reason>This command modifies system files...</reason>
```

**Stage 2 的目的**：减少 Stage 1 的**假阳性**。通过扩展推理，分类器可以理解上下文从而做出更准确的判断。

### 3.4 模式配置

```typescript
// 三种模式
type TwoStageMode = 'both' | 'fast' | 'thinking'

// 'both'（默认）：两阶段级联
// 'fast'：只用 Stage 1（max_tokens 升到 256）
// 'thinking'：只用 Stage 2

// 配置来源：
// 1. GrowthBook: tengu_auto_mode_config.twoStageClassifier
// 2. 环境变量: CLAUDE_CODE_TWO_STAGE_CLASSIFIER
```

---

## 4. System Prompt 构建

### 4.1 三层模板组装

```typescript
// src/utils/permissions/yoloClassifier.ts:L484-540

function buildYoloSystemPrompt(): string {
  // 第 1 层：基础模板
  const baseTemplate = loadPromptFile('auto_mode_system_prompt.txt')
  
  // 第 2 层：权限模板（根据构建类型）
  const permissionsTemplate = isAnthropicBuild()
    ? loadPromptFile('permissions_anthropic.txt')
    : loadPromptFile('permissions_external.txt')
  
  // 将权限模板插入基础模板的 <permissions_template> 占位符
  let prompt = baseTemplate.replace('<permissions_template>', permissionsTemplate)
  
  // 第 3 层：用户自定义规则
  // 替换模板中的默认规则为用户配置
  if (settings.autoMode?.allow) {
    prompt = prompt.replace(
      /<user_allow_rules_to_replace>.*<\/user_allow_rules_to_replace>/s,
      settings.autoMode.allow
    )
  }
  if (settings.autoMode?.soft_deny) {
    prompt = prompt.replace(
      /<user_soft_deny_rules_to_replace>.*<\/user_soft_deny_rules_to_replace>/s,
      settings.autoMode.soft_deny
    )
  }
  
  return prompt
}
```

### 4.2 Prompt 内容结构

分类器的 system prompt 包含：

```
1. 角色定义："你是一个安全分类器，评估 AI agent 的工具调用是否安全"

2. 分类规则：
   - allow 规则（默认 + 用户自定义）
     "读取文件、搜索代码、在工作目录内编辑文件"
   - soft_deny 规则（需要阻止的操作）
     "修改系统配置、删除工作目录外的文件、执行网络下载"
   - environment 上下文
     "用户的操作系统、工作目录、项目类型"

3. 输出格式要求：
   <block>yes/no</block>
   <reason>为什么阻止/允许</reason>
```

### 4.3 PowerShell 特殊处理

```typescript
// L1402-1411
if (feature('POWERSHELL_AUTO_MODE')) {
  // 添加 Windows 特有的安全规则
  // Download-and-Execute → "Code from External"
  // Recursive deletion → "Irreversible Local Destruction"
  // Registry modification → "Unauthorized Persistence"
  // Start-Process -Verb RunAs → "Security Weaken"
}
```

---

## 5. Transcript 编码：分类器看到什么？

### 5.1 设计原则

分类器**不看完整对话**——只看操作摘要（transcript）。这是关键的安全决策：

```typescript
// src/utils/permissions/yoloClassifier.ts:L302-360

function buildTranscriptEntries(
  messages: Message[],
  action: TranscriptEntry,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  
  for (const msg of messages) {
    if (msg.role === 'user') {
      // ✅ 保留用户文本消息（提供意图上下文）
      entries.push({ user: msg.content })
    }
    if (msg.role === 'assistant') {
      // ✅ 保留工具调用（操作历史）
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          entries.push({ [block.name]: toAutoClassifierInput(block.input) })
        }
      }
      // ❌ 不保留 assistant 的文本回复！
      // 原因：防止 prompt injection——主 AI 的文本可能被对手控制
    }
  }
  
  return entries
}
```

### 5.2 每个工具的输入编码

```typescript
// 每个工具实现 toAutoClassifierInput() 投影安全字段

// Bash：只暴露命令，不暴露完整参数
{ "Bash": "grep -r auth src/" }

// Edit：暴露文件路径 + diff 摘要
{ "Edit": { "file_path": "src/auth.ts", "change": "add auth check" } }
```

### 5.3 JSONL Transcript 格式

```jsonl
{"user":"Refactor the auth module"}
{"Bash":"grep -r 'function auth' src/"}
{"Edit":{"file_path":"src/auth.ts","old":"...","new":"..."}}
```

### 5.4 CLAUDE.md 的缓存注入

```typescript
// L473: CLAUDE.md 也发送给分类器（提供项目上下文）
userContentBlocks.push({
  type: 'text',
  text: claudeMdContent,
  cache_control: getCacheControl({ querySource: 'auto_mode' }),
})
```

---

## 6. sideQuery 模式：并行执行

### 6.1 什么是 sideQuery？

```typescript
// src/utils/sideQuery.ts

// sideQuery 是一个轻量级 API 包装器，用于"旁路查询"
// 分类器调用独立于主循环，两者可以并行执行

type SideQueryOptions = {
  model: string
  system?: string | TextBlockParam[]
  messages: MessageParam[]
  max_tokens?: number    // 默认 1024
  maxRetries?: number    // 默认 2
  signal?: AbortSignal
  querySource: QuerySource  // 分析标签
  stop_sequences?: string[]
  temperature?: number
  thinking?: number | false
}
```

### 6.2 并行执行模式

```
主循环                          分类器
  │                               │
  ├─ 发起工具调用                  │
  ├─ 权限检查 → 需要分类器         │
  │  ├─────────────────────────→ sideQuery(stage1)
  │  │                            ├─ API 调用
  │  │   （主循环可以继续其他工作）  ├─ 解析响应
  │  │                            ├─ 如需要 → sideQuery(stage2)
  │  ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
  ├─ 收到分类结果                  │
  ├─ 执行/阻止工具调用             │
  │                               │
```

### 6.3 sideQuery 的关键特性

```typescript
// src/utils/sideQuery.ts

async function sideQuery(options: SideQueryOptions) {
  // 1. Fingerprint 归属：从第一条用户消息计算 fingerprint
  //    用于 OAuth 验证和费用归属
  
  // 2. 系统提示前缀：自动添加 CLI 归属头
  //    （skipSystemPromptPrefix: true 可跳过）
  
  // 3. 模型规范化：去除 [1m] 后缀
  
  // 4. Beta 处理：自动启用 structured outputs
  
  // 5. Prompt 缓存：遵循 GrowthBook TTL 白名单
  
  // 6. 分析日志：记录 tengu_api_success 事件
}
```

---

## 7. 决策结果与后处理

### 7.1 YoloClassifierResult 类型

```typescript
// src/types/permissions.ts

type YoloClassifierResult = {
  shouldBlock: boolean        // 核心决策
  reason: string              // 阻止/允许理由
  thinking?: string           // Stage 2 的思考过程
  unavailable?: boolean       // API 错误或超时
  transcriptTooLong?: boolean // 超出上下文窗口
  model: string               // 使用的模型
  stage?: 'fast' | 'thinking' // 哪个阶段做出决策
  
  // 遥测数据
  usage?: ClassifierUsage
  durationMs?: number
  stage1Usage?: ClassifierUsage
  stage1DurationMs?: number
  stage2Usage?: ClassifierUsage
  stage2DurationMs?: number
  stage1RequestId?: string    // API request_id（用于调试）
  stage2RequestId?: string
}
```

### 7.2 决策路由（在 permissions.ts 中）

```typescript
// src/utils/permissions/permissions.ts:L818-950

// 决策路由表
switch (true) {
  // ✅ 允许
  case !classifierResult.shouldBlock:
    return { behavior: 'allow', decisionReason: { type: 'classifier' } }

  // 🚫 阻止 + API 不可用 + fail-closed 模式
  case classifierResult.shouldBlock && classifierResult.unavailable
       && feature('tengu_iron_gate_closed'):
    return { behavior: 'deny', message: "Classifier unavailable" }

  // ⚠️ 阻止 + API 不可用 + fail-open 模式
  case classifierResult.shouldBlock && classifierResult.unavailable:
    // 降级为用户手动判断
    return originalAskDecision

  // ⚠️ 阻止 + transcript 过长
  case classifierResult.shouldBlock && classifierResult.transcriptTooLong:
    // 降级为用户手动判断（不重试，因为是确定性错误）
    return originalAskDecision

  // 🚫 阻止 + 连续拒绝超限
  case classifierResult.shouldBlock && consecutiveDenials > threshold:
    // 转为用户提示（防止 AI 拒绝循环）
    return { behavior: 'ask', ... }

  // 🚫 正常阻止
  case classifierResult.shouldBlock:
    return { behavior: 'ask', message: classifierResult.reason }
}
```

---

## 8. 连续拒绝追踪

### 8.1 问题

如果分类器反复阻止同一类操作，可能形成"拒绝循环"：

```
Agent 尝试操作 → 分类器阻止 → Agent 换个方式 → 分类器阻止 → ...
```

### 8.2 解决方案

```typescript
// src/utils/permissions/denialTracking.ts

// 跟踪连续拒绝次数
function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return { ...state, consecutiveDenials: state.consecutiveDenials + 1 }
}

// 成功时重置
function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  return { ...state, consecutiveDenials: 0 }
}

// 超过阈值时，转为用户提示（打破循环）
if (consecutiveDenials > DENIAL_THRESHOLD) {
  // 不再依赖分类器，直接让用户决定
}
```

---

## 9. XML 解析与安全

### 9.1 解析逻辑

```typescript
// src/utils/permissions/yoloClassifier.ts:L578-604

function parseXmlBlock(text: string): boolean | null {
  // 1. 先移除 <thinking> 标签（防止注入）
  const cleaned = text.replace(/<thinking>.*?<\/thinking>/gs, '')
  
  // 2. 提取 <block>yes/no</block>
  const match = cleaned.match(/<block>\s*(yes|no)\s*<\/block>/)
  if (!match) return null  // 解析失败
  
  return match[1] === 'yes'  // yes = 应该阻止
}

function parseXmlReason(text: string): string {
  const match = text.match(/<reason>(.*?)<\/reason>/s)
  return match?.[1]?.trim() ?? ''
}
```

### 9.2 为什么移除 thinking 标签？

防止**间接 prompt injection**：如果主 AI 在工具输出中嵌入了 `<thinking>` 标签，可能影响分类器的解析。

### 9.3 fail-closed 原则

```
解析失败 → 默认阻止
API 错误 → 默认阻止（iron_gate_closed 模式）
超时 → 默认阻止
```

这确保了分类器**永远不会因为自身故障而放过危险操作**。

---

## 10. Thinking 模型适配

```typescript
// src/utils/permissions/yoloClassifier.ts:L683-693

function getClassifierThinkingConfig() {
  // 某些模型（如 Anthropic 内部模型）强制开启 thinking
  // → 不能传 thinking: false（API 会报错）
  // → 改为增加 2048 tokens headroom
  
  if (model.alwaysOnThinking) {
    return { thinking: undefined, tokensPadding: 2048 }
  }
  
  // 默认模型：关闭 thinking（浪费 tokens）
  return { thinking: false, tokensPadding: 0 }
}
```

---

## 11. Prompt 缓存优化

### 11.1 两阶段的缓存共享

```typescript
// L1094-1106

// Stage 1 和 Stage 2 共享相同的前缀：
// system prompt + CLAUDE.md + 完整 transcript
// 只有后缀（suffix）不同

// 在 action 块边界设置缓存断点
userContentBlocks.push({
  type: 'text',
  text: actionCompact,
  cache_control: getCacheControl({ querySource: 'auto_mode' }),
})

// 效果：Stage 2 保证命中 Stage 1 的缓存前缀
// → 减少 ~50% 的 API 延迟和成本
```

### 11.2 CLAUDE.md 缓存

```typescript
// L473
// CLAUDE.md 也设置缓存断点
// → 跨多次分类器调用复用 CLAUDE.md 的缓存
```

---

## 12. 分析遥测

### 12.1 tengu_auto_mode_decision 事件

```typescript
// L733-812: 每次分类决策都记录详细遥测

{
  // 决策结果
  decision: 'allowed' | 'blocked' | 'unavailable',
  
  // 延迟
  durationMs: 245,
  
  // Token 使用量（分阶段）
  stage1InputTokens: 150,
  stage1OutputTokens: 8,
  stage2InputTokens: 150,
  stage2OutputTokens: 180,
  
  // 缓存命中率
  cacheReadInputTokens: 1500,
  cacheCreationInputTokens: 50,
  
  // 成本
  classifierCostUSD: 0.0023,
  
  // 开销比
  classifierTokensRatio: 0.15,  // 分类器 tokens / 主循环 tokens
  
  // 连续拒绝追踪
  consecutiveDenials: 2,
  totalDenials: 5,
}
```

### 12.2 tengu_auto_mode_outcome 事件

```typescript
// L1425-1455: 分类器调用结果

{
  outcome: 'success' | 'parse_failure' | 'interrupted' | 'error' | 'transcript_too_long',
  classifierModel: 'claude-opus-4-1-20250805',
  classifierType: 'xml_2stage' | 'xml_fast' | 'xml_thinking',
  failureKind: 'no_tool_use' | 'invalid_schema',
  durationMs: 450,
}
```

### 12.3 上下文发散追踪

```typescript
// L1068-1092: 监控分类器上下文增长

// 比较主循环 tokens vs 分类器 transcript
// 如果 ratio > 1.0，说明分类器上下文增长失控
// auto-compact 无法拯救（分类器有独立的上下文）
```

---

## 13. CLI 调试命令

```typescript
// src/cli/handlers/autoMode.ts

// 查看默认分类规则
// $ claude auto-mode defaults
autoModeDefaultsHandler()

// 查看生效配置（用户 + 默认合并）
// $ claude auto-mode config
autoModeConfigHandler()

// 让 AI 审查用户的自定义规则
// $ claude auto-mode critique
autoModeCritiqueHandler()
// → 发送完整 system prompt + 用户规则给模型
// → 模型审查规则的清晰度、完整性、冲突
```

---

## 14. UI 集成

### 14.1 分类器审批显示

```typescript
// src/utils/classifierApprovals.ts

// 当分类器允许操作时，UI 显示理由
setYoloClassifierApproval(toolUseID, reason)
// → "Approved by auto-mode classifier: Read-only operation in project directory"

// 分类器检查中的 spinner
setClassifierChecking(toolUseID)   // 显示旋转动画
clearClassifierChecking(toolUseID) // 检查完成
```

---

## 15. 错误转储基础设施

```typescript
// L153-250: Ant-only 调试功能

// 环境变量 CLAUDE_CODE_DUMP_AUTO_MODE 启用时：
// 错误转储到 ~/.cache/claude/auto-mode-classifier-errors/{sessionId}.txt
// 完整请求/响应转储到 ~/.cache/claude/auto-mode/{timestamp}.{stage}.{req,res}.json

// 包含在 /share 输出中，方便用户报告问题
```

---

## 16. 设计分析

### 16.1 两阶段级联的精妙之处

```
                         全部操作
                            │
                     ┌──────┴──────┐
                     │             │
                 明显安全        不确定/可能危险
                 (~70%)           (~30%)
                     │             │
              Stage 1 放行    Stage 2 深度推理
              延迟: ~200ms         │
                           ┌──────┴──────┐
                           │             │
                       实际安全        真正危险
                       (~20%)         (~10%)
                           │             │
                     Stage 2 放行    Stage 2 阻止
                     延迟: ~1200ms   延迟: ~1200ms
```

**效果**：70% 的操作只需 ~200ms，只有 30% 需要 ~1200ms 的深度推理。

### 16.2 为什么不用工具调用（tool_use）而用 XML？

早期版本用了 tool_use 格式，但发现：
- XML 格式更容易控制输出长度（通过 `</block>` stop sequence）
- XML 解析更简单、更可靠
- 两阶段共享缓存更自然

### 16.3 Meta-AI 模式的局限性

1. **成本**：每次工具调用额外的 API 费用
2. **延迟**：即使 Stage 1 也需要 ~200ms
3. **一致性**：分类器可能与主 AI 的意图不一致
4. **递归风险**：如果分类器本身被 injection，会产生安全盲点

Claude Code 通过以下措施缓解：
- 白名单跳过安全工具（减少 API 调用）
- Prompt 缓存（降低成本）
- fail-closed（保守策略）
- 连续拒绝追踪（防止死循环）

---

## 17. 示例决策

### 允许（安全操作）

```json
{
  "shouldBlock": false,
  "reason": "Allowed by fast classifier",
  "stage": "fast",
  "durationMs": 245
}
```

### 阻止（危险操作 + 深度推理）

```json
{
  "shouldBlock": true,
  "reason": "This command modifies system configuration in /etc",
  "thinking": "User asked to edit /etc/hosts. This is a system file...",
  "stage": "thinking",
  "stage1DurationMs": 245,
  "stage2DurationMs": 1200,
  "durationMs": 1445
}
```

### 不可用（API 错误 + fail-closed）

```json
{
  "shouldBlock": true,
  "reason": "Classifier unavailable - blocking for safety",
  "unavailable": true
}
```

---

## 19. 思考题

1. **分类器和主 AI 用同一个模型合适吗？** 理论上分类器应该用更保守的模型（避免"自己评价自己"的偏差）。Claude Code 支持通过 `autoModeConfig.model` 配置不同模型。

2. **两阶段的阈值如何确定？** Stage 1 的 64 tokens 足以输出 `<block>yes/no</block>`。如果只有一个阶段（`fast` 模式），上限提升到 256 tokens 以容纳简短理由。

3. **如果对手知道分类器的 system prompt？** 理论上可以构造绕过分类器的输入。但因为分类器不看 assistant 文本（只看 transcript），prompt injection 的攻击面大幅缩小。

4. **成本开销是否值得？** 遥测显示 `classifierTokensRatio` 通常在 0.1-0.2 之间（主循环 tokens 的 10-20%）。考虑到免去了频繁的人工确认，这个成本是合理的。
