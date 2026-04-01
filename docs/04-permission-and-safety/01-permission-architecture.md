# 如何设计一个 7 层权限系统？每层解决什么问题？

> **核心问题**：一个 AI Agent 可以执行任意工具（bash、文件编辑、网络请求），如何在「让 Agent 自由发挥」和「防止灾难性操作」之间取得平衡？
>

---

## 1. 为什么需要 7 层？

单一权限检查无法应对 AI Agent 的复杂场景。考虑这些情况：

- 企业管理员想**全局禁止**某些操作（策略层）
- 项目维护者想**项目级别**控制权限（项目配置层）
- 用户想**个人定制**权限偏好（用户配置层）
- 用户在**当前会话**临时授权某些操作（会话层）
- 工具本身有**默认安全策略**（工具默认层）
- 在自动模式下，AI 需要**智能判断**安全性（分类器层）
- 最后一道防线：**OS 沙箱**限制物理访问（沙箱层）

Claude Code 的答案是**层叠式权限架构**——7 个权限源按优先级依次检查。

---

## 2. 权限核心类型

### 2.1 PermissionRule——规则的原子单位

```typescript
// src/types/permissions.ts

// 行为：允许 / 拒绝 / 询问
type PermissionBehavior = 'allow' | 'deny' | 'ask'

// 规则值：工具名 + 可选内容模式
type PermissionRuleValue = {
  toolName: string      // 例如 "Bash", "Edit", "WebFetch"
  ruleContent?: string  // 例如 "npm test:*", "/etc/**"
}

// 完整规则：来源 + 行为 + 值
type PermissionRule = {
  source: PermissionRuleSource    // 来自哪一层
  ruleBehavior: PermissionBehavior // 允许/拒绝/询问
  ruleValue: PermissionRuleValue   // 匹配什么工具和内容
}
```

### 2.2 PermissionRuleSource——7 种规则来源

```typescript
// src/types/permissions.ts

type PermissionRuleSource =
  | 'policySettings'    // 第 1 层：企业策略服务器
  | 'flagSettings'      // 第 1.5 层：功能标志（GrowthBook）
  | 'projectSettings'   // 第 2 层：项目配置 (.claude/settings.json)
  | 'localSettings'     // 第 2.5 层：本地配置 (.claude/settings.local.json)
  | 'userSettings'      // 第 3 层：用户全局配置 (~/.claude/settings.json)
  | 'cliArg'            // 第 3.5 层：CLI 参数
  | 'command'           // 命令级别
  | 'session'           // 第 4 层：会话级别授权
```

### 2.3 ToolPermissionContext——运行时上下文

```typescript
// src/types/permissions.ts

type ToolPermissionContext = {
  readonly mode: PermissionMode       // 当前权限模式
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly isBypassPermissionsModeAvailable: boolean
  readonly shouldAvoidPermissionPrompts?: boolean
}
```

### 2.4 权限模式（PermissionMode）

```typescript
// src/types/permissions.ts

type InternalPermissionMode =
  | 'default'           // 默认：规则匹配 + 询问
  | 'acceptEdits'       // 仅自动接受编辑操作
  | 'auto'              // 自动模式：AI 分类器判断（核心创新）
  | 'bypassPermissions' // 绕过所有权限检查
  | 'dontAsk'           // 不询问 → 直接拒绝
  | 'plan'              // 计划模式
  | 'bubble'            // 上报给父级
```

---

## 3. hasPermissionsToUseTool：核心决策函数

### 3.1 函数签名

```typescript
// src/utils/permissions/permissions.ts:L473

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,           // Tool 对象（包含 name, checkPermissions 等）
  input,          // 工具输入参数
  context,        // ToolUseContext（包含 getAppState, abortController 等）
  assistantMessage,
  toolUseID,
): Promise<PermissionDecision>
```

### 3.2 决策流程全景

```
hasPermissionsToUseTool()
    │
    ├─ 调用 hasPermissionsToUseToolInner() → 核心 7 步检查
    │
    ├─ 如果 allow → 重置连续拒绝计数器 → 返回
    │
    └─ 如果 ask →
        ├─ dontAsk 模式 → 转换为 deny
        ├─ auto/plan 模式 → 调用 AI 分类器
        │   ├─ shouldBlock=false → allow
        │   ├─ shouldBlock=true + API 不可用 → deny 或 fallback
        │   ├─ shouldBlock=true + 连续拒绝超限 → 提示用户
        │   └─ shouldBlock=true → 询问用户（附带理由）
        └─ default 模式 → 询问用户
```

---

## 4. 内部决策函数：7 步检查

```typescript
// src/utils/permissions/permissions.ts:L1158

async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: { [key: string]: unknown },
  context: ToolUseContext,
): Promise<PermissionDecision>
```

### 第 1 步：全局拒绝规则检查（deny rules）

```typescript
// L1170-L1178
// 检查所有来源的 deny 规则是否匹配此工具
const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
if (denyRule) {
  return {
    behavior: 'deny',
    decisionReason: { type: 'rule', rule: denyRule },
    message: `Permission to use ${tool.name} has been denied.`,
  }
}
```

**优先级**：deny 规则**最高优先**，任何来源的 deny 规则都立即生效。

### 第 1b 步：全局询问规则检查（ask rules）

```typescript
// L1181-L1202
const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
if (askRule) {
  // 特例：如果沙箱已启用且 autoAllowBashIfSandboxed，跳过 ask
  const canSandboxAutoAllow =
    tool.name === BASH_TOOL_NAME &&
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)

  if (!canSandboxAutoAllow) {
    return { behavior: 'ask', decisionReason: { type: 'rule', rule: askRule } }
  }
  // 沙箱启用时：跳过全局 ask，让工具的 checkPermissions 处理命令级规则
}
```

### 第 1c 步：工具自身权限检查

```typescript
// L1208-L1224
let toolPermissionResult: PermissionResult = {
  behavior: 'passthrough',
  message: createPermissionRequestMessage(tool.name),
}
try {
  const parsedInput = tool.inputSchema.parse(input)
  toolPermissionResult = await tool.checkPermissions(parsedInput, context)
} catch (e) {
  if (e instanceof AbortError || e instanceof APIUserAbortError) throw e
  logError(e)
}
```

每个工具实现自己的 `checkPermissions()` 方法。例如：
- **BashTool**：检查命令是否匹配内容级 allow/deny 规则
- **EditTool**：检查文件路径是否在允许目录内
- **WebFetchTool**：检查域名是否在白名单

### 第 1d-1g 步：安全守卫

```typescript
// L1227: 工具明确拒绝 → 直接 deny
if (toolPermissionResult?.behavior === 'deny') return toolPermissionResult

// L1233: 工具需要用户交互 → 即使 bypass 模式也要 ask
if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === 'ask')
  return toolPermissionResult

// L1241: 内容级 ask 规则（如 Bash(npm publish:*)）→ bypass 模式也必须 ask
if (toolPermissionResult?.behavior === 'ask'
    && toolPermissionResult.decisionReason?.type === 'rule'
    && toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask')
  return toolPermissionResult

// L1253: 安全检查（.git/、.claude/ 等敏感路径）→ bypass 也必须 ask
if (toolPermissionResult?.behavior === 'ask'
    && toolPermissionResult.decisionReason?.type === 'safetyCheck')
  return toolPermissionResult
```

### 第 2a 步：权限模式检查

```typescript
// L1262-L1279
appState = context.getAppState() // 重新获取最新状态

const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
   appState.toolPermissionContext.isBypassPermissionsModeAvailable)

if (shouldBypassPermissions) {
  return {
    behavior: 'allow',
    updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
    decisionReason: { type: 'mode', mode: appState.toolPermissionContext.mode },
  }
}
```

### 第 2b 步：全局允许规则检查

```typescript
// L1282-L1293
const alwaysAllowedRule = toolAlwaysAllowedRule(
  appState.toolPermissionContext, tool,
)
if (alwaysAllowedRule) {
  return {
    behavior: 'allow',
    updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
    decisionReason: { type: 'rule', rule: alwaysAllowedRule },
  }
}
```

### 第 3 步：兜底——转为 ask

```typescript
// L1296-L1305
const result: PermissionDecision =
  toolPermissionResult.behavior === 'passthrough'
    ? { ...toolPermissionResult, behavior: 'ask' as const }
    : toolPermissionResult

return result
```

---

## 5. 7 层权限源详解

### 层级架构图

```
┌─────────────────────────────────────────────────┐
│ 第 1 层：策略服务器 (policySettings)             │  ← 企业 IT 管理
│  优先级最高，不可被下层覆盖                       │
├─────────────────────────────────────────────────┤
│ 第 2 层：项目配置 (projectSettings)              │  ← .claude/settings.json
│  提交到 Git，团队共享                             │
├─────────────────────────────────────────────────┤
│ 第 3 层：用户配置 (userSettings)                 │  ← ~/.claude/settings.json
│  个人全局偏好                                     │
├─────────────────────────────────────────────────┤
│ 第 4 层：会话授权 (session)                      │  ← 运行时临时授权
│  "Always allow for this session"                 │
├─────────────────────────────────────────────────┤
│ 第 5 层：工具默认 (tool.checkPermissions)        │  ← 每个工具自定义逻辑
│  BashTool 检查命令，EditTool 检查路径            │
├─────────────────────────────────────────────────┤
│ 第 6 层：AI 分类器 (YOLO Classifier)            │  ← 自动模式专用
│  独立 API 调用，判断命令安全性                    │
├─────────────────────────────────────────────────┤
│ 第 7 层：OS 沙箱 (seatbelt/bwrap/seccomp)       │  ← 最后防线
│  物理层面阻止未授权文件/网络访问                  │
└─────────────────────────────────────────────────┘
```

### 第 1 层：策略服务器（Policy Server）

**来源**：企业 MDM / 集中管理策略
**优先级**：最高——policySettings 的 deny 规则不可被任何下层覆盖
**配置路径**：由企业分发，不在本地编辑

```json
// 企业策略示例
{
  "permissions": {
    "deny": ["Bash(rm -rf:*)", "Bash(sudo:*)", "WebFetch(*.internal.corp:*)"]
  }
}
```

**特殊行为**：
- `shouldAllowManagedPermissionRulesOnly()` 为 true 时，清除所有非策略源的规则
- 策略规则不可通过 `deletePermissionRule()` 删除（会抛出异常）

### 第 2 层：项目配置

**来源**：`.claude/settings.json`（提交到 Git）
**用途**：团队共享的项目级权限

```json
{
  "permissions": {
    "allow": ["Edit", "Bash(npm test:*)", "Bash(npm run build:*)"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Bash(npm publish:*)"]
  }
}
```

### 第 3 层：用户配置

**来源**：`~/.claude/settings.json`（用户全局）
**用途**：个人偏好，跨项目生效

### 第 4 层：会话授权

**来源**：用户在权限提示时选择 "Always allow for this session"
**生命周期**：仅当前会话有效
**存储**：内存中的 `ToolPermissionContext`

### 第 5 层：工具默认检查

每个工具实现 `checkPermissions()` 方法：

```typescript
// 伪代码：BashTool.checkPermissions
async checkPermissions(input: { command: string }, context) {
  // 1. 命令是否匹配 allow 规则？ → allow
  // 2. 命令是否匹配 deny 规则？  → deny
  // 3. 是否触及敏感文件（.git/config, .bashrc 等）？ → ask (safetyCheck)
  // 4. 是否在工作目录内？ → passthrough
  // 5. 否则 → ask
}
```

### 第 6 层：AI 分类器

仅在 `auto` 模式下激活。详见 `02-yolo-classifier.md`。

### 第 7 层：OS 沙箱

操作系统级别的最终防线。详见 `03-sandbox-design.md`。

---

## 6. 规则匹配机制

### 6.1 工具名匹配

规则中的 `toolName` 直接匹配 Tool 对象的 `name` 属性：

```typescript
// 规则匹配检查
function getDenyRuleForTool(context: ToolPermissionContext, tool: Tool) {
  // 遍历所有来源的 deny 规则
  for (const source of SETTING_SOURCES) {
    const rules = context.alwaysDenyRules[source]
    if (rules) {
      for (const ruleStr of rules) {
        const ruleValue = permissionRuleValueFromString(ruleStr)
        if (ruleValue.toolName === tool.name) {
          return { source, ruleBehavior: 'deny', ruleValue }
        }
      }
    }
  }
  return null
}
```

### 6.2 内容模式匹配

`ruleContent` 支持 glob 风格的模式匹配：

```
Bash(npm test:*)       → 匹配所有 "npm test" 开头的命令
Edit(/etc/**)          → 匹配 /etc/ 下所有文件路径
WebFetch(*.github.com) → 匹配 github.com 的所有子域名
```

### 6.3 规则字符串解析

```typescript
// src/utils/permissions/permissionRuleParser.ts

// "Bash(npm test:*)" → { toolName: "Bash", ruleContent: "npm test:*" }
function permissionRuleValueFromString(s: string): PermissionRuleValue {
  const match = s.match(/^(\w+)(?:\((.+)\))?$/)
  if (!match) throw new Error(`Invalid rule: ${s}`)
  return {
    toolName: match[1],
    ruleContent: match[2],
  }
}
```

---

## 7. 运行时追踪：`bash rm -rf /` 的完整旅程

假设用户在 `auto` 模式下运行 Claude Code，Agent 想执行 `rm -rf /`：

```
1. hasPermissionsToUseTool(BashTool, { command: "rm -rf /" }, context)
   │
   ├─ 1a. getDenyRuleForTool() 检查 deny 规则
   │   └─ 如果 policySettings 有 Bash(rm -rf:*) → 立即 DENY ✋
   │   └─ 如果没匹配 → 继续
   │
   ├─ 1b. getAskRuleForTool() 检查 ask 规则
   │   └─ 如果有 Bash(*) 的 ask 规则 → 检查沙箱是否能自动放行
   │   └─ 没有沙箱 → 标记 ask
   │
   ├─ 1c. BashTool.checkPermissions({ command: "rm -rf /" })
   │   ├─ 检查命令是否匹配内容级 deny → 可能 DENY
   │   ├─ 检查命令是否触及敏感文件（/ 是根目录）
   │   │   └─ safetyCheck: "Attempting to operate outside working directory"
   │   └─ 返回 { behavior: 'ask', decisionReason: { type: 'safetyCheck' } }
   │
   ├─ 1d-1g. 安全守卫检查
   │   └─ 1g: safetyCheck + classifierApprovable=false → 直接 ASK
   │   └─ 注意：即使 bypass 模式，safetyCheck 也不会被跳过！
   │
   ├─ 外层 hasPermissionsToUseTool:
   │   ├─ mode === 'auto' → 调用 AI 分类器
   │   │   ├─ Stage 1 (fast): "<block>yes</block>" → 应该阻止
   │   │   ├─ Stage 2 (thinking): 确认阻止，理由: "Destructive command..."
   │   │   └─ shouldBlock: true, reason: "This would destroy the entire filesystem"
   │   │
   │   └─ 分类器结果: shouldBlock=true
   │       └─ 显示给用户: "🚫 Blocked: This would destroy the entire filesystem"
   │       └─ 用户可以选择强制执行或拒绝
   │
   └─ 最终结果: DENY（或询问用户）
```

### 如果沙箱启用

即使所有权限层都放行，**第 7 层沙箱**也会阻止：

```
rm -rf /
  │
  └─ 沙箱拦截：文件系统只允许写入 CWD + 配置的额外目录
     └─ EPERM: Operation not permitted (sandbox violation)
```

---

## 8. PermissionDecision 类型体系

```typescript
// src/types/permissions.ts

// 允许决策
type PermissionAllowDecision = {
  behavior: 'allow'
  updatedInput?: Input      // 可能修改输入（如路径规范化）
  decisionReason?: PermissionDecisionReason
}

// 询问决策
type PermissionAskDecision = {
  behavior: 'ask'
  message: string           // 显示给用户的消息
  suggestions?: PermissionUpdate[]  // 建议的规则添加
  pendingClassifierCheck?: PendingClassifierCheck  // 异步分类器
}

// 拒绝决策
type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason  // 必须有理由
}

// 决策理由
type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }      // 规则匹配
  | { type: 'mode'; mode: PermissionMode }      // 模式决定
  | { type: 'classifier'; ... }                  // AI 分类器
  | { type: 'safetyCheck'; reason: string; classifierApprovable: boolean }
  | { type: 'hook'; hookName: string }           // Hook 脚本
  | { type: 'sandboxOverride'; ... }             // 沙箱相关
  | { type: 'other'; reason: string }            // 其他
```

---

## 9. 规则持久化与同步

### 9.1 规则存储

```typescript
// src/utils/permissions/permissionsLoader.ts

// 从磁盘加载规则
function loadPermissionRulesFromSettings(): PermissionRule[] {
  // 1. 读取 policySettings → PermissionRule[]
  // 2. 读取 projectSettings → PermissionRule[]
  // 3. 读取 userSettings → PermissionRule[]
  // 4. 读取 localSettings → PermissionRule[]
  // 5. 合并所有规则
}
```

### 9.2 运行时同步

```typescript
// src/utils/permissions/permissions.ts:L1469

// 当设置文件变化时，从磁盘重新加载规则
export function syncPermissionRulesFromDisk(
  toolPermissionContext: ToolPermissionContext,
  rules: PermissionRule[],
): ToolPermissionContext {
  let context = toolPermissionContext

  // 企业管控模式：清除所有非策略源
  if (shouldAllowManagedPermissionRulesOnly()) {
    // 清除 userSettings, projectSettings, localSettings, cliArg, session
  }

  // 清除所有磁盘来源的旧规则（防止删除规则后残留）
  for (const diskSource of ['userSettings', 'projectSettings', 'localSettings']) {
    for (const behavior of ['allow', 'deny', 'ask']) {
      context = applyPermissionUpdate(context, {
        type: 'replaceRules', rules: [], behavior, destination: diskSource,
      })
    }
  }

  // 应用新规则
  const updates = convertRulesToUpdates(rules, 'replaceRules')
  return applyPermissionUpdates(context, updates)
}
```

---

## 10. 设计分析

### 10.1 为什么是层叠式而不是单一规则表？

| 需求 | 层叠式方案 | 单一规则表 |
|------|-----------|-----------|
| 企业管控 | policySettings 不可覆盖 | 需要额外的优先级字段 |
| 团队共享 | projectSettings 提交到 Git | 需要标记哪些规则是共享的 |
| 个人定制 | userSettings 本地生效 | 需要标记哪些规则是个人的 |
| 临时授权 | session 级别内存存储 | 需要额外的生命周期管理 |
| 工具特化 | 每个工具 checkPermissions | 需要通用化工具逻辑 |

### 10.2 deny 优先原则

**所有层级的 deny 规则优先于所有层级的 allow 规则**。这是安全设计的基本原则：
- 企业 deny 不可被项目 allow 覆盖
- 项目 deny 不可被用户 allow 覆盖
- 这确保安全底线不会被任何人绕过

### 10.3 ask 作为"第三态"

Claude Code 引入 `ask` 作为 allow/deny 之间的中间态：
- 不直接拒绝（避免打断工作流）
- 不直接允许（保持用户知情权）
- 在 auto 模式下，ask 会被 AI 分类器接管

### 10.4 passthrough 到 ask 的转换

工具 `checkPermissions` 返回 `passthrough` 意味着"我没有强意见"，会在最后被转换为 `ask`。这种设计让工具可以选择不参与决策。

---

## 12. 思考题

1. **deny 优先是否过于严格？** 企业管理员配置了一个过宽的 deny 规则（如 `Bash(*)`），用户将完全无法使用 Bash。Claude Code 通过 `ask` 行为缓解了这个问题——管理员可以配置 `ask` 而非 `deny`。

2. **7 层是否过于复杂？** 对于个人用户来说确实如此（大多数时候只用到 2-3 层）。但对于企业场景，每一层都有明确的职责边界。这是"简单使用、复杂可配"的设计哲学。

3. **safetyCheck 为什么不可被 bypass？** 即使用户选择了 bypassPermissions 模式，编辑 `.git/config` 或 `.bashrc` 等文件仍然需要确认。这是防止 AI Agent 被 prompt injection 诱导修改安全敏感文件的最后防线。

4. **为什么重新获取 AppState？** 在步骤 2a 中 `context.getAppState()` 被再次调用。因为在 async 执行过程中，用户可能通过 UI 切换了权限模式（如从 default 切到 bypassPermissions），需要获取最新状态。
