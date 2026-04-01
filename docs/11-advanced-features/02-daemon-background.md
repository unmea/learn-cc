# Q: 后台任务如何管理？

## 一句话回答

Claude Code 提供三层后台任务架构：`--bg` 后台会话、`daemon` 守护进程、以及定时任务调度器，通过 `~/.claude/sessions/` 注册表统一管理会话生命周期。

---

## 1. 后台任务架构总览

### 1.1 三层架构

```
┌─────────────────────────────────────────────────────┐
│  第三层: Daemon 守护进程                              │
│  claude daemon start                                │
│  ├── 长驻守护进程                                    │
│  ├── 管理 Worker 进程                                │
│  └── 定时任务调度: watchScheduledTasks()             │
├─────────────────────────────────────────────────────┤
│  第二层: 后台会话 (--bg)                              │
│  claude --bg "fix this bug"                         │
│  ├── 分离的 REPL 进程                                │
│  ├── 终端断开后继续运行                               │
│  └── 通过 ps/logs/attach/kill 管理                   │
├─────────────────────────────────────────────────────┤
│  第一层: 交互式 REPL                                  │
│  claude                                             │
│  ├── 完整 UI                                         │
│  ├── 内联调度器                                      │
│  └── 终端关闭即退出                                   │
└─────────────────────────────────────────────────────┘
```

### 1.2 功能特性标志

| 标志 | 用途 |
|------|------|
| `DAEMON` | 启用守护进程管理器和 Worker 生成路径 |
| `BG_SESSIONS` | 启用 `--bg` 标志和 ps/logs/attach/kill 命令 |
| `KAIROS` | 助手守护模式（定时任务、远程控制） |
| `DISABLE_BACKGROUND_TASKS` | 完全禁用后台任务机制 |

---

## 2. 入口路由

### 2.1 CLI 入口分发

> 源码: `src/entrypoints/cli.tsx:95-209`

```typescript
// 快速路径: Daemon Worker（由守护进程生成）
if (feature('DAEMON') && args[0] === '--daemon-worker') {
  const { runDaemonWorker } = await import('../daemon/workerRegistry.js')
  await runDaemonWorker(args[1])
  return
}

// 主路径: Daemon 守护进程
if (feature('DAEMON') && args[0] === 'daemon') {
  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()
  const { initSinks } = await import('../utils/sinks.js')
  initSinks()
  const { daemonMain } = await import('../daemon/main.js')
  await daemonMain(args.slice(1))
  return
}

// 后台会话管理命令
if (feature('BG_SESSIONS') && (
  args[0] === 'ps' || args[0] === 'logs' ||
  args[0] === 'attach' || args[0] === 'kill' ||
  args.includes('--bg') || args.includes('--background')
)) {
  const bg = await import('../cli/bg.js')
  switch (args[0]) {
    case 'ps':      await bg.psHandler(args.slice(1));  break
    case 'logs':    await bg.logsHandler(args[1]);      break
    case 'attach':  await bg.attachHandler(args[1]);    break
    case 'kill':    await bg.killHandler(args[1]);      break
    default:        await bg.handleBgFlag(args);        break
  }
}
```

关键设计: Daemon Worker 使用 **精简启动路径**，不加载 `enableConfigs()` 或分析 sinks，性能优先。

---

## 3. 会话注册表

### 3.1 注册机制

> 源码: `src/utils/concurrentSessions.ts`

所有会话（无论类型）都注册在 `~/.claude/sessions/` 目录下，每个进程一个 JSON 文件：

```typescript
// 会话类型
export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'

// 注册表目录
function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

// 注册会话（写入 PID 文件）
export async function registerSession(): Promise<boolean> {
  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const pidFile = join(dir, `${process.pid}.json`)

  await writeFile(pidFile, jsonStringify({
    pid: process.pid,
    sessionId: getSessionId(),
    cwd: getOriginalCwd(),
    startedAt: Date.now(),
    kind,                        // 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    name: process.env.CLAUDE_CODE_SESSION_NAME,
    logPath: process.env.CLAUDE_CODE_SESSION_LOG,
    agent: process.env.CLAUDE_CODE_AGENT,
  }))
}
```

### 3.2 文件格式

```json
// ~/.claude/sessions/12345.json
{
  "pid": 12345,
  "sessionId": "sess_abc123",
  "cwd": "/Users/dev/my-project",
  "startedAt": 1719500000000,
  "kind": "bg",
  "entrypoint": "--bg",
  "name": "fix-bug-session",
  "logPath": "/Users/dev/.claude/logs/sess_abc123.log",
  "agent": null
}
```

### 3.3 生命周期

```
进程启动 → registerSession() → 写入 PID 文件
                                    ↓
                              进程运行中...
                                    ↓
进程退出 → cleanup registry → 删除 PID 文件
```

- `claude ps` 枚举此目录获取所有活跃会话
- 文件在进程退出时通过清理注册表自动删除
- 元数据用于筛选和状态展示

---

## 4. 后台会话命令

### 4.1 claude ps — 列出会话

列出所有正在运行的后台会话：

```bash
$ claude ps
ID         KIND    CWD                    STARTED         NAME
sess_abc   bg      /Users/dev/my-project  2 hours ago     fix-bug
sess_def   daemon  /Users/dev/api         1 day ago       api-watcher
```

实现方式: 读取 `~/.claude/sessions/` 目录下所有 JSON 文件，过滤存活进程。

### 4.2 claude logs — 查看日志

```bash
$ claude logs sess_abc123
# 或使用简短 ID
$ claude logs abc
```

读取会话注册时记录的 `logPath`，流式输出日志内容。

### 4.3 claude attach — 附着到会话

```bash
$ claude attach sess_abc123
```

将当前终端连接到运行中的后台会话，恢复交互式控制。

### 4.4 claude kill — 终止会话

```bash
$ claude kill sess_abc123
```

向目标进程发送终止信号。

### 4.5 --bg 标志 — 启动后台会话

```bash
$ claude --bg "fix the authentication bug in src/auth.ts"
```

将任务在后台启动，分离终端，会话持续运行。

---

## 5. 环境变量

### 5.1 由启动器设置的环境变量

| 环境变量 | 值 | 用途 |
|----------|-----|------|
| `CLAUDE_CODE_SESSION_KIND` | `'bg'` \| `'daemon'` \| `'daemon-worker'` | 注册表中的会话类型 |
| `CLAUDE_CODE_SESSION_NAME` | 字符串 | `claude ps` 的显示名称 |
| `CLAUDE_CODE_SESSION_LOG` | 路径 | `claude logs` 的日志文件路径 |
| `CLAUDE_CODE_AGENT` | agent-id | 会话绑定的 Agent |
| `CLAUDE_CODE_ENTRYPOINT` | 字符串 | 会话的启动方式 |
| `CLAUDE_CODE_MESSAGING_SOCKET` | 路径 | UDS 消息套接字（UDS_INBOX 标志） |

---

## 6. Daemon 守护进程

### 6.1 守护进程架构

```
claude daemon start
       │
       ▼
  daemonMain(args)
       │
       ├── enableConfigs()     // 加载完整配置
       ├── initSinks()         // 初始化分析
       │
       ▼
  Daemon 主管 (supervisor)
       │
       ├── 管理 Worker 进程
       │   └── spawn: --daemon-worker=<kind>
       │
       ├── 定时任务调度
       │   └── watchScheduledTasks()
       │
       └── 远程控制连接
           └── connectRemoteControl()
```

### 6.2 Worker 生成

Daemon Worker 通过 `--daemon-worker` 标志生成，启动路径精简：

```typescript
// 启动路径（cli.tsx:95-106）
if (feature('DAEMON') && args[0] === '--daemon-worker') {
  const { runDaemonWorker } = await import('../daemon/workerRegistry.js')
  await runDaemonWorker(args[1])  // args[1] = worker kind
  return
}
```

关键优化:
- **不调用** `enableConfigs()`（配置由 Worker 内部按需加载）
- **不初始化**分析 sinks（避免启动开销）
- 轻量级启动路径，优先保证性能

### 6.3 Worker 类型

> 源码: `src/bridge/types.ts:72-96`

```typescript
export type BridgeWorkerType = 'claude_code' | 'claude_code_assistant'
```

| Worker 类型 | 描述 | 用途 |
|------------|------|------|
| `claude_code` | 标准 REPL/CLI 模式 | 普通代码任务 |
| `claude_code_assistant` | 助手守护模式 | KAIROS 助手功能 |

Worker 类型在环境注册时作为 `metadata.worker_type` 发送，用于 Web UI 筛选。

---

## 7. 定时任务系统

### 7.1 任务定义

> 源码: `src/utils/cronTasks.ts:30-70`

任务存储在项目的 `.claude/scheduled_tasks.json` 文件中：

```typescript
export type CronTask = {
  id: string                  // 唯一任务 ID
  cron: string                // 5 字段 cron 表达式（本地时间）
  prompt: string              // 触发时入队的 Prompt
  createdAt: number           // 创建时间戳（毫秒）
  lastFiredAt?: number        // 上次触发时间戳
  recurring?: boolean         // 是否循环（否则单次触发后删除）
  permanent?: boolean         // 豁免自动过期（系统任务）
  durable?: boolean           // 仅运行时，不写入磁盘
  agentId?: string            // 仅运行时，由哪个 Agent 创建
}
```

### 7.2 任务类型

| 类型 | 行为 | 生命周期 |
|------|------|----------|
| **单次任务** | 触发一次后自动删除 | 临时 |
| **循环任务** | 触发后重新安排 | 持续到删除或超过 `recurringMaxAgeMs` |
| **永久任务** | 豁免自动过期 | 系统内置任务 |

### 7.3 调度器

> 源码: `src/utils/cronScheduler.ts:40-150`

```typescript
type CronSchedulerOptions = {
  onFire: (prompt: string) => void          // 任务触发回调
  isLoading: () => boolean                  // 加载中时延迟触发
  assistantMode?: boolean                   // 自动启用，绕过门控
  onFireTask?: (task: CronTask) => void     // 完整任务对象（Daemon 用）
  onMissed?: (tasks: CronTask[]) => void    // 启动时发现的错过任务
  dir?: string                              // Daemon 调用者（无 bootstrap）
  lockIdentity?: string                     // 稳定的锁标识
  getJitterConfig?: () => CronJitterConfig  // 实时抖动调优
  isKilled?: () => boolean                  // 终止开关（每 tick 检查）
  filter?: (t: CronTask) => boolean         // 逐任务门控
}

export type CronScheduler = {
  start: () => void
  stop: () => void
  getNextFireTime: () => number | null       // Daemon 用此决定是否保持子进程
}
```

### 7.4 REPL vs Daemon 的调度差异

| 方面 | REPL 调度 | Daemon 调度 |
|------|-----------|-------------|
| 入口 | 内联调度器 | `watchScheduledTasks()` API |
| 回调 | `onFire(prompt)` — 仅 prompt | `onFireTask(task)` — 完整任务对象 |
| 过滤 | 全部任务 | `filter: (t) => t.permanent`（仅永久任务） |
| 锁标识 | 会话 ID | 稳定 UUID |
| 目录 | Bootstrap 状态推断 | 显式传入 `dir` |

---

## 8. SDK 守护函数

### 8.1 watchScheduledTasks()

> 源码: `src/entrypoints/agentSdkTypes.ts:350-356`

```typescript
export function watchScheduledTasks(opts: {
  dir: string                              // .claude/scheduled_tasks.json 所在目录
  signal: AbortSignal                      // 停止监听
  getJitterConfig?: () => CronJitterConfig // 实时调优
}): ScheduledTasksHandle {
  // 返回:
  // - events(): AsyncGenerator<ScheduledTaskEvent>
  //   - { type: 'fire'; task: CronTask }
  //   - { type: 'missed'; tasks: CronTask[] }
  // - getNextFireTime(): number | null
}
```

### 8.2 connectRemoteControl()

> 源码: `src/entrypoints/agentSdkTypes.ts:439-443`

```typescript
export async function connectRemoteControl(
  opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null>
```

用于 Daemon 进程从 claude.ai 接收远程控制：
- Daemon 在**父进程**中持有 WebSocket
- Agent 子进程通过 `query()` 运行
- 子进程崩溃时，Daemon 重新生成，claude.ai 保持同一会话
- 通过 `write()` + `sendResult()` 管道传递 `query()` 输出
- 通过 `inboundPrompts()` 读取用户提示
- 本地处理控制请求（中断、切换模型）

---

## 9. 四种会话类型对比

| 方面 | Interactive | BG Session | Daemon | Daemon-Worker |
|------|-------------|------------|--------|---------------|
| **SessionKind** | `'interactive'` | `'bg'` | `'daemon'` | `'daemon-worker'` |
| **管理者** | 无 | REPL/bg 启动器 | Daemon 主管 | Daemon |
| **退出行为** | 终止进程 | 分离 TUI，会话持续 | 重启 Workers | Daemon 重启它 |
| **查询路径** | 标准 Prompt 循环 | 后台化查询 | 按任务生成 | 由主管生成 |
| **Cron 支持** | REPL 调度器 | REPL 调度器 | `watchScheduledTasks()` | 不直接支持 |
| **配置加载** | 完整 `enableConfigs()` | 完整 | 完整 | 延迟/内部 |
| **分析** | 完整 sinks | 完整 | 完整 | 精简/无 |
| **入口** | 标准 CLI | `--bg` 标志 | `claude daemon start` | `--daemon-worker=<kind>` |

---

## 10. 会话持久化设计

### 10.1 跨终端断开的持久性

后台会话的核心价值在于**终端断开后继续运行**。实现方式：

```
claude --bg "长时间任务"
       │
       ▼
    分离终端 (detach TUI)
       │
       ▼
    进程独立运行
    ├── 写入日志到 logPath
    ├── PID 文件保持在 ~/.claude/sessions/
    └── 不依赖任何终端 TTY
       │
       ▼
    用户随时可:
    ├── claude ps        → 查看状态
    ├── claude logs <id> → 查看进度
    ├── claude attach <id> → 重新连接
    └── claude kill <id> → 终止任务
```

### 10.2 Daemon 的进程管理

Daemon 守护进程提供更强的持久性保证：

```
Daemon 主管 (supervisor)
       │
       ├── Worker 崩溃 → 自动重启
       ├── 定时任务触发 → 生成 Worker
       ├── Worker 完成 → 清理资源
       └── getNextFireTime() → 决定是否保持 Worker 温启动
```

---

## 11. 定时任务文件锁

### 11.1 防止重复触发

> 源码: `src/utils/cronTasksLock.ts`

多个进程（REPL + Daemon）可能同时运行调度器，锁机制防止同一任务被多次触发：

```
进程 A: tryAcquireLock(taskId) → 成功 → 执行任务
进程 B: tryAcquireLock(taskId) → 失败 → 跳过
```

### 11.2 锁标识策略

| 调用者 | lockIdentity | 原因 |
|--------|-------------|------|
| REPL | 会话 ID | 每次启动不同 |
| Daemon | 稳定 UUID | 跨重启保持一致 |

---

## 12. 设计分析

### 12.1 为什么要三层架构？

```
复杂度递增:
  Interactive (简单，短期)
       ↓
  BG Session (中等，持久)
       ↓
  Daemon (复杂，自治)
```

1. **Interactive**: 适合快速交互，无需管理开销
2. **BG Session**: 适合长时间任务，无需 Daemon 的复杂性
3. **Daemon**: 适合自动化工作流，需要定时触发和远程控制

### 12.2 PID 文件 vs 数据库

选择 PID 文件而非 SQLite 的原因：
- **原子性**: 写文件天然原子，无需事务
- **进程感知**: 可通过检查 PID 存活判断会话状态
- **无依赖**: 不需要额外的数据库驱动
- **清理简单**: 进程退出时删除文件即可

### 12.3 Daemon Worker 的精简启动

Worker 跳过 `enableConfigs()` 和 `initSinks()` 的设计决策：

- **性能**: 定时任务可能频繁触发，每次都完整初始化开销过大
- **隔离**: Worker 的配置由 Daemon 管理，无需重复加载
- **安全**: 减少 Worker 的初始化表面积
