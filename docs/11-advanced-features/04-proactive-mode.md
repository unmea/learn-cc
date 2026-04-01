# Q: Agent 能否主动行动而非等待指令？

## 一句话回答

Proactive/Kairos 模式让 Agent 从被动等待指令转变为主动自治行动：通过周期性 `<tick>` 提示保持活跃，SleepTool 控制节奏，DreamTask 在后台自动整理记忆。

---

## 1. 主动模式架构

### 1.1 核心组件

```
┌──────────────────────────────────────────────┐
│            Proactive Mode 架构                │
│                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │  Tick    │   │  Sleep   │   │  Dream   │ │
│  │  生成器  │   │  Tool    │   │  Task    │ │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘ │
│       │              │              │        │
│       │  ┌───────────┴──────┐       │        │
│       └──▶ 自治循环          │       │        │
│          │ tick → 行动/休眠  │       │        │
│          │ tick → 行动/休眠  │       │        │
│          └───────────┬──────┘       │        │
│                      │              │        │
│                      ▼              ▼        │
│              用户可随时中断    自动记忆整理     │
└──────────────────────────────────────────────┘
```

### 1.2 特性标志

主动模式受两个特性标志控制：

| 标志 | 用途 |
|------|------|
| `PROACTIVE` | 基础主动模式 |
| `KAIROS` | 增强版（助手守护模式） |

两个标志在代码中通常一起检查: `feature('PROACTIVE') || feature('KAIROS')`

---

## 2. 激活机制

### 2.1 三种激活方式

> 源码: `src/main.tsx:4611-4620`

```typescript
function maybeActivateProactive(options: unknown): void {
  if ((feature('PROACTIVE') || feature('KAIROS')) && (
    (options as { proactive?: boolean }).proactive ||
    isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)
  )) {
    const proactiveModule = require('./proactive/index.js')
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command')
    }
  }
}
```

| 方式 | 命令 | 说明 |
|------|------|------|
| **CLI 标志** | `claude --proactive` | 启动时启用 |
| **环境变量** | `CLAUDE_CODE_PROACTIVE=1` | 通过环境配置 |
| **程序化** | `setKairosActive(true)` | 代码内部切换 |

### 2.2 状态管理

> 源码: `src/bootstrap/state.ts`

```typescript
type State = {
  // ...
  kairosActive: boolean
  // ...
}

export function getKairosActive(): boolean {
  return STATE.kairosActive
}

export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}
```

---

## 3. 系统提示注入

### 3.1 启动时的 Prompt 追加

> 源码: `src/main.tsx:2197-2204`

```typescript
if ((feature('PROACTIVE') || feature('KAIROS')) && (
  options.proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)
) && !coordinatorModeModule?.isCoordinatorMode()) {
  const proactivePrompt = `
# Proactive Mode

You are in proactive mode. Take initiative — explore, act,
and make progress without waiting for instructions.

Start by briefly greeting the user.

You will receive periodic <tick> prompts. These are check-ins.
Do whatever seems most useful, or call Sleep if there's nothing to do.
${briefVisibility}`

  appendSystemPrompt = appendSystemPrompt
    ? `${appendSystemPrompt}\n\n${proactivePrompt}`
    : proactivePrompt
}
```

### 3.2 自治工作指令

> 源码: `src/constants/prompts.ts:860-914`

主动模式注入了详细的行为指南：

```
# 核心行为规则

## 节奏控制
- 使用 Sleep 工具控制等待时间
- 等待慢进程时多睡，主动迭代时少睡
- 每次唤醒消耗一次 API 调用
- Prompt 缓存 5 分钟后过期 — 平衡成本

## 首次唤醒
- 简短问候用户
- 询问想做什么
- 不要未经指示就开始探索或修改

## 后续唤醒
- 寻找有用的工作
- 不要重复提问
- 不要叙述即将做的事 — 直接做

## 保持响应
- 用户活跃互动时，频繁检查消息
- 像结对编程一样保持反馈循环紧凑
- 感知到用户在等待时，优先响应

## 偏向行动
- 按最佳判断行动，而非请求确认
- 读文件、搜索代码、运行测试 — 无需询问
- 在两种合理方案间犹豫时，选一个执行
- 可以随时修正方向

## 保持简洁
- 文本输出简短、高层级
- 用户可以看到你的工具调用
- 聚焦于: 需要输入的决策、里程碑状态、阻塞项
- 能一句话说完的不用三句

## 终端焦点感知
- terminalFocus = unfocused: 用户不在，大胆自主行动
- terminalFocus = focused: 用户在看，更协作式地工作
```

### 3.3 系统提示的拼接策略

> 源码: `src/utils/systemPrompt.ts:99-113`

关键设计决策 — 主动模式下 Agent 指令是**追加**而非**替换**：

```typescript
if (agentSystemPrompt && (feature('PROACTIVE') || feature('KAIROS'))
    && isProactiveActive_SAFE_TO_CALL_ANYWHERE()) {
  return asSystemPrompt([
    ...defaultSystemPrompt,
    `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
```

| 模式 | 系统提示行为 |
|------|-------------|
| **被动模式** | Agent 提示**替换**默认系统提示 |
| **主动模式** | Agent 提示**追加**到默认系统提示后 |

这样保证主动模式的自治指令始终存在。

---

## 4. Tick 生成机制

### 4.1 自治循环的心跳

> 源码: `src/cli/print.ts:1831-1856`

```typescript
const scheduleProactiveTick =
  feature('PROACTIVE') || feature('KAIROS')
    ? () => {
        setTimeout(() => {
          // 检查是否仍活跃
          if (!proactiveModule?.isProactiveActive() ||
              proactiveModule.isProactivePaused() ||
              inputClosed) {
            return
          }

          // 生成 tick 消息
          const tickContent =
            `<tick>${new Date().toLocaleTimeString()}</tick>`

          // 入队为低优先级元消息
          enqueue({
            mode: 'prompt' as const,
            value: tickContent,
            uuid: randomUUID(),
            priority: 'later',
            isMeta: true,
          })

          void run()
        }, 0)
      }
    : undefined
```

### 4.2 Tick 的关键特性

| 特性 | 值 | 目的 |
|------|-----|------|
| `setTimeout(0)` | 让出事件循环 | 让挂起的 stdin（用户中断）先处理 |
| `priority: 'later'` | 低优先级 | 不打断当前操作 |
| `isMeta: true` | 元消息 | 在转录 UI 中隐藏 |
| 时间戳 | 本地时间 | Agent 用来判断时间上下文 |

### 4.3 Tick 消息示例

```xml
<tick>2:34:15 PM</tick>
```

Agent 收到 tick 后的决策流程：

```
收到 <tick>
    │
    ├── 有待处理的工作? → 执行工作
    │
    ├── 用户有新消息? → 响应用户
    │
    ├── 在等待某个过程? → 检查状态
    │
    └── 无事可做? → 调用 SleepTool
```

---

## 5. SleepTool — 智能等待

### 5.1 工具定义

> 源码: `src/tools/SleepTool/prompt.ts:1-17`

```typescript
export const SLEEP_TOOL_NAME = 'Sleep'
export const DESCRIPTION = 'Wait for a specified duration'

export const SLEEP_TOOL_PROMPT = `Wait for a specified duration.
The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have
nothing to do, or when you're waiting for something.

You may receive <tick> prompts — these are periodic check-ins.
Look for useful work to do before sleeping.

You can call this concurrently with other tools — it won't
interfere with them.

Prefer this over \`Bash(sleep ...)\` — it doesn't hold a
shell process.

Each wake-up costs an API call, but the prompt cache expires
after 5 minutes of inactivity — balance accordingly.`
```

### 5.2 条件可用性

> 源码: `src/tools.ts:25-28`

```typescript
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
```

SleepTool **仅在主动模式启用时可用**。这是一个运行时条件加载。

### 5.3 唤醒触发器

> 源码: `src/types/textInputTypes.ts:277-294`

SleepTool 通过消息队列系统被唤醒：

```typescript
/**
 * 队列优先级:
 *
 * - `now`   — 立即中断并发送。中止正在进行的工具调用。
 * - `next`  — 等当前工具调用完成，然后发送。唤醒 SleepTool。
 * - `later` — 等当前轮次结束。唤醒 SleepTool（query.ts
 *             在 sleep 后提升排水阈值，使消息附加到同一轮次）。
 */
export type QueuePriority = 'now' | 'next' | 'later'
```

唤醒流程:

```
用户输入消息
       │
       ▼
检查 hasInterruptibleToolInProgress
(SleepTool 的 interruptBehavior: 'cancel')
       │
       ├── 是 → 以 'now' 优先级入队 → 立即唤醒 Sleep
       └── 否 → 正常入队
```

### 5.4 SleepTool vs Bash sleep

| 维度 | SleepTool | `Bash(sleep 30)` |
|------|-----------|-------------------|
| **Shell 占用** | ❌ 不占用 | ✅ 占用一个 Shell 进程 |
| **可中断** | ✅ 用户消息即时唤醒 | ❌ 需等待 Shell 超时 |
| **并行性** | ✅ 可与其他工具并发 | ❌ 阻塞 Shell |
| **API 开销** | 每次唤醒一次 API 调用 | 无额外开销 |

---

## 6. DreamTask — 自动记忆整理

### 6.1 概述

DreamTask 是一个在后台自动运行的记忆整理机制。当积累了足够多的会话后，自动分析历史对话并整理为持久记忆。

### 6.2 任务状态

> 源码: `src/tasks/DreamTask/DreamTask.ts:1-157`

```typescript
export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase                // 'starting' | 'updating'
  sessionsReviewing: number        // 正在回顾的会话数
  filesTouched: string[]           // 被修改的文件（不完整）
  turns: DreamTurn[]               // Agent 的回复轮次
  abortController?: AbortController
  priorMtime: number               // 保存的锁 mtime（用于回滚）
}
```

### 6.3 核心函数

| 函数 | 行 | 用途 |
|------|-----|------|
| `registerDreamTask()` | 52-74 | 创建并注册 Dream 任务到 UI |
| `addDreamTurn()` | 76-104 | 添加轮次（工具使用折叠 + 文件路径） |
| `completeDreamTask()` | 106-120 | 标记完成 |
| `failDreamTask()` | 122-130 | 标记失败 |
| `kill()` | 136-156 | 终止并回滚整理锁 |

---

## 7. AutoDream — 自动触发逻辑

### 7.1 门控条件

> 源码: `src/services/autoDream/autoDream.ts:95-100`

```typescript
function isGateOpen(): boolean {
  if (getKairosActive()) return false  // KAIROS 模式使用磁盘技能 dream
  if (getIsRemoteMode()) return false  // 远程模式不触发
  if (!isAutoMemoryEnabled()) return false  // 自动记忆未启用
  return isAutoDreamEnabled()
}
```

门控检查顺序（从廉价到昂贵）：

```
① 时间门: lastConsolidatedAt 以来是否超过 minHours?  (一次 stat)
② 会话门: 新会话数是否 >= minSessions?              (目录扫描)
③ 锁门: 是否有其他进程正在整理?                      (文件锁)
```

### 7.2 默认配置

> 源码: `src/services/autoDream/autoDream.ts:58-93`

```typescript
const DEFAULTS: AutoDreamConfig = {
  minHours: 24,       // 至少间隔 24 小时
  minSessions: 5,     // 至少 5 个新会话
}
```

通过 GrowthBook 标志 `tengu_onyx_plover` 动态配置，包含防御性类型校验。

### 7.3 执行流程

> 源码: `src/services/autoDream/autoDream.ts:125-272`

```
检查门控
    │
    ├── 时间门: 计算距上次整理的小时数
    │   └── 未满 minHours → 跳过
    │
    ├── 扫描节流: 上次扫描是否太近?
    │   └── 太近 → 跳过（避免每轮都扫描）
    │
    ├── 会话门: 列出 lastConsolidatedAt 之后修改的会话
    │   ├── 排除当前会话
    │   └── 数量 < minSessions → 跳过
    │
    ├── 获取锁: tryAcquireConsolidationLock()
    │   └── 锁被占用 → 跳过
    │
    ▼
Fork Dream Agent
    │
    ├── promptMessages: [dream prompt]
    ├── querySource: 'auto_dream'
    ├── forkLabel: 'auto_dream'
    ├── skipTranscript: true
    ├── onMessage: makeDreamProgressWatcher()
    │
    ▼
Agent 分析历史会话 → 更新记忆文件
    │
    ▼
completeDreamTask() → 标记完成
```

---

## 8. 整理锁机制

### 8.1 锁文件设计

> 源码: `src/services/autoDream/consolidationLock.ts:1-130`

锁文件位于记忆目录内（`getAutoMemPath()`），其 **mtime 就是 lastConsolidatedAt**：

```typescript
const LOCK_FILE = '.consolidate-lock'
const HOLDER_STALE_MS = 60 * 60 * 1000  // 1 小时

export async function readLastConsolidatedAt(): Promise<number> {
  // 锁文件的 mtime = lastConsolidatedAt
  // 不存在则返回 0
  try {
    const s = await stat(lockPath())
    return s.mtimeMs
  } catch {
    return 0
  }
}
```

### 8.2 竞争安全

```typescript
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  // ① 读取现有锁信息
  let mtimeMs, holderPid
  try {
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    mtimeMs = s.mtimeMs
    holderPid = parseInt(raw.trim(), 10)
  } catch { /* ENOENT — 无锁 */ }

  // ② 检查锁是否被活跃进程持有
  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      return null  // 活跃进程持有锁
    }
    // 死 PID → 回收锁
  }

  // ③ 写入我们的 PID
  await writeFile(path, String(process.pid))

  // ④ 验证竞争: 两个进程同时写 → 最后一个赢
  const verify = await readFile(path, 'utf8')
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0
}
```

### 8.3 回滚机制

```typescript
export async function rollbackConsolidationLock(priorMtime: number): Promise<void> {
  // Fork 失败时回滚 mtime，使下次触发不被延迟
  if (priorMtime === 0) {
    await unlink(path)        // 恢复到无锁状态
    return
  }
  await writeFile(path, '')   // 清空 PID（避免误判为持有锁）
  const t = priorMtime / 1000
  await utimes(path, t, t)    // 恢复原始 mtime
}
```

---

## 9. 主动 vs 被动架构对比

### 9.1 行为差异

| 维度 | 被动模式 (Reactive) | 主动模式 (Proactive) |
|------|---------------------|---------------------|
| **触发** | 用户输入触发 | 周期性 tick + 用户输入 |
| **空闲时** | 等待输入 | 调用 SleepTool 休眠 |
| **决策** | 按用户指令执行 | 自主判断并行动 |
| **API 消耗** | 按需调用 | 持续消耗（tick 唤醒） |
| **上下文** | 用户提供 | Agent 自行探索和收集 |
| **适用场景** | 交互式对话 | 长时间自治任务 |

### 9.2 中断机制

用户可通过三种方式中断主动模式：直接输入消息（SleepTool 被 cancel）、Esc 键（中止当前工具调用）、暂停模式（`isProactivePaused()` = true，tick 停止生成）。

---

## 10. 设计分析

### 10.1 为什么选择 Tick 机制而非事件驱动？

**Tick 优势**: 简单可靠、统一入口（与用户消息走同一队列）、成本可控（频率可调）、模型友好（tick 就是普通消息）。事件驱动的问题在于需管理大量事件源，且事件风暴可能导致 API 消耗失控。

### 10.2 terminalFocus 的意义

根据用户是否在看终端来调整行为 — unfocused 时大胆自主行动，focused 时更协作式工作。这模拟了结对编程中的社交动态。

### 10.3 DreamTask 的锁文件设计

用锁文件的 **mtime 作为 lastConsolidatedAt** — 一个文件同时承担锁和时间戳功能，`stat()` 是最廉价的文件系统操作，PID 检查 + stale 超时保证健壮的死锁恢复。
