# Q: 如何让一个 Agent 指挥多个 Worker 并行工作？


---

## Coordinator 模式概述

Coordinator 模式将 Claude Code 从"一个 Agent 做所有事"变成"一个指挥官 + N 个 Worker"。
指挥官（Coordinator）只做三件事：**分解任务、分发指令、综合结果**。
它不直接读写文件、不运行命令——这些全部委托给 Worker。

### 启用条件

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  return (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  )
}
```

两个条件同时满足：
1. 特性标志 `COORDINATOR_MODE` 开启
2. 环境变量 `CLAUDE_CODE_COORDINATOR_MODE` 为 truthy 值

---

## Coordinator 只有 4 个工具

这是最关键的设计决策——Coordinator 不能直接操作代码。

> **源码**: `src/constants/tools.ts:107-112`

```typescript
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,           // 创建 Worker
  TASK_STOP_TOOL_NAME,       // 停止 Worker
  SEND_MESSAGE_TOOL_NAME,    // 向已有 Worker 发消息
  SYNTHETIC_OUTPUT_TOOL_NAME // 合成输出
])
```

加上 PR 活动订阅工具（`subscribe_pr_activity` / `unsubscribe_pr_activity`）。

### 工具过滤机制

> **源码**: `src/utils/toolPool.ts:35-41`

```typescript
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools.filter(
    t =>
      COORDINATOR_MODE_ALLOWED_TOOLS.has(t.name) ||
      isPrActivitySubscriptionTool(t.name),
  )
}

export function mergeAndFilterTools(initialTools, assembled, mode): Tools {
  const tools = [...builtIn.sort(byName), ...mcp.sort(byName)]

  if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
    if (coordinatorModeModule.isCoordinatorMode()) {
      return applyCoordinatorToolFilter(tools)  // ← 过滤到只剩 4 个
    }
  }
  return tools
}
```

结果：当 Coordinator 模式激活时，整个工具池被削减到 4（+2）个工具。
Coordinator **无法** 调用 `BashTool`、`FileEditTool`、`GrepTool` 等——必须通过 Worker。

---

## Worker 如何被创建？

### AgentTool 是唯一入口

> **源码**: `src/tools/AgentTool/AgentTool.tsx:82-88`

```typescript
const baseInputSchema = lazySchema(() => z.object({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().optional().describe('The type of specialized agent'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional()
}))
```

### Coordinator 模式下的三个特殊行为

**1. 模型参数被忽略**

```typescript
// src/tools/AgentTool/AgentTool.tsx:252
const model = isCoordinatorMode() ? undefined : modelParam
```

Coordinator 不能给 Worker 指定模型——Worker 始终使用默认模型。
这防止了 Coordinator 随意升降级 Worker 的推理能力。

**2. 强制异步执行**

```typescript
// src/tools/AgentTool/AgentTool.tsx:567
const shouldRunAsync = (
  run_in_background === true || 
  selectedAgent.background === true || 
  isCoordinator ||            // ← Coordinator 模式强制异步
  forceAsync || 
  assistantForceAsync || 
  (proactiveModule?.isProactiveActive() ?? false)
) && !isBackgroundTasksDisabled
```

所有 Worker 都在后台运行——Coordinator 发出指令后立即返回，不等待结果。

**3. 独立工具池**

```typescript
// src/tools/AgentTool/AgentTool.tsx:568-577
const workerPermissionContext = {
  ...appState.toolPermissionContext,
  mode: selectedAgent.permissionMode ?? 'acceptEdits'
}
const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools)
```

Worker 的工具池是**独立组装**的，不继承 Coordinator 的工具限制。

---

## Worker 能用哪些工具？

### Worker 工具池

> **源码**: `src/constants/tools.ts:55-71`

```typescript
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,        // 读文件
  WEB_SEARCH_TOOL_NAME,       // Web 搜索
  TODO_WRITE_TOOL_NAME,       // 写 TODO
  GREP_TOOL_NAME,             // 搜索代码
  WEB_FETCH_TOOL_NAME,        // 获取 URL
  GLOB_TOOL_NAME,             // 文件模式匹配
  ...SHELL_TOOL_NAMES,        // 所有 Bash/Shell 变体
  FILE_EDIT_TOOL_NAME,        // 编辑文件
  FILE_WRITE_TOOL_NAME,       // 写文件
  NOTEBOOK_EDIT_TOOL_NAME,    // 编辑 Notebook
  SKILL_TOOL_NAME,            // 技能系统
  SYNTHETIC_OUTPUT_TOOL_NAME, // 合成输出
  TOOL_SEARCH_TOOL_NAME,      // 工具搜索
  ENTER_WORKTREE_TOOL_NAME,   // 进入 Worktree
  EXIT_WORKTREE_TOOL_NAME,    // 退出 Worktree
])
```

Worker 还可以使用所有已配置的 MCP 工具。

### Worker 被排除的工具

> **源码**: `src/coordinator/coordinatorMode.ts:29-34`

```typescript
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,      // 创建团队
  TEAM_DELETE_TOOL_NAME,      // 删除团队
  SEND_MESSAGE_TOOL_NAME,     // 发消息
  SYNTHETIC_OUTPUT_TOOL_NAME, // 合成输出
])
```

这些工具在 Coordinator 向 Worker 描述可用工具时被过滤掉：

```typescript
// src/coordinator/coordinatorMode.ts:88-95
const workerTools = Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
  .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
  .sort()
  .join(', ')
```

### 工具分配总结

```
┌──────────────────────────────────────────────────────┐
│                    Coordinator                        │
│  工具：Agent, TaskStop, SendMessage, SyntheticOutput │
│        + subscribe/unsubscribe_pr_activity           │
│  不能：读写文件、运行命令、搜索代码                      │
└────────────────────┬─────────────────────────────────┘
                     │ 创建
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
┌─────────────┐┌─────────────┐┌─────────────┐
│   Worker 1  ││   Worker 2  ││   Worker 3  │
│ FileRead    ││ FileRead    ││ FileRead    │
│ FileEdit    ││ FileEdit    ││ FileEdit    │
│ Bash/Shell  ││ Bash/Shell  ││ Bash/Shell  │
│ Grep/Glob   ││ Grep/Glob   ││ Grep/Glob   │
│ WebSearch   ││ WebSearch   ││ WebSearch   │
│ Worktree    ││ Worktree    ││ Worktree    │
│ + MCP 工具  ││ + MCP 工具  ││ + MCP 工具  │
│ 不能：创建  ││ 不能：创建  ││ 不能：创建  │
│ 团队/发消息 ││ 团队/发消息 ││ 团队/发消息 │
└─────────────┘└─────────────┘└─────────────┘
```

---

## 任务通知协议：Worker 如何汇报？

### XML 标签定义

> **源码**: `src/constants/xml.ts:27-34`

```typescript
export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
```

### 完整通知格式

> **源码**: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:252-257`

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <tool-use-id>{toolUseId}</tool-use-id>          <!-- 可选 -->
  <output-file>{outputPath}</output-file>
  <status>completed|failed|killed</status>
  <summary>{人类可读的状态描述}</summary>
  <result>{Agent 的最终文本响应}</result>           <!-- 可选 -->
  <usage>                                          <!-- 可选 -->
    <total_tokens>15234</total_tokens>
    <tool_uses>8</tool_uses>
    <duration_ms>45000</duration_ms>
  </usage>
  <worktree>                                       <!-- 可选 -->
    <worktreePath>/path/to/worktree</worktreePath>
    <worktreeBranch>worktree-feature</worktreeBranch>
  </worktree>
</task-notification>
```

### 通知生成

> **源码**: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:197-262`

```typescript
export function enqueueAgentNotification({
  taskId,
  description,
  status,        // 'completed' | 'failed' | 'killed'
  error?,
  setAppState,
  finalMessage?,
  usage?,        // { totalTokens, toolUses, durationMs }
  toolUseId?,
  worktreePath?,
  worktreeBranch?
}): void
```

**状态摘要生成：**

```typescript
const summary = status === 'completed' 
  ? `Agent "${description}" completed` 
  : status === 'failed' 
    ? `Agent "${description}" failed: ${error || 'Unknown error'}` 
    : `Agent "${description}" was stopped`
```

### 去重机制

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx:224-240
let shouldEnqueue = false
updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => {
  if (task.notified) {
    return task  // 已通知过，跳过
  }
  shouldEnqueue = true
  return { ...task, notified: true }
})
if (!shouldEnqueue) return  // 防止重复通知
```

### 通知路由

> **源码**: `src/query.ts:1575-1577`

```typescript
// 子 Agent 只消费发给自己的 task-notification
return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
```

这确保了通知只被**发起该 Worker 的 Coordinator** 接收，不会被其他 Agent 截获。

---

## Worker 上下文：如何获取 Coordinator 信息？

### getCoordinatorUserContext()

> **源码**: `src/coordinator/coordinatorMode.ts:80-109`

```typescript
export function getCoordinatorUserContext(
  mcpClients,
  scratchpadDir?
): { [k: string]: string } {
  // 构建 Worker 可用工具列表（排除内部工具）
  const workerTools = isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
    ? [BASH_TOOL_NAME, FILE_READ_TOOL_NAME, FILE_EDIT_TOOL_NAME]
        .sort().join(', ')
    : Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
        .filter(name => !INTERNAL_WORKER_TOOLS.has(name))
        .sort()
        .join(', ')

  let content = `Each worker has: ${workerTools}`

  // 包含 MCP 服务器信息
  if (mcpClients.length > 0) {
    const serverNames = mcpClients.map(c => c.name).join(', ')
    content += `\n\nWorkers also have access to MCP tools from: ${serverNames}`
  }

  // 包含共享便签本目录
  if (scratchpadDir) {
    content += `\n\nShared scratchpad directory: ${scratchpadDir}`
  }

  return { workerToolsContext: content }
}
```

SIMPLE 模式下，Worker 只有 3 个工具：Bash、FileRead、FileEdit。

---

## Coordinator 系统提示词

> **源码**: `src/coordinator/coordinatorMode.ts:111-369`（258 行）

### 注入方式

> **源码**: `src/utils/systemPrompt.ts:59-75`

```typescript
if (
  feature('COORDINATOR_MODE') &&
  isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
  !mainThreadAgentDefinition  // 只对主 Coordinator，不对子 Agent
) {
  const { getCoordinatorSystemPrompt } = require('../coordinator/coordinatorMode.js')
  return asSystemPrompt([
    getCoordinatorSystemPrompt(),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
```

### 提示词核心内容

**1. 角色定义（Lines 116-126）**

Coordinator 的职责：
- 编排多个 Worker 的工作
- 直接与用户沟通
- 综合 Worker 的结果
- Worker 是"内部信号，不是对话伙伴"

**2. 并行策略指南（Lines 200-218）**

系统提示词中定义了四阶段工作流：

```
阶段          │ 执行者           │ 目的
──────────────┼─────────────────┼──────────────
Research      │ Workers (并行)  │ 调查代码库
Synthesis     │ Coordinator     │ 阅读发现，制定规格
Implementation│ Workers         │ 按规格修改代码
Verification  │ Workers         │ 测试变更是否工作
```

**关键指导原则（Line 213）：**

> "Parallelism is your superpower. Workers are async. Launch independent workers 
> concurrently whenever possible — don't serialize work that can run simultaneously."

**3. Worker Prompt 编写规则（Lines 251-335）**

- Worker **看不到** Coordinator 的对话上下文
- 必须在 prompt 中包含**所有**必要上下文
- 综合信息后再委托，不要用模糊的"based on your findings"
- 选择 continue（SendMessage）还是 spawn 新 Worker 取决于上下文重叠度

**4. Agent Tool 使用限制（Lines 135-140）**

- 不要让 Worker 交叉检查彼此的工作
- 不要让 Worker 仅仅报告文件列表
- 不要设置 model 参数
- 优先用 SendMessage 继续已有 Worker

---

## 运行时示例：分解"给 API 添加认证"

以下基于 Coordinator 系统提示词中的示例（Lines 337-369），模拟完整流程：

### 第 1 步：用户提交请求

```
用户: "There's a null pointer in the auth module. Can you fix it?"
```

### 第 2 步：Coordinator 并行发起调查

Coordinator 在**一条消息中**调用两个 AgentTool：

```typescript
// Worker 1: 调查 bug
Agent({
  description: "Investigate auth bug",
  subagent_type: "worker",
  prompt: `Investigate the auth module in src/auth/. Find where null pointer
  exceptions could occur around session handling and token validation...
  Report specific file paths, line numbers, and types involved. 
  Do not modify files.`
})

// Worker 2: 调查测试
Agent({
  description: "Research auth tests",
  subagent_type: "worker",
  prompt: `Find all test files related to src/auth/. Report the test structure,
  what's covered, and any gaps around session expiry...
  Do not modify files.`
})
```

两个 Worker 被强制异步创建，立即并行执行。

### 第 3 步：Worker 1 完成，发送通知

```xml
<task-notification>
  <task-id>agent-a1b2c3d</task-id>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42. The user field 
  on Session is undefined when the session expires but the middleware 
  still tries to access user.id...</result>
  <usage>
    <total_tokens>12450</total_tokens>
    <tool_uses>6</tool_uses>
    <duration_ms>32000</duration_ms>
  </usage>
</task-notification>
```

### 第 4 步：Coordinator 综合并继续 Worker

Coordinator 读取 Worker 1 的发现，决定**继续使用同一个 Worker**（而不是创建新 Worker），
因为该 Worker 的上下文中已经有了相关代码的理解：

```typescript
SendMessage({
  to: "agent-a1b2c3d",
  message: `Fix the null pointer in src/auth/validate.ts:42. Add a null check
  before accessing user.id — if null, return 401 with 'Session expired'.
  Also add a unit test in src/auth/__tests__/validate.test.ts covering 
  the expired session case. Commit with message 'fix: handle expired 
  session in auth validation'.`
})
```

### 第 5 步：Worker 2 完成（同时进行）

```xml
<task-notification>
  <task-id>agent-e5f6g7h</task-id>
  <status>completed</status>
  <summary>Agent "Research auth tests" completed</summary>
  <result>Found 12 test files in src/auth/__tests__/. Coverage gaps:
  1. No test for expired session + middleware interaction
  2. No test for concurrent session invalidation...</result>
</task-notification>
```

### 第 6 步：Coordinator 综合并回复用户

```
Coordinator → 用户:
  
  I found and fixed the null pointer bug in src/auth/validate.ts:42.
  
  The issue: When a session expires, the middleware continues to access 
  `user.id` on an undefined `user` field. I've added a null check that 
  returns a 401 "Session expired" response.
  
  I also added a test case covering this scenario. The fix has been 
  committed as "fix: handle expired session in auth validation".
  
  Additionally, I found two other test coverage gaps you might want 
  to address: ...
```

---

## 会话模式切换

> **源码**: `src/coordinator/coordinatorMode.ts:49-78`

```typescript
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined
): string | undefined {
  if (!sessionMode) return undefined

  const currentIsCoordinator = isCoordinatorMode()
  const sessionIsCoordinator = sessionMode === 'coordinator'

  if (currentIsCoordinator === sessionIsCoordinator) {
    return undefined  // 无需切换
  }

  // 翻转环境变量
  if (sessionIsCoordinator) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  } else {
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }

  logEvent('tengu_coordinator_mode_switched', { to: sessionMode })

  return sessionIsCoordinator
    ? 'Entered coordinator mode to match resumed session.'
    : 'Exited coordinator mode to match resumed session.'
}
```

关键点：
- 模式存储在**环境变量**中，不是持久化配置
- `--resume` 时自动匹配恢复的会话模式
- 切换是**即时生效**的——改变环境变量后，下一次 `isCoordinatorMode()` 检查立即返回新值
- 切换被记录为分析事件 `tengu_coordinator_mode_switched`

---

## Worker Agent 定义

> **源码**: `src/tools/AgentTool/builtInAgents.ts:35-42`

```typescript
if (feature('COORDINATOR_MODE')) {
  if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
    const { getCoordinatorAgents } =
      require('../../coordinator/workerAgent.js')
    return getCoordinatorAgents()
  }
}
```

Coordinator 模式激活时，内置 Agent 列表被替换为 `getCoordinatorAgents()` 返回的 Worker 定义。
`workerAgent.js` 在构建产物中生成。

---

## 进度追踪

> **源码**: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:68-96`

每个 Worker 的进度通过 `ProgressTracker` 实时更新：

```typescript
export function updateProgressFromMessage(
  tracker: ProgressTracker,
  message: Message,
  resolveActivityDescription?,
  tools?
): void {
  if (message.type !== 'assistant') return

  const usage = message.message.usage
  tracker.latestInputTokens = usage.input_tokens 
    + (usage.cache_creation_input_tokens ?? 0) 
    + (usage.cache_read_input_tokens ?? 0)
  tracker.cumulativeOutputTokens += usage.output_tokens

  for (const content of message.message.content) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++
      tracker.recentActivities.push({
        toolName: content.name,
        input,
        activityDescription: resolveActivityDescription?.(content.name, input),
        isSearch: classification?.isSearch,
        isRead: classification?.isRead
      })
    }
  }
}
```

Coordinator 可以在 UI 中实时看到每个 Worker 的：
- 累计 token 消耗
- 工具调用次数
- 最近 5 个活动描述

---

## 设计分析

### 为什么 Coordinator 不能直接操作代码？

**关注点分离**：Coordinator 的上下文窗口应该全部用于**高层推理**——理解需求、分解任务、
综合结果。如果它同时在做 grep 和 edit，上下文会被细节淹没。

**类比**：项目经理不应该自己写代码——不是因为 ta 不会，而是因为写代码会消耗 ta 本应用于
协调和决策的注意力。

### 为什么强制异步？

同步等待 Worker 完成意味着 Coordinator 在等待期间**浪费 token**（输入上下文持续传入但没有
新的推理需求）。异步执行让 Coordinator 可以：
1. 同时发起多个 Worker
2. Worker 完成时通过通知获取结果
3. 在等待期间综合已有信息

### 为什么 Worker 不能设置模型？

防止 Coordinator 做出不当的资源决策。系统提示词中的指导是：
- "Don't set the model parameter" — 让系统按默认策略分配
- Worker 的推理质量由系统层面统一管控

### Continue vs. Spawn 新 Worker 的权衡

```
场景                                    │ 选择
────────────────────────────────────────┼──────────────
Worker 的上下文中有相关代码理解           │ Continue (SendMessage)
任务与之前的工作无关                      │ Spawn 新 Worker
Worker 已经失败                          │ Spawn 新 Worker
需要不同的工具组合                        │ Spawn 新 Worker
```

Continue 通过 `SendMessage` 实现，复用 Worker 的对话上下文。
Spawn 创建全新的 `LocalAgentTask`，从零开始。

---

## 文件依赖图

```
coordinatorMode.ts (369 行) ← 核心
  ├── 被引用: systemPrompt.ts     → 注入 Coordinator 系统提示词
  ├── 被引用: toolPool.ts         → 工具过滤
  ├── 被引用: AgentTool.tsx       → 模型覆盖、强制异步
  └── 被引用: forkSubagent.ts     → 互斥检查

AgentTool.tsx (Worker 创建)
  ├── 使用: isCoordinatorMode()   → 强制异步
  ├── 使用: assembleToolPool()    → 独立 Worker 工具
  ├── 引用: workerAgent.js        → 内置 Agent 定义
  └── 引用: enqueueAgentNotification() → 任务通知

LocalAgentTask.tsx (后台执行)
  └── enqueueAgentNotification()  → 生成 XML 任务通知

query.ts (消息路由)
  └── 按 task-id 路由通知到对应 Worker 的发起者
```

---

## 快速参考

| 概念 | 说明 |
|------|------|
| 激活条件 | `feature('COORDINATOR_MODE')` + `CLAUDE_CODE_COORDINATOR_MODE=1` |
| Coordinator 工具 | Agent, TaskStop, SendMessage, SyntheticOutput |
| Worker 工具 | ASYNC_AGENT_ALLOWED_TOOLS - INTERNAL_WORKER_TOOLS + MCP |
| 通知格式 | `<task-notification>` XML |
| 通知去重 | `notified` 标志位 |
| Worker 创建 | AgentTool → 强制异步 + 独立工具池 |
| Worker 继续 | SendMessage → 复用对话上下文 |
| Worker 停止 | TaskStopTool → kill + 通知 |
| 模式切换 | 环境变量翻转，即时生效 |
| 四阶段流程 | Research → Synthesis → Implementation → Verification |
