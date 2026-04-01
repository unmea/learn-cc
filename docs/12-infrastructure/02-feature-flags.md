# Q: 编译时 feature() 门控如何实现？

> **核心问题**：Claude Code 使用 86 个编译时 feature flag 来控制不同功能的开关。这个系统如何工作？为什么选择编译时而非运行时？与传统的 feature toggle 有何不同？

---

## 1. feature() 机制全景

### 1.1 原始实现——Bun 内建

在 Bun 运行时中，`feature()` 是编译器内建函数：

```typescript
// 源码中的用法（158 个文件使用此模式）
import { feature } from 'bun:bundle'

if (feature('KAIROS')) {
  // 这段代码在 Bun 构建时被评估
  // 如果 KAIROS=true，保留
  // 如果 KAIROS=false，连同 if 分支一起删除
}
```

**关键特性**：
- `feature()` 在**编译时**被替换为 `true` 或 `false` 字面量
- 替换后，esbuild/Bun 的死代码消除（DCE）会移除 `false` 分支
- 最终产物中**完全不包含**被关闭的功能代码

### 1.2 开源 Stub 实现

在没有 Bun 的环境中，feature() 通过 stub 提供：

```typescript
// stubs/bun-bundle.ts
export function feature(_flag: string): boolean {
  return false  // 所有 flag 默认关闭
}
```

**构建时替换策略**（`scripts/build.mjs:86-90`）：

```javascript
// 正则表达式精确匹配 feature('FLAG_NAME') 模式
src = src.replace(
  /\bfeature\s*\(\s*['"][A-Z_]+['"]\s*\)/g,
  'false'
)
```

---

## 2. 全部 86 个 Feature Flag

通过搜索源码中的 `feature('...')` 调用，发现以下所有 flag：

### 2.1 核心产品功能

| Flag | 用途 | 关联文件 |
|------|------|----------|
| `KAIROS` | Kairos 助手模式（频道、UI、简报） | `main.tsx`, 多个组件 |
| `KAIROS_BRIEF` | Kairos 简报工具 | 工具注册 |
| `KAIROS_CHANNELS` | Kairos 频道支持 | 频道管理 |
| `KAIROS_DREAM` | Kairos 梦境功能 | 扩展特性 |
| `KAIROS_GITHUB_WEBHOOKS` | Kairos GitHub Webhook 集成 | 事件处理 |
| `KAIROS_PUSH_NOTIFICATION` | Kairos 推送通知 | 通知系统 |
| `COORDINATOR_MODE` | 协调器多 Agent 模式 | `coordinator/` |
| `PROACTIVE` | 主动模式（Agent 自主触发操作） | Agent 系统 |
| `BRIDGE_MODE` | 远程控制（Bridge）模式 | `bridge/` |
| `BUDDY` | 伴侣精灵 | UI 组件 |
| `VOICE_MODE` | 语音交互模式 | 语音系统 |
| `DAEMON` | 守护进程模式 | 后台服务 |

### 2.2 Agent 能力扩展

| Flag | 用途 |
|------|------|
| `FORK_SUBAGENT` | 子 Agent 分叉 |
| `VERIFICATION_AGENT` | 验证 Agent |
| `MONITOR_TOOL` | 后台任务监控工具 |
| `WEB_BROWSER_TOOL` | 网页浏览器工具 |
| `ULTRAPLAN` | 超级规划模式 |
| `ULTRATHINK` | 超级思考模式 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内建探索/规划 Agent |
| `WORKFLOW_SCRIPTS` | 工作流脚本执行 |

### 2.3 MCP 与技能

| Flag | 用途 |
|------|------|
| `MCP_SKILLS` | MCP 技能支持 |
| `MCP_RICH_OUTPUT` | MCP 富文本输出渲染 |
| `CHICAGO_MCP` | Chicago MCP 集成 |
| `EXPERIMENTAL_SKILL_SEARCH` | 实验性技能搜索 |
| `SKILL_IMPROVEMENT` | 技能改进 |
| `RUN_SKILL_GENERATOR` | 技能生成器 |

### 2.4 远程与连接

| Flag | 用途 |
|------|------|
| `DIRECT_CONNECT` | 直连功能 |
| `SSH_REMOTE` | SSH 远程控制 |
| `CCR_AUTO_CONNECT` | CCR 自动连接 |
| `CCR_MIRROR` | CCR 镜像 |
| `CCR_REMOTE_SETUP` | CCR 远程设置 |
| `UDS_INBOX` | Unix Domain Socket 收件箱 |

### 2.5 上下文与记忆

| Flag | 用途 |
|------|------|
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照 |
| `EXTRACT_MEMORIES` | 记忆提取 |
| `MEMORY_SHAPE_TELEMETRY` | 记忆结构遥测 |
| `CONTEXT_COLLAPSE` | 上下文折叠 |
| `COMPACTION_REMINDERS` | 压缩提醒 |
| `REACTIVE_COMPACT` | 响应式压缩 |
| `CACHED_MICROCOMPACT` | 缓存微压缩 |
| `HISTORY_SNIP` | 历史裁剪 |

### 2.6 UI 与体验

| Flag | 用途 |
|------|------|
| `AUTO_THEME` | 自动主题检测 |
| `STREAMLINED_OUTPUT` | 精简输出模式 |
| `TERMINAL_PANEL` | 终端面板 |
| `HISTORY_PICKER` | 历史选择器 |
| `MESSAGE_ACTIONS` | 消息操作按钮 |
| `REVIEW_ARTIFACT` | 审查产物 |

### 2.7 安全与分类

| Flag | 用途 |
|------|------|
| `TRANSCRIPT_CLASSIFIER` | 对话分类器（自动模式决策） |
| `BASH_CLASSIFIER` | Bash 命令分类器 |
| `TREE_SITTER_BASH` | Tree-sitter Bash 解析 |
| `TREE_SITTER_BASH_SHADOW` | Tree-sitter Bash 影子模式 |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护 |
| `NATIVE_CLIENT_ATTESTATION` | 原生客户端认证 |

### 2.8 性能与基础设施

| Flag | 用途 |
|------|------|
| `PERFETTO_TRACING` | Perfetto 性能追踪 |
| `SLOW_OPERATION_LOGGING` | 慢操作日志 |
| `PROMPT_CACHE_BREAK_DETECTION` | 提示缓存中断检测 |
| `BREAK_CACHE_COMMAND` | 缓存中断命令 |
| `TOKEN_BUDGET` | Token 预算管理 |
| `SHOT_STATS` | 请求统计 |
| `ENHANCED_TELEMETRY_BETA` | 增强遥测 Beta |

### 2.9 其他

| Flag | 用途 |
|------|------|
| `BG_SESSIONS` | 后台会话 |
| `FILE_PERSISTENCE` | 文件持久化 |
| `TEMPLATES` | 模板功能 |
| `TORCH` | Torch 命令 |
| `LODESTONE` | Lodestone 功能 |
| `COMMIT_ATTRIBUTION` | 提交归属 |
| `NEW_INIT` | 新初始化流程 |
| `CONNECTOR_TEXT` | 连接器文本 |
| `UPLOAD_USER_SETTINGS` | 上传用户设置 |
| `DOWNLOAD_USER_SETTINGS` | 下载用户设置 |
| `TEAMMEM` | 团队成员 |
| `QUICK_SEARCH` | 快速搜索 |
| `ABLATION_BASELINE` | 消融基线 |
| `ALLOW_TEST_VERSIONS` | 允许测试版本 |
| `HARD_FAIL` | 强制失败（测试） |
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 |
| `DUMP_SYSTEM_PROMPT` | 导出系统提示词 |
| `HOOK_PROMPTS` | Hook 提示 |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式 |
| `SELF_HOSTED_RUNNER` | 自托管运行器 |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 环境运行器 |
| `UNATTENDED_RETRY` | 无人值守重试 |
| `AWAY_SUMMARY` | 离开摘要 |
| `AGENT_TRIGGERS` | Agent 触发器 |
| `AGENT_TRIGGERS_REMOTE` | Agent 远程触发器 |
| `COWORKER_TYPE_TELEMETRY` | 协作者类型遥测 |
| `BUILDING_CLAUDE_APPS` | 构建 Claude 应用 |
| `IS_LIBC_GLIBC` / `IS_LIBC_MUSL` | libc 类型检测 |

---

## 3. feature() 使用模式

### 3.1 条件模块加载

最常见的模式——根据 flag 决定是否加载一个模块：

```typescript
// src/tools.ts:16-135
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

const REPLTool = process.env.USER_TYPE === 'ant'
  ? require('./tools/REPLTool/REPLTool.js').REPLTool
  : null
```

**编译时行为**：
```
feature('PROACTIVE') → false
feature('KAIROS') → false
false || false → false（常量折叠）
→ const SleepTool = null（DCE 移除 require）
```

### 3.2 条件代码块

```typescript
// src/main.tsx（200+ 处调用）
if (feature('KAIROS')) {
  // 整个 Kairos UI 初始化
  const KairosProvider = require('./kairos/Provider.js')
  // 注册 Kairos 路由
  // 初始化频道管理器
  // ... 可能数百行代码
}
```

### 3.3 组合条件

```typescript
// 多个 flag 的 OR 组合
if (feature('PROACTIVE') || feature('KAIROS')) {
  // 两个功能共享的代码路径
}

// 嵌套条件
if (feature('COORDINATOR_MODE')) {
  if (feature('FORK_SUBAGENT')) {
    // 仅在协调器 + 分叉子 Agent 都启用时
  }
}
```

### 3.4 工具注册过滤

```typescript
// src/tools.ts
function getTools(context: ToolPermissionContext): Tool[] {
  const tools: Tool[] = [
    BashTool,
    FileReadTool,
    FileWriteTool,
    // ... 基础工具总是包含
  ]
  
  if (feature('WEB_BROWSER_TOOL')) {
    tools.push(WebBrowserTool)
  }
  if (feature('MONITOR_TOOL')) {
    tools.push(MonitorTool)
  }
  
  return tools.filter(Boolean)
}
```

---

## 4. MACRO 编译时常量

### 4.1 完整 MACRO 列表

```typescript
// stubs/macros.d.ts - 类型声明
declare const MACRO: {
  VERSION: string              // '2.1.88'
  BUILD_TIME: string           // ISO 时间戳
  FEEDBACK_CHANNEL: string     // 反馈渠道标识
  ISSUES_EXPLAINER: string     // 问题说明文本
  ISSUES_EXPLAINER_URL: string // Issue 页面 URL
  FEEDBACK_CHANNEL_URL: string // 反馈 URL
  NATIVE_PACKAGE_URL: string   // npm 包名
  PACKAGE_URL: string          // npm 包名
  VERSION_CHANGELOG: string    // 变更日志
}
```

### 4.2 使用场景

```typescript
// 版本显示
// src/services/analytics/metadata.ts:33-34
const version = MACRO.VERSION        // 遥测事件中的版本号
const buildTime = MACRO.BUILD_TIME   // 构建时间

// 错误反馈引导
// src/services/api/errors.ts:87
`Please report this issue at ${MACRO.FEEDBACK_CHANNEL}`

// 更新检查
// src/cli/update.ts:115
const packageName = MACRO.PACKAGE_URL  // '@anthropic-ai/claude-code'
```

### 4.3 MACRO vs feature() 的区别

| 维度 | MACRO.* | feature() |
|------|---------|-----------|
| 返回类型 | string | boolean |
| 用途 | 注入配置值 | 控制代码分支 |
| DCE 效果 | 不触发 | 触发死代码消除 |
| 变体数量 | 所有构建相同 | 按产品变体不同 |

---

## 5. 运行时 Feature Flag

除了编译时 flag，Claude Code 还大量使用环境变量作为**运行时 feature flag**：

### 5.1 CLAUDE_CODE_ 系列

```typescript
// 运行时环境变量检查
process.env.CLAUDE_CODE_COORDINATOR_MODE    // 启用协调器模式
process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY // 跳过历史加载
process.env.CLAUDE_CODE_REMOTE              // 远程模式标识
process.env.CLAUDE_CODE_REMOTE_SESSION_ID   // 远程会话 ID
process.env.CLAUDE_CODE_ACCESSIBILITY       // 无障碍模式
process.env.CLAUDE_CODE_DEBUG_REPAINTS      // 调试重绘
process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER // 渲染后退出
process.env.CLAUDE_CODE_PROFILE_QUERY       // 查询性能分析
process.env.CLAUDE_CODE_PROFILE_STARTUP     // 启动性能分析
process.env.CLAUDE_CODE_PERFETTO_TRACE      // Perfetto 追踪
process.env.CLAUDE_CODE_UNATTENDED_RETRY    // 无人值守重试
process.env.CLAUDE_CODE_BASE_REF            // Git diff 基准引用
```

### 5.2 编译时 vs 运行时：何时用哪个？

```
                编译时 feature()          运行时 process.env
                ┌──────────────────┐      ┌──────────────────┐
决策时机         │ 构建时（打包前）  │      │ 启动时（运行时）  │
代码影响         │ 完全移除未用代码  │      │ 代码始终在 bundle │
切换成本         │ 需要重新构建      │      │ 改变量即可        │
适用场景         │ 产品变体          │      │ 用户配置/调试     │
                │ 内部/外部版本     │      │ 环境特定设置      │
安全性           │ 代码不泄漏        │      │ 代码可被逆向      │
                └──────────────────┘      └──────────────────┘
```

**经验法则**：
- **编译时**：用于区分产品 SKU（内部版 vs 外部版），或保护敏感功能不泄漏
- **运行时**：用于用户可配置的行为、调试开关、环境适配

---

## 6. 死代码消除 (DCE) 详解

### 6.1 DCE 工作原理

```
源代码                           替换后                    DCE 后
─────────────────────────────────────────────────────────────────
import { feature }               // removed              // removed
  from 'bun:bundle'

if (feature('KAIROS')) {         if (false) {            // 整块移除
  import('./kairos.js')            import('./kairos.js')
  doKairosStuff()                  doKairosStuff()
}                                }

// 正常代码                      // 正常代码              // 正常代码
doNormalStuff()                  doNormalStuff()          doNormalStuff()
```

### 6.2 DCE 的边界情况

**顶层副作用不会被移除**：
```typescript
// 这段代码即使 feature 为 false，import 的副作用可能保留
import './kairos/setup.js'  // 模块级副作用
if (feature('KAIROS')) {
  // 使用 kairos
}
```

**解决方案**：Claude Code 的模式总是把 import 放在 feature 分支内：
```typescript
if (feature('KAIROS')) {
  const { setup } = require('./kairos/setup.js')  // ← 在分支内
  setup()
}
```

### 6.3 估算 DCE 效果

86 个 flag 全部设为 false（开源构建），意味着：
- **158 个文件**中的条件代码被移除
- `main.tsx` 中 200+ 处 feature 分支被消除
- 工具注册中大量可选工具被跳过

保守估计，DCE 可以将代码量减少 **30-50%**。

---

## 7. 与其他 Feature Flag 系统的对比

### 7.1 vs LaunchDarkly（运行时服务）

```
LaunchDarkly:
┌─────────┐    ┌──────────┐    ┌──────────┐
│ 代码    │ →  │ API 调用  │ →  │ 运行时   │
│ if flag │    │ LaunchD.  │    │ 决策     │
└─────────┘    └──────────┘    └──────────┘

Claude Code feature():
┌─────────┐    ┌──────────┐    ┌──────────┐
│ 代码    │ →  │ 编译器   │ →  │ 编译时   │
│ feature │    │ Bun      │    │ 代码消除 │
└─────────┘    └──────────┘    └──────────┘
```

| 维度 | LaunchDarkly | feature() |
|------|-------------|-----------|
| 延迟 | API 调用延迟 | 零（编译时消除） |
| 粒度 | 用户级/百分比 | 构建变体级 |
| Bundle 大小 | 包含所有代码 | 只含启用的代码 |
| 回滚 | 即时（改 flag） | 需重新构建 |
| 安全 | 代码可见 | 代码不可见 |

### 7.2 vs C 预处理器 #ifdef

```c
// C 预处理器
#ifdef KAIROS
  kairos_init();
#endif
```

```typescript
// Claude Code
if (feature('KAIROS')) {
  kairosInit()
}
```

**相似之处**：都在编译时决定代码是否保留。
**不同之处**：feature() 是合法的 TypeScript 表达式，IDE 和类型检查器能正常工作。

---

## 8. feature() 的工程影响

### 8.1 对代码组织的影响

```
无 feature flag:
src/
├── tools/
│   ├── BashTool/       ← 总是存在
│   ├── FileEditTool/   ← 总是存在
│   └── KairosTool/     ← 也总是存在（即使不需要）

有 feature flag:
src/
├── tools/
│   ├── BashTool/       ← 核心工具
│   ├── FileEditTool/   ← 核心工具
│   └── KairosTool/     ← feature('KAIROS') 控制
```

### 8.2 对 Prompt Cache 的影响

feature flag 影响工具注册，进而影响 system prompt：

```
开启 KAIROS:
  system prompt = [base tools] + [kairos tools]
  → prompt cache key 1

关闭 KAIROS:
  system prompt = [base tools]
  → prompt cache key 2（不同！）
```

这就是为什么 feature flag 必须在编译时确定——如果运行时动态切换，会导致 prompt cache 频繁失效。

### 8.3 对团队协作的影响

- **内部团队**可以用特定 flag 组合构建，测试未发布功能
- **外部用户**拿到的构建不包含实验性代码（连代码都看不到）
- **A/B 测试**需要构建多个变体（而非运行时随机）

---

## 9. 实际案例分析

### 案例 1：TRANSCRIPT_CLASSIFIER

```typescript
// src/main.tsx（多处）
if (feature('TRANSCRIPT_CLASSIFIER')) {
  // 使用 AI 分类器判断用户意图
  // 决定是否自动启用自动模式
  const classifier = require('./utils/transcriptClassifier.js')
  const result = await classifier.classify(messages)
  if (result.shouldAutoMode) {
    enableAutoMode()
  }
}
```

**开启时**：每轮对话会经过分类器判断
**关闭时**：跳过分类，使用默认行为

### 案例 2：COORDINATOR_MODE

```typescript
// src/coordinator/coordinatorMode.ts
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    // 编译时 flag 开启后，还需要运行时环境变量确认
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

**双重门控**：编译时 feature flag + 运行时环境变量。这种模式允许：
1. 编译时：确保协调器代码存在于 bundle 中
2. 运行时：用户选择是否实际启用

---

## 10. 启发与超越

### 在你的项目中实现类似系统

**最简方案**——使用 esbuild 的 `--define`：

```javascript
// build.js
esbuild.build({
  define: {
    'FEATURE_NEW_UI': 'true',
    'FEATURE_ANALYTICS': 'false',
  }
})

// 源码中
declare const FEATURE_NEW_UI: boolean
declare const FEATURE_ANALYTICS: boolean

if (FEATURE_NEW_UI) {
  // 这段代码在 FEATURE_NEW_UI=false 时会被 DCE 移除
}
```

**进阶方案**——包装函数 + 自动扫描：

```typescript
// features.ts
type FeatureFlag = 'NEW_UI' | 'ANALYTICS' | 'BETA_API'

declare function feature(flag: FeatureFlag): boolean

// 构建脚本自动扫描所有 feature() 调用，生成 define 映射
// 从配置文件读取每个 flag 的值
```

### 设计建议

1. **编译时 flag 用于不可逆的产品分割**（内部 vs 外部）
2. **运行时 flag 用于可切换的用户行为**（调试、性能模式）
3. **双重门控**用于需要代码存在但运行时可控的功能
4. **命名统一**：全大写 + 下划线（`FEATURE_NAME`），方便正则匹配
5. **86 个 flag 可能太多**——考虑按功能域分组，定期清理已稳定的 flag
