# Q: 7 种任务类型分别解决什么问题？如何选择？


---

## 为什么需要 7 种任务类型？

Claude Code 的多 Agent 系统面临一个根本问题：**不同的后台工作有截然不同的生命周期和状态需求**。

一个 Shell 命令需要跟踪退出码和中断状态；一个 AI Agent 需要跟踪 token 消耗和工具调用；
一个远程任务需要轮询外部服务器。用单一泛型类型表示所有这些，要么字段爆炸，要么丧失类型安全。

解决方案是 **可辨识联合（Discriminated Union）**：每种任务类型有独立的状态类型，
通过 `task.type` 字段区分。TypeScript 编译器能在每个分支中精确推断字段类型。

---

## 共享基座：TaskStateBase

所有 7 种任务都继承同一个基座结构（`src/Task.ts`）：

```typescript
// src/Task.ts
interface TaskStateBase {
  id: string              // 带类型前缀的 ID（b/a/r/t/w/m/d）
  type: TaskType          // 可辨识联合的判别字段
  status: TaskStatus      // pending | running | completed | failed | killed
  description: string     // 人类可读描述
  toolUseId?: string      // 触发此任务的 LLM tool_use ID
  startTime: number       // Date.now() 创建时间戳
  endTime?: number        // 终态时设置
  totalPausedMs?: number  // 暂停累计毫秒
  outputFile: string      // 任务输出文件路径
  outputOffset: number    // 流式增量读取偏移
  notified: boolean       // 防止重复通知的标志位
}
```

### 任务状态机

```
         ┌─────────┐
         │ pending  │
         └────┬─────┘
              │
         ┌────▼─────┐
         │ running   │
         └──┬──┬──┬──┘
            │  │  │
   ┌────────┘  │  └────────┐
   ▼           ▼           ▼
completed    failed      killed
```

三个终态由 `isTerminalTaskStatus()` 判断。一旦进入终态，任务在 UI 中保留一段时间后被驱逐：
- Shell 任务：3 秒（`STOPPED_DISPLAY_MS`）
- Agent 任务：30 秒（`PANEL_GRACE_MS`），允许用户查看最终输出

---

## 类型 1：LocalShellTask —— Shell 命令执行

> **源码**: `src/tasks/LocalShellTask/guards.ts:11-32`，`LocalShellTask.tsx`

### 解决什么问题？

在后台执行 Bash 命令（如 `npm test`、`cargo build`），同时不阻塞主 Agent 对话。

### 状态定义

```typescript
// src/tasks/LocalShellTask/guards.ts
interface LocalShellTaskState extends TaskStateBase {
  type: 'local_bash'
  command: string                          // 执行的命令
  result: { code: number; interrupted: boolean }  // 退出码 + 是否被中断
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null        // 底层 Shell 进程引用
  lastReportedTotalLines: number           // 输出增量追踪
  isBackgrounded: boolean                  // 是否在后台运行
  agentId?: AgentId                        // 关联的父 Agent
  kind?: 'bash' | 'monitor'               // 显示变体
}
```

### 生命周期

```
用户/Agent 调用 BashTool → spawnShellTask(input, context) → 注册任务
     │
     ▼
  status: running  ──→  Shell 进程执行中，实时追踪输出行数
     │
     ├─ 正常退出 ──→  status: completed, result.code = 退出码
     ├─ 用户停止 ──→  status: killed, result.interrupted = true
     └─ 异常退出 ──→  status: failed, result.code = 非零
```

### 何时使用？

- 编译项目、运行测试、执行脚本
- 需要追踪退出码和命令输出
- ID 前缀：`b`（如 `b-abc123`）

---

## 类型 2：LocalAgentTask —— 本地后台 Agent

> **源码**: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:116-148`

### 解决什么问题？

在后台运行独立的 AI Agent（子代理），它有自己的对话上下文、工具调用权限和 token 预算。
这是 **Coordinator 模式和 AgentTool 的核心执行载体**。

### 状态定义

```typescript
// src/tasks/LocalAgentTask/LocalAgentTask.tsx
interface LocalAgentTaskState extends TaskStateBase {
  type: 'local_agent'
  agentId: string                      // Agent 唯一标识
  prompt: string                       // 初始 prompt
  selectedAgent?: AgentDefinition      // Agent 定义（worker/code-review 等）
  agentType: string                    // Agent 类型名称
  model?: string                       // 模型选择
  abortController?: AbortController    // 取消控制
  error?: string                       // 错误信息

  // 进度追踪
  progress?: {
    toolUseCount: number
    tokenCount: number
    lastActivity?: ToolActivity
    recentActivities?: ToolActivity[]  // 最多 5 个最近活动
    summary?: string
  }

  // 消息管理（UI 中最多 50 条，磁盘保留全量）
  messages?: Message[]
  pendingMessages: string[]            // 中途注入的消息

  // 生命周期控制
  retrieved: boolean                   // 结果是否已被父 Agent 读取
  retain: boolean                      // UI 是否持有此任务
  diskLoaded: boolean                  // 消息是否从磁盘加载
  evictAfter?: number                  // 宽限截止时间（30 秒）

  result?: AgentToolResult             // 最终结果
  isBackgrounded: boolean
}
```

### 生命周期

```
AgentTool 调用 → 创建 LocalAgentTask → 注册到 AppState
     │
     ▼
  status: running  ──→  独立 LLM 推理循环
     │                    ├─ 实时更新 progress（token、工具调用）
     │                    ├─ pendingMessages 排队中途消息
     │                    └─ 最多保留 50 条消息在内存
     │
     ├─ Agent 完成 ──→  status: completed
     │                    └─ 发送 <task-notification> XML
     ├─ Agent 出错 ──→  status: failed
     └─ 被停止    ──→  status: killed (killAsyncAgent)
     
完成后 30 秒（PANEL_GRACE_MS）──→  从 AppState 驱逐
```

### 关键机制：任务通知

Agent 完成时，`enqueueAgentNotification()` 生成 XML 通知：

```xml
<task-notification>
  <task-id>agent-a1b2c3d</task-id>
  <status>completed</status>
  <summary>Agent "Investigate auth bug" completed</summary>
  <result>Found null pointer in src/auth/validate.ts:42...</result>
  <usage>
    <total_tokens>15234</total_tokens>
    <tool_uses>8</tool_uses>
    <duration_ms>45000</duration_ms>
  </usage>
</task-notification>
```

通知有去重机制：`notified` 标志位确保同一任务只发送一次通知。

### 何时使用？

- Coordinator 分派 Worker 任务
- 用户通过 AgentTool 创建后台 Agent
- ID 前缀：`a`

---

## 类型 3：RemoteAgentTask —— 远程编排任务

> **源码**: `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:22-59`

### 解决什么问题？

与 Anthropic 远程编排服务器交互，执行需要云端资源的任务（如 Ultra Plan、Ultra Review、
自动修复 PR）。本地 CLI 充当轮询客户端。

### 状态定义

```typescript
// src/tasks/RemoteAgentTask/RemoteAgentTask.tsx
interface RemoteAgentTaskState extends TaskStateBase {
  type: 'remote_agent'
  remoteTaskType: RemoteTaskType       // 子类型判别
  //   'remote-agent' | 'ultraplan' | 'ultrareview' |
  //   'autofix-pr' | 'background-pr'
  
  remoteTaskMetadata?: {               // GitHub PR 关联
    owner: string
    repo: string
    prNumber: number
  }
  
  sessionId: string                    // 远程 session ID
  command: string                      // 触发命令
  title: string                        // 显示标题
  todoList: TodoList                   // 任务清单
  log: SDKMessage[]                    // 远程消息日志
  
  // 长时间运行支持
  isLongRunning?: boolean
  pollStartedAt: number                // 轮询开始时间
  
  // Review 专用进度
  isRemoteReview?: boolean
  reviewProgress?: {
    stage?: 'finding' | 'verifying' | 'synthesizing'
    bugsFound: number
    bugsVerified: number
    bugsRefuted: number
  }
  
  // Ultraplan 专用
  isUltraplan?: boolean
  ultraplanPhase?: UltraplanPhase      // 'needs_input' | 'plan_ready' 等
}
```

### 生命周期

```
用户触发远程命令 → 创建 RemoteAgentTask → 开始轮询
     │
     ▼
  status: running  ──→  每秒轮询远程编排服务器
     │                    ├─ 更新 log（远程消息）
     │                    ├─ 更新 todoList（任务进度）
     │                    └─ 更新 reviewProgress / ultraplanPhase
     │
     ├─ 远程完成    ──→  completionChecker 检测 → status: completed
     ├─ 远程失败    ──→  status: failed
     └─ 用户停止    ──→  归档远程 session → status: killed
```

### 完成检测

远程任务使用注册式完成检查器：

```typescript
registerCompletionChecker(remoteTaskType, checker)
```

不同的 `remoteTaskType` 有不同的完成条件。元数据持久化到 session sidecar 文件，
确保 `--resume` 时能恢复。

### 何时使用？

- Ultra Plan（大规模代码规划）
- Ultra Review（深度代码审查）
- 自动修复 PR、后台 PR 操作
- ID 前缀：`r`

---

## 类型 4：InProcessTeammateTask —— 同进程队友

> **源码**: `src/tasks/InProcessTeammateTask/types.ts:22-76`

### 解决什么问题？

在**同一个 Node.js 进程**中运行多个 Agent（队友），共享 AppState，通过消息队列通信。
这是 Team 模式的核心，比 LocalAgentTask 更深度集成。

### 状态定义

```typescript
// src/tasks/InProcessTeammateTask/types.ts
interface InProcessTeammateTaskState extends TaskStateBase {
  type: 'in_process_teammate'
  
  // 身份信息
  identity: {
    agentId: string              // "researcher@my-team"
    agentName: string            // "researcher"
    teamName: string
    color?: string               // 分配的颜色
    planModeRequired: boolean
    parentSessionId: string      // Leader 的 session ID
  }

  prompt: string
  model?: string
  selectedAgent?: AgentDefinition
  permissionMode: PermissionMode
  
  // 双层取消控制
  abortController?: AbortController              // 终止整个 Agent
  currentWorkAbortController?: AbortController    // 仅终止当前轮次
  
  // Plan 模式集成
  awaitingPlanApproval: boolean
  
  // 进度
  progress?: AgentProgress
  messages?: Message[]           // UI 中最多 50 条
  inProgressToolUseIDs?: Set<string>
  
  // 消息缓冲
  pendingUserMessages: string[]  // 等待注入的用户消息
  
  // 空闲管理
  isIdle: boolean                // 当前是否在等待工作
  shutdownRequested: boolean     // 是否收到关闭请求
  onIdleCallbacks?: Array<() => void>
  
  // Spinner 显示
  spinnerVerb?: string
  pastTenseVerb?: string
}
```

### 与 LocalAgentTask 的关键区别

| 维度 | LocalAgentTask | InProcessTeammateTask |
|------|---------------|----------------------|
| 进程模型 | 独立推理循环 | 同进程，AsyncLocalStorage 隔离 |
| 通信方式 | `<task-notification>` XML | 消息队列 + 邮箱 |
| 空闲状态 | 无 | `isIdle` + `onIdleCallbacks` |
| 权限模型 | 继承父 Agent | 独立 `permissionMode` |
| Plan 模式 | 无 | `awaitingPlanApproval` |
| 关闭协议 | `killAsyncAgent()` | `requestTeammateShutdown()` 协商 |
| 注册表 | 在 tasks registry | **不在** registry，独立管理 |

### 生命周期

```
TeamCreateTool 创建团队 → 成员 join → 创建 InProcessTeammateTask
     │
     ▼
  status: running, isIdle: true  ──→  等待工作
     │
     ├─ 收到消息 ──→  isIdle: false ──→  LLM 推理
     │                                      │
     │                ┌─────────────────────┘
     │                ▼
     │          轮次完成 ──→  isIdle: true ──→  等待下一条消息
     │
     ├─ 收到 shutdown_request ──→  shutdownRequested: true
     │    └─ 发送 shutdown_approved ──→  status: completed
     │
     └─ 被强制终止 ──→  status: killed
```

### 何时使用？

- Team 模式下的同进程队友
- 需要频繁双向通信的协作场景
- 需要 Plan 审批流程的场景
- ID 前缀：`t`

---

## 类型 5：LocalWorkflowTask —— 本地工作流

> **源码**: `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`（特性门控）

### 解决什么问题？

执行预定义的多步骤工作流脚本，按序编排多个 Agent 步骤。

### 特性门控

```typescript
// src/tasks.ts — 条件加载
if (feature('WORKFLOW_SCRIPTS')) {
  // 动态导入 LocalWorkflowTask
}
```

此类型在 `feature('WORKFLOW_SCRIPTS')` 特性标志开启时才可用。
源码在构建产物中生成，不在 `src/` 目录树中直接可见。

### 何时使用？

- 预定义的多步骤自动化工作流
- 需要按序协调多个 Agent 的场景
- ID 前缀：`w`

---

## 类型 6：MonitorMcpTask —— MCP 监控

> **源码**: `src/tasks/MonitorMcpTask/MonitorMcpTask.ts`（特性门控）

### 解决什么问题？

监控 MCP（Model Context Protocol）服务器的运行状态和输出。

### 特性门控

```typescript
// src/tasks.ts — 条件加载
if (feature('MONITOR_TOOL')) {
  // 动态导入 MonitorMcpTask
}
```

与 LocalWorkflowTask 类似，在特性标志 `feature('MONITOR_TOOL')` 开启时才可用。

### 何时使用？

- 监控 MCP 服务器运行状态
- 追踪 MCP 工具的实时输出
- ID 前缀：`m`

---

## 类型 7：DreamTask —— 记忆梦境整理

> **源码**: `src/tasks/DreamTask/DreamTask.ts:25-41`

### 解决什么问题？

在后台自动整理和压缩 Agent 的记忆文件（CLAUDE.md 等），类似人类睡眠时的记忆整理。
这是一个完全自动化的后台任务，不需要用户干预。

### 状态定义

```typescript
// src/tasks/DreamTask/DreamTask.ts
interface DreamTaskState extends TaskStateBase {
  type: 'dream'
  phase: DreamPhase              // 'starting' | 'updating'
  sessionsReviewing: number      // 正在回顾的会话数
  filesTouched: string[]         // 修改的文件列表（不完整，仅模式匹配）
  turns: DreamTurn[]             // 最多 30 轮
  //   { text: string; toolUseCount: number }
  abortController?: AbortController
  priorMtime: number             // 用于 kill 时回滚锁文件
}
```

### 四阶段结构

```
orient（定向）
  └─ 分析当前记忆文件状态
     │
     ▼
gather（收集）
  └─ 回顾最近的会话记录
     │
     ▼
consolidate（整合）
  └─ 压缩和合并重复/冗余的记忆
     │
     ▼
prune（修剪）
  └─ 删除过时的记忆条目
```

### 安全机制

- **最大轮次限制**：`MAX_TURNS = 30`，防止无限循环
- **锁回滚**：`priorMtime` 记录整合前的 mtime，kill 时可以回滚
- **文件追踪不完整**：`filesTouched` 仅通过模式匹配检测，无法捕获通过 bash 中介写入的文件

### 何时使用？

- 自动触发，不需要用户手动创建
- 会话空闲时自动启动记忆整理
- ID 前缀：`d`

---

## 任务注册表与管理

### 注册表（src/tasks.ts）

```typescript
export function getAllTasks(): Task[] {
  const tasks = [LocalShellTask, LocalAgentTask, RemoteAgentTask, DreamTask]
  
  if (feature('WORKFLOW_SCRIPTS')) {
    tasks.push(LocalWorkflowTask)
  }
  if (feature('MONITOR_TOOL')) {
    tasks.push(MonitorMcpTask)
  }
  
  return tasks
}

export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
```

**注意**：`InProcessTeammateTask` 不在注册表中！它通过 `findTeammateTaskByAgentId()` 独立管理。

### Task 接口

每种任务类型必须实现：

```typescript
interface Task {
  name: string       // 显示名称
  type: TaskType     // 类型标识
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

### 框架函数（src/utils/task/framework.ts）

| 函数 | 作用 |
|------|------|
| `registerTask(task, setAppState)` | 注册任务到 AppState，发送 SDK `task_started` 事件 |
| `updateTaskState<T>(taskId, setAppState, updater)` | 类型安全的不可变更新 |
| `evictTerminalTask(taskId, setAppState)` | 驱逐终态任务（尊重宽限期） |
| `getRunningTasks(state)` | 获取所有运行中的任务 |
| `generateTaskAttachments(state)` | 计算输出增量，标记待驱逐任务 |
| `pollTasks(getAppState, setAppState)` | 主轮询循环（每 1 秒） |

### 轮询机制

```typescript
const POLL_INTERVAL_MS = 1000      // 每秒轮询一次运行中的任务
const STOPPED_DISPLAY_MS = 3_000   // killed 任务显示 3 秒
const PANEL_GRACE_MS = 30_000      // Agent 任务完成后保留 30 秒
```

---

## 6 个任务管理工具

### TaskCreateTool

```
目的：在 TodoV2 列表中创建任务项
输入：{ subject, description, activeForm?, metadata? }
输出：{ task: { id, subject } }
特点：延迟执行，并发安全，触发 TaskCreated hooks
```

### TaskListTool

```
目的：列出所有任务
输入：{}
输出：{ tasks: [{ id, subject, status, owner?, blockedBy }] }
特点：只读，过滤内部任务
```

### TaskGetTool

```
目的：按 ID 获取单个任务
输入：{ taskId }
输出：{ task: {...} | null }
特点：只读
```

### TaskUpdateTool

```
目的：更新任务状态
输入：{ taskId, subject?, description?, status?, addBlocks?, owner?, metadata? }
输出：{ success, taskId, updatedFields, statusChange?, verificationNudgeNeeded? }
特点：
  - status='deleted' 实现删除
  - 完成时触发 TaskCompleted hooks
  - 自动设置 owner（当队友标记 in_progress 时）
  - 通过邮箱通知新 owner
```

### TaskStopTool

```
目的：停止运行中的后台任务
输入：{ task_id?, shell_id? }
输出：{ message, task_id, task_type, command? }
流程：
  1. 查找任务 → 验证状态 === 'running'
  2. 获取任务实现 → 调用 task.kill()
  3. Shell 任务抑制通知（标记 notified=true）
```

### TaskOutputTool

```
目的：获取任意类型任务的输出
输入：{ task_id, block? (默认 true), timeout? (默认 30s，最大 600s) }
输出：{ retrieval_status, task: { task_id, status, description, output, ... } }
特点：
  - 支持所有 7 种任务类型
  - 类型特定字段提取（exitCode 仅 Shell，result 仅 Agent）
  - 支持阻塞等待
```

---

## stopTask 的统一停止逻辑

> **源码**: `src/tasks/stopTask.ts:38-100`

```typescript
function stopTask(taskId, setAppState) {
  // 1. 在 AppState.tasks 中查找任务
  // 2. 验证：存在 && status === 'running'
  // 3. 获取实现：getTaskByType(task.type)
  // 4. 调用：task.kill(taskId, setAppState)
  // 5. Shell 任务特殊处理：抑制通知
  // 6. 返回：{ taskId, taskType, command }
}
```

每种类型的 kill 实现不同：

| 类型 | Kill 方法 |
|------|----------|
| LocalShellTask | `killTask()` — 终止 Shell 进程 |
| LocalAgentTask | `killAsyncAgent()` — 触发 AbortController |
| RemoteAgentTask | 归档远程 session → 标记 killed |
| InProcessTeammateTask | `killInProcessTeammate()` — 终止推理循环 |
| DreamTask | 触发 AbortController → 回滚整合锁 |

---

## 设计分析：为什么是 7 种而不是 1 种？

### 方案对比

**方案 A：单一泛型任务**

```typescript
interface GenericTask {
  type: string
  state: Record<string, unknown>  // 丧失类型安全
}
```

问题：
- 每次访问状态字段都需要类型断言
- 编译器无法验证字段存在性
- 错误只在运行时发现

**方案 B：可辨识联合（当前方案）**

```typescript
type TaskState = LocalShellTaskState | LocalAgentTaskState | ...

function handleTask(task: TaskState) {
  switch (task.type) {
    case 'local_bash':
      // TypeScript 自动推断 task 为 LocalShellTaskState
      console.log(task.command)  // ✓ 类型安全
      break
    case 'local_agent':
      console.log(task.progress?.toolUseCount)  // ✓ 类型安全
      break
  }
}
```

优势：
- **编译时类型安全**：每个分支中精确推断字段类型
- **独立演进**：添加新任务类型不影响现有类型
- **特性门控友好**：条件加载的类型不会污染核心类型
- **Kill 方法多态**：每种类型有专属的终止逻辑

### 关键设计决策

1. **InProcessTeammateTask 不在注册表中** — 因为它的生命周期由 Team 系统独立管理，
   不适合通用的 `getAllTasks()` / `pollTasks()` 框架

2. **特性门控的条件加载** — LocalWorkflowTask 和 MonitorMcpTask 通过 `feature()` 
   门控，只在启用时才注册。这避免了未发布功能的代码路径污染

3. **ID 前缀约定** — `b/a/r/t/w/m/d` 前缀让人类和代码都能从 ID 判断任务类型，
   无需查表

4. **输出文件流式读取** — `outputFile` + `outputOffset` 支持增量读取，
   避免大输出的内存膨胀

---

## 快速选择指南

```
我需要运行一个 Shell 命令
  └─ LocalShellTask (local_bash)

我需要启动一个独立的 AI Agent
  └─ LocalAgentTask (local_agent)

我需要调用 Anthropic 的远程服务
  └─ RemoteAgentTask (remote_agent)

我需要在同进程中创建团队协作
  └─ InProcessTeammateTask (in_process_teammate)

我需要执行预定义的多步工作流
  └─ LocalWorkflowTask (local_workflow)  [需要特性标志]

我需要监控 MCP 服务器
  └─ MonitorMcpTask (monitor_mcp)  [需要特性标志]

系统需要自动整理记忆
  └─ DreamTask (dream)  [自动触发]
```

---

## 完整文件映射

```
核心类型：
  src/Task.ts                                  — TaskType, TaskStatus, TaskStateBase, ID 生成
  src/tasks.ts                                 — 任务注册表（getAllTasks, getTaskByType）
  src/tasks/types.ts                           — TaskState 联合类型, isBackgroundTask()

任务实现：
  src/tasks/LocalShellTask/guards.ts           — LocalShellTaskState
  src/tasks/LocalAgentTask/LocalAgentTask.tsx   — LocalAgentTaskState + 通知机制
  src/tasks/RemoteAgentTask/RemoteAgentTask.tsx — RemoteAgentTaskState + 轮询
  src/tasks/InProcessTeammateTask/types.ts     — InProcessTeammateTaskState
  src/tasks/DreamTask/DreamTask.ts             — DreamTaskState + 四阶段结构

框架：
  src/utils/task/framework.ts                  — registerTask, updateTaskState, pollTasks
  src/tasks/stopTask.ts                        — stopTask() 统一停止

工具：
  src/tools/TaskCreateTool/TaskCreateTool.ts   — 创建任务
  src/tools/TaskListTool/TaskListTool.ts       — 列出任务
  src/tools/TaskGetTool/TaskGetTool.ts         — 获取任务
  src/tools/TaskUpdateTool/TaskUpdateTool.ts   — 更新任务
  src/tools/TaskStopTool/TaskStopTool.ts       — 停止任务
  src/tools/TaskOutputTool/TaskOutputTool.tsx   — 读取任务输出
```
