# Q: 工具池如何动态组装？feature() 编译门控如何工作？

> 本文深入分析工具注册管线：从 `getAllBaseTools()` 到 `assembleToolPool()`，
> 以及 `feature()` 编译时门控在其中的关键作用。

---

## 1. 核心问题

Claude Code 的工具池不是静态的——它随着运行时环境、用户类型、feature flags、权限规则和 MCP 连接动态变化。理解工具池的组装过程是理解整个系统的关键。

```
getAllBaseTools()          // 所有可能的工具
    │
    ▼
getTools()                // 过滤：模式、deny rules、isEnabled
    │
    ▼
assembleToolPool()        // 合并 MCP 工具 → 排序 → 去重
    │
    ▼
最终工具列表              // 发送给 API 的工具集
```

---

## 2. 第一层：getAllBaseTools() — 穷举所有工具

```typescript
// src/tools.ts:L193-L251
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // 嵌入式搜索工具时移除 Glob/Grep
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    // ant-only 工具
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    // Todo V2 工具组
    ...(isTodoV2Enabled()
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    // Feature-gated 工具（编译时门控）
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    // 运行时环境变量门控
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),           // lazy require
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled()
      ? [getTeamCreateTool(), getTeamDeleteTool()]  // lazy require
      : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

**重要注释**（源码中的警告）：

```typescript
// src/tools.ts:L191
// NOTE: This MUST stay in sync with
// https://console.statsig.com/.../claude_code_global_system_caching
// in order to cache the system prompt across users.
```

工具列表的顺序影响系统提示（system prompt）的内容——API 会缓存系统提示，如果工具列表变化导致缓存失效，会影响性能。

---

## 3. feature() 编译时门控 — Dead Code Elimination

### 3.1 feature() 的工作原理

```typescript
// src/tools.ts:L104
import { feature } from 'bun:bundle'
```

`feature()` 是一个编译时宏（由 esbuild/bun bundler 处理）。在构建时，bundler 将 `feature('FLAG_NAME')` 替换为 `true` 或 `false` 字面量：

```typescript
// 源码:
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

// 编译后 (当两个 flag 都为 false 时):
const SleepTool = false || false
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

// 经过 Dead Code Elimination:
const SleepTool = null
// require 调用被完全移除！SleepTool 的代码不会出现在最终 bundle 中
```

### 3.2 Feature Flags 全览

| Feature Flag | 控制的工具 | 说明 |
|-------------|-----------|------|
| `PROACTIVE` | SleepTool | 主动代理功能 |
| `KAIROS` | SleepTool, SendUserFileTool, PushNotificationTool | Kairos 后台代理平台 |
| `KAIROS_PUSH_NOTIFICATION` | PushNotificationTool | 推送通知（也受 KAIROS 控制） |
| `KAIROS_GITHUB_WEBHOOKS` | SubscribePRTool | GitHub webhook 订阅 |
| `AGENT_TRIGGERS` | CronCreate/Delete/ListTool | 定时任务触发器 |
| `AGENT_TRIGGERS_REMOTE` | RemoteTriggerTool | 远程触发器 |
| `MONITOR_TOOL` | MonitorTool | 监控工具 |
| `WEB_BROWSER_TOOL` | WebBrowserTool | 浏览器操作 |
| `OVERFLOW_TEST_TOOL` | OverflowTestTool | 溢出测试（内部） |
| `CONTEXT_COLLAPSE` | CtxInspectTool | 上下文检查 |
| `TERMINAL_PANEL` | TerminalCaptureTool | 终端截图 |
| `HISTORY_SNIP` | SnipTool | 历史裁剪 |
| `UDS_INBOX` | ListPeersTool | Unix Domain Socket 通信 |
| `WORKFLOW_SCRIPTS` | WorkflowTool | 工作流脚本 |
| `COORDINATOR_MODE` | coordinatorModeModule | 协调者模式 |
| `TRANSCRIPT_CLASSIFIER` | （权限逻辑中） | 自动模式分类器 |

### 3.3 编译门控 vs 运行时门控

代码库中有三种门控机制：

```typescript
// 1. feature() 编译门控 — bundle 时决定，Dead Code Elimination
const SleepTool = feature('PROACTIVE') ? require('...') : null

// 2. process.env 运行时门控 — 启动时决定
...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : [])

// 3. 函数运行时门控 — 每次调用时决定
...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : [])
...(isTodoV2Enabled() ? [TaskCreateTool, ...] : [])
```

**feature() 的优势**: 未启用的代码完全不进入 bundle，减小体积。而 `process.env` 门控的代码仍在 bundle 中，只是运行时不加载。

### 3.4 条件 require 模式

```typescript
// src/tools.ts:L117-L119
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
```

使用 `require()` 而非 `import` 是关键——`import` 是静态的，即使在 false 分支也会被 bundler 处理；`require()` 是动态的，在 false 分支会被完全消除。

---

## 4. 第二层：getTools() — 模式过滤

```typescript
// src/tools.ts:L271-L327
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // ========================================
  // SIMPLE 模式: 只保留核心工具
  // ========================================
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    // REPL 模式下用 REPLTool 包装
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      // Coordinator 模式额外添加 TaskStop + SendMessage
      if (feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()) {
        replSimple.push(TaskStopTool, getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }

    // 非 REPL 的 SIMPLE 模式: Bash + Read + Edit
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    if (feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // ========================================
  // 完整模式: 所有工具
  // ========================================
  // 排除特殊工具（它们有单独的注入路径）
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // Deny rules 过滤
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // REPL 模式: 隐藏被 REPL 包装的原始工具
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(
      tool => toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  // isEnabled() 检查
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

### 4.1 三种模式的工具集

```
SIMPLE 模式 (--bare):
┌──────────────────────┐
│ Bash, Read, Edit     │  ← 最小集
│ (+ Coordinator 工具)  │
└──────────────────────┘

REPL 模式 (ant + REPL):
┌──────────────────────────────────────────┐
│ REPLTool (包装了 Bash/Read/Edit/...)      │
│ + 非 REPL_ONLY_TOOLS                      │
└──────────────────────────────────────────┘

完整模式 (默认):
┌──────────────────────────────────────────┐
│ getAllBaseTools() 的全部工具                │
│ - specialTools (MCP Resource 工具等)       │
│ - deny rules 过滤                          │
│ - isEnabled() 过滤                         │
└──────────────────────────────────────────┘
```

### 4.2 filterToolsByDenyRules — 权限过滤

```typescript
// src/tools.ts:L262-L269
export function filterToolsByDenyRules<
  T extends { name: string; mcpInfo?: { serverName: string; toolName: string } },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}
```

**关键细节**: deny rule 支持 MCP 服务器前缀匹配：

```
deny rule: "mcp__github"
→ 移除所有 mcp__github__* 工具
```

这使得用户可以一次性禁用整个 MCP 服务器的所有工具。

---

## 5. 第三层：assembleToolPool() — 合并与排序

```typescript
// src/tools.ts:L345-L367
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // MCP 工具也经过 deny rules 过滤
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 排序策略: 内置工具和 MCP 工具分别排序
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)

  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',  // 按名称去重，内置工具优先
  )
}
```

### 5.1 排序策略 — prompt cache 稳定性

为什么不简单地 flat sort 所有工具？

```typescript
// src/tools.ts:L354-L362
// Sort each partition for prompt-cache stability, keeping built-ins as a
// contiguous prefix. The server's claude_code_system_cache_policy places a
// global cache breakpoint after the last prefix-matched built-in tool; a flat
// sort would interleave MCP tools into built-ins and invalidate all downstream
// cache keys whenever an MCP tool sorts between existing built-ins.
```

API 服务器在系统提示的内置工具结尾放置了缓存断点。如果 MCP 工具插入到内置工具之间（如 `Bash, mcp__foo, Edit`），每次 MCP 工具变化都会使缓存失效。

分区排序保证：
```
[内置工具 A-Z] + [MCP 工具 A-Z]
```

内置工具部分始终稳定，只有 MCP 部分可能变化。

### 5.2 去重策略 — 内置优先

```typescript
// uniqBy 保留第一个出现的元素
uniqBy([...builtInTools, ...allowedMcpTools], 'name')
```

如果某个 MCP 工具的名称与内置工具冲突（如都叫 `Bash`），内置工具胜出。

### 5.3 Node 18 兼容性

```typescript
// 避免 Array.toSorted (Node 20+) — 我们支持 Node 18
// builtInTools 是 readonly，需要先复制
[...builtInTools].sort(byName)
```

---

## 6. Lazy require() — 打破循环依赖

### 6.1 问题场景

```
tools.ts → TeamCreateTool → ... → tools.ts  (循环！)
```

`TeamCreateTool` 的实现可能间接导入 `tools.ts`（通过工具列表查询等），形成循环依赖。

### 6.2 解决方案

```typescript
// src/tools.ts:L62-L72
// Lazy require to break circular dependency:
// tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool

const getTeamDeleteTool = () =>
  require('./tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('./tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool

const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
```

**模式**: 用函数包装 `require()`，延迟到实际调用时才解析模块。`as typeof import(...)` 保留类型安全。

### 6.3 PowerShellTool 的双重保护

```typescript
// src/tools.ts:L150-L156
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null  // 运行时检查
  return (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
```

先检查运行时条件，再 require——避免在非 Windows 平台加载 PowerShell 相关代码。

---

## 7. 子代理工具过滤

### 7.1 ALL_AGENT_DISALLOWED_TOOLS

```typescript
// src/constants/tools.ts:L36-L46
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,       // 防止子代理直接输出
  EXIT_PLAN_MODE_V2_TOOL_NAME, // 计划模式是主线程概念
  ENTER_PLAN_MODE_TOOL_NAME,
  // ant 用户允许嵌套代理
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  ASK_USER_QUESTION_TOOL_NAME, // 子代理不能直接询问用户
  TASK_STOP_TOOL_NAME,         // 需要主线程任务状态
  ...(feature('WORKFLOW_SCRIPTS') ? [WORKFLOW_TOOL_NAME] : []),
])
```

### 7.2 COORDINATOR_MODE_ALLOWED_TOOLS

```typescript
// src/constants/tools.ts:L107-L112
// 协调者模式只允许管理型工具
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,         // 创建子代理
  TASK_STOP_TOOL_NAME,     // 停止任务
  SEND_MESSAGE_TOOL_NAME,  // 代理间通信
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

### 7.3 ASYNC_AGENT_ALLOWED_TOOLS

```typescript
// src/constants/tools.ts:L55-L71
// 异步代理的白名单（而非黑名单）
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,          // Bash + PowerShell
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
```

---

## 8. getMergedTools vs assembleToolPool

```typescript
// assembleToolPool: 排序 + 去重（用于 API 调用）
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

// getMergedTools: 简单合并（用于工具计数、token 计算）
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]  // 不排序，不去重
}
```

两个函数的使用场景不同：
- `assembleToolPool`: 组装最终工具池，发送给 API
- `getMergedTools`: 快速获取工具总数（用于 ToolSearch 阈值计算、token 计数）

---

## 9. 嵌入式搜索工具的特殊处理

```typescript
// src/tools.ts:L198-L201
// Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
// trick as ripgrep). When available, find/grep in Claude's shell are aliased
// to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
```

在 ant 内部构建中，bfs（快速 find）和 ugrep 被嵌入到 bun 二进制中。此时 shell 中的 `find` 和 `grep` 命令已经是快速版本，不需要单独的 GlobTool/GrepTool 工具。

---

## 10. WorkflowTool 的初始化模式

```typescript
// src/tools.ts:L129-L134
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? (() => {
      require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
      return require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
    })()
  : null
```

**IIFE 模式**: WorkflowTool 需要在加载时执行初始化（注册内置工作流），所以用立即执行函数表达式包装。

---

## 11. 完整注册管线图

```
┌─────────────────────────────────────────────────────────────┐
│ 编译时                                                       │
│                                                              │
│  feature('FLAG') → true/false                                │
│       ↓                                                      │
│  Dead Code Elimination                                       │
│  - feature('WEB_BROWSER') = false → WebBrowserTool 代码消除   │
│  - feature('KAIROS') = true → SleepTool 代码保留              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 运行时 — getAllBaseTools()                                    │
│                                                              │
│  静态 import 工具: [AgentTool, BashTool, FileReadTool, ...]   │
│  + process.env 门控: USER_TYPE === 'ant' → ConfigTool         │
│  + feature 门控: feature('X') ? require('Y') : null           │
│  + 函数门控: isTodoV2Enabled() → TaskCreate/Get/Update/List   │
│  + lazy require: getSendMessageTool(), getTeamCreateTool()    │
│  = 完整候选列表 (~40+ 工具)                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 运行时 — getTools(permissionContext)                          │
│                                                              │
│  SIMPLE 模式?  → [Bash, Read, Edit]                           │
│  REPL 模式?    → [REPLTool + 非包装工具]                       │
│  完整模式      → getAllBaseTools()                             │
│       - specialTools (ListMcpResources, ReadMcpResource, ...)│
│       - filterToolsByDenyRules()                              │
│       - REPL_ONLY_TOOLS 过滤                                  │
│       - isEnabled() 过滤                                      │
│  = 可用内置工具列表                                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 运行时 — assembleToolPool(permissionContext, mcpTools)        │
│                                                              │
│  1. getTools() → 内置工具                                     │
│  2. filterToolsByDenyRules(mcpTools) → 允许的 MCP 工具         │
│  3. 内置工具按名称排序                                         │
│  4. MCP 工具按名称排序                                         │
│  5. [内置排序] + [MCP 排序] → 合并                             │
│  6. uniqBy('name') → 去重（内置优先）                          │
│  = 最终工具池                                                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                    发送给 Claude API
```

---

## 12. 关键总结

| 设计决策 | 选择 | 原因 |
|----------|------|------|
| 编译门控 | `feature()` → Dead Code Elimination | 减小 bundle 体积，未启用功能不占空间 |
| 运行时门控 | `process.env` / 函数检查 | 灵活配置，无需重新构建 |
| 循环依赖 | Lazy require() + 函数包装 | 延迟解析，保留类型安全 |
| 排序策略 | 分区排序（内置 \| MCP） | Prompt cache 稳定性 |
| 去重策略 | `uniqBy('name')`，内置优先 | 防止 MCP 工具覆盖内置工具 |
| SIMPLE 模式 | 3 个核心工具 | 最小化攻击面 |
| 子代理过滤 | 黑名单/白名单 | 防止递归、权限逃逸 |
| 嵌入式工具 | 有则移除独立工具 | 避免重复功能 |
