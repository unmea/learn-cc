# Q: Agent 之间如何通信？

> **消息轮询**: `src/hooks/useInboxPoller.ts`（969 行）

---

## 通信架构概览

Claude Code 的 Agent 间通信基于**文件系统邮箱 + 轮询**模式：

```
┌─────────────┐                    ┌─────────────┐
│  Team Lead  │ ── SendMessage ──→ │  Researcher  │
│  (Agent A)  │ ←── Mailbox Poll ──│  (Agent B)  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  ~/.claude/teams/{team}/inboxes/ │
       │  ├── team-lead.json              │
       │  └── researcher.json             │
       └──────────────────────────────────┘
```

每个 Agent 有自己的 JSON 邮箱文件，其他 Agent 向其写入消息，Agent 自己轮询读取。

---

## SendMessage 的 4 种路由方式

> **源码**: `src/tools/SendMessageTool/SendMessageTool.ts`

### 地址解析

> **源码**: `src/utils/peerAddress.ts:8-21`

```typescript
function parseAddress(to: string) {
  if (to.startsWith('uds:'))    return { scheme: 'uds', target: to.slice(4) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice(7) }
  if (to.startsWith('/'))       return { scheme: 'uds', target: to }  // 兼容旧格式
  return { scheme: 'other', target: to }  // 队友名称
}
```

### 路由 1：按队友名称（最常用）

```
to: "researcher"
```

> **源码**: `SendMessageTool.ts:802-874`

路由逻辑：

```typescript
// 1. 查找 Agent 注册表
const agentId = appState.agentNameRegistry.get(input.to)

// 2. 找到对应的任务
const task = appState.tasks[agentId]

// 3. 根据任务状态选择路由
if (task.status === 'running') {
  queuePendingMessage(taskId, message)    // 排入中途消息队列
} else if (task.status === 'completed' || task.status === 'killed') {
  resumeAgentBackground(taskId, message)  // 从磁盘恢复 Agent
}

// 4. 如果不在注册表中，回退到邮箱
writeToMailbox(recipientName, message, teamName)
```

### 路由 2：广播（"*"）

```
to: "*"
```

> **源码**: `SendMessageTool.ts:191-265`

```typescript
function handleBroadcast() {
  // 1. 读取团队配置文件
  const teamFile = readTeamFile(teamName)
  
  // 2. 遍历所有非发送者成员
  for (const member of teamFile.members) {
    if (member.agentId !== senderAgentId) {
      writeToMailbox(member.name, message, teamName)
    }
  }
  
  // 3. 返回接收者列表
  return recipientList
}
```

### 路由 3：Unix Domain Socket（同机器跨会话）

```
to: "uds:/path/to/socket.sock"
```

> **源码**: `SendMessageTool.ts:775-797`

```typescript
if (addr.scheme === 'uds') {
  const { sendToUdsSocket } = require('../../utils/udsClient.js')
  await sendToUdsSocket(addr.target, input.message)
}
```

- 需要特性标志 `feature('UDS_INBOX')` 开启
- 用 `ListPeers` 工具发现本地其他 Claude 会话
- 只支持纯文本消息（不支持结构化协议消息）
- 不需要 summary 字段

### 路由 4：Bridge（跨机器远程通信）

```
to: "bridge:session_01AbCd..."
```

> **源码**: `SendMessageTool.ts:744-773`

```typescript
if (addr.scheme === 'bridge') {
  const { postInterClaudeMessage } = require('../../bridge/peerSessions.js')
  const result = await postInterClaudeMessage(addr.target, input.message)
}
```

**安全限制：**

```typescript
// SendMessageTool.ts:585-602
async checkPermissions(input) {
  if (parseAddress(input.to).scheme === 'bridge') {
    return {
      behavior: 'ask',
      message: 'Send message to Remote Control session?',
      decisionReason: {
        type: 'safetyCheck',
        reason: 'Cross-machine bridge message requires explicit user consent',
        classifierApprovable: false  // ← 不可自动批准，必须用户确认
      }
    }
  }
}
```

Bridge 消息的限制：
- 只支持纯文本（结构化消息被禁止）
- **必须**用户手动批准（`classifierApprovable: false`）
- 通过 Anthropic 中继服务器转发
- 到达时被包装为 `<cross-session-message from="...">`
- 需要先通过 `/remote-control` 建立连接

### 路由决策树

```
SendMessage(to)
├── to === "*"
│   └── 广播：写入所有非发送者成员的邮箱
├── parseAddress(to)
│   ├── scheme === 'uds'
│   │   └── sendToUdsSocket(path, message)
│   ├── scheme === 'bridge'
│   │   └── postInterClaudeMessage(sessionId, message) [需用户批准]
│   └── scheme === 'other'  (队友名称)
│       ├── agentNameRegistry 中找到？
│       │   ├── 任务 running → queuePendingMessage()
│       │   └── 任务 stopped → resumeAgentBackground()
│       └── 未找到？
│           └── writeToMailbox(name, message, teamName)
```

---

## 邮箱系统：文件级通信

### 目录结构

```
~/.claude/teams/{team-name}/
  ├── config.json                    # 团队配置
  └── inboxes/
      ├── team-lead.json             # Leader 的收件箱
      ├── researcher.json            # 研究员的收件箱
      └── researcher.json.lock       # 文件锁
```

### 消息格式

> **源码**: `src/utils/teammateMailbox.ts:43-50`

```typescript
interface TeammateMessage {
  from: string       // 发送者名称
  text: string       // 消息内容（或 JSON 编码的协议消息）
  timestamp: string  // ISO 8601 时间戳
  read: boolean      // false=未读, true=已读
  color?: string     // 发送者的分配颜色
  summary?: string   // 5-10 字预览（用于 UI）
}
```

### 写操作：带文件锁的安全写入

> **源码**: `src/utils/teammateMailbox.ts:134-192`

```typescript
async function writeToMailbox(recipientName, message, teamName) {
  // 1. 确保收件箱目录存在
  ensureInboxDir(teamName)
  
  // 2. 创建收件箱文件（如果不存在）
  //    flag: 'wx' — 排他写入，防止竞争
  
  // 3. 获取文件锁（带重试）
  await lockfile.lock(inboxPath, lockFilePath)
  //    重试策略：10 次，5-100ms 退避
  
  // 4. 获得锁后，重新读取最新状态
  const messages = await readMailbox(recipientName, teamName)
  
  // 5. 追加新消息
  messages.push({ from, text, timestamp, read: false, color, summary })
  
  // 6. 原子写入
  await writeFile(inboxPath, jsonStringify(messages))
  
  // 7. 释放锁
  await lockfile.unlock(inboxPath, lockFilePath)
}
```

为什么需要文件锁？**多个 Claude 实例可能同时向同一个邮箱写入**（团队模式下常见）。
使用 `proper-lockfile` 库，10 次重试 + 5-100ms 随机退避，确保并发安全。

### 读操作

```typescript
// 读取所有消息
readMailbox(agentName, teamName): Promise<TeammateMessage[]>
// 读取未读消息
readUnreadMessages(agentName, teamName): Promise<TeammateMessage[]>

// 标记已读的 3 种方式
markMessagesAsRead(agentName, teamName)              // 全部标记
markMessageAsReadByIndex(agentName, teamName, index) // 按索引
markMessagesAsReadByPredicate(agentName, pred, team) // 按条件
```

---

## 消息轮询：useInboxPoller

> **源码**: `src/hooks/useInboxPoller.ts`

### 轮询配置

```typescript
const INBOX_POLL_INTERVAL_MS = 1000  // 每秒轮询一次
```

### 轮询流程

```
每 1 秒
  │
  ├── 确定轮询目标
  │   ├── In-process teammate → 不轮询（用 waitForNextPromptOrShutdown）
  │   ├── Process-based teammate → 轮询自己的收件箱
  │   └── Team Lead → 轮询 Leader 的收件箱
  │
  ├── readUnreadMessages(agentName, teamName)
  │
  ├── 如果没有未读消息 → 退出
  │
  └── 消息分类 → 路由到对应 handler
```

### 消息分类（10 种类别）

> **源码**: `useInboxPoller.ts:204-248`

```typescript
// 结构化协议消息
permissionRequests[]           → isPermissionRequest()
permissionResponses[]          → isPermissionResponse()
sandboxPermissionRequests[]    → isSandboxPermissionRequest()
sandboxPermissionResponses[]   → isSandboxPermissionResponse()
shutdownRequests[]             → isShutdownRequest()
shutdownApprovals[]            → isShutdownApproved()
teamPermissionUpdates[]        → isTeamPermissionUpdate()
modeSetRequests[]              → isModeSetRequest()
planApprovalRequests[]         → isPlanApprovalRequest()

// 普通文本消息
regularMessages[]              → 以上都不匹配的
```

### 协议消息 vs 普通消息

```
┌─────────────────────────────────────────────┐
│           协议消息                            │
│  检测: isStructuredProtocolMessage()         │
│  处理: 路由到专用 handler                     │
│  不会被 LLM 看到                             │
│                                              │
│  例: shutdown_request, permission_request    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│           普通消息                            │
│  格式化: <teammate-message> XML              │
│  处理: 注入 LLM 上下文                       │
│  用户可见                                     │
│                                              │
│  例: "I found the bug in validate.ts:42"     │
└─────────────────────────────────────────────┘
```

### 普通消息的投递语义

```
场景：Agent 空闲（不在推理中）
  └── 立即投递到 LLM 上下文，触发新轮次

场景：Agent 忙碌（推理中）
  └── 排入 AppState.inbox.messages 队列
      └── 轮次结束后投递

场景：来自其他队友的消息
  └── 摘要显示在空闲通知中：
      "[to researcher] Task complete"
```

### 消息格式化

```typescript
formatTeammateMessages(messages: TeammateMessage[]): string

// 输出 XML：
// <teammate-message teammate_id="researcher" color="blue" summary="Task complete">
//   I found the bug in validate.ts:42. The session object...
// </teammate-message>
```

---

## 结构化协议消息

### 关闭协议

```typescript
// 请求关闭
ShutdownRequestMessage {
  type: 'shutdown_request'
  requestId: string
  from: string
  reason?: string
  timestamp: string
}

// 批准关闭
ShutdownApprovedMessage {
  type: 'shutdown_approved'
  requestId: string
  from: string
  timestamp: string
  paneId?: string
  backendType?: string
}

// 拒绝关闭
ShutdownRejectedMessage {
  type: 'shutdown_rejected'
  requestId: string
  from: string
  reason: string
  timestamp: string
}
```

关闭流程：
```
Teammate 想退出 → 发送 shutdown_request → Leader 收到
  │
  ├── Leader 批准 → shutdown_approved → Teammate 退出
  └── Leader 拒绝 → shutdown_rejected + 原因 → Teammate 继续工作
```

### 权限请求协议

```typescript
// 队友请求权限
PermissionRequestMessage {
  type: 'permission_request'
  request_id: string
  agent_id: string
  tool_name: string
  tool_use_id: string
  description: string
  input: unknown
  permission_suggestions: Array<{...}>
}

// Leader 回复权限
PermissionResponseMessage {
  type: 'permission_response'
  request_id: string
  subtype: 'success' | 'error'
  response?: {
    updated_input?: unknown
    permission_updates?: Array<{...}>
  }
  error?: string
}
```

权限请求的 Leader 端处理：

> **源码**: `useInboxPoller.ts:250-352`

```typescript
if (permissionRequests.length > 0 && isTeamLead()) {
  const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
  
  for (const request of permissionRequests) {
    // 构建确认条目
    const entry = {
      onAbort: () => sendPermissionResponse('rejected'),
      onAllow: (updatedInput, updates) => sendPermissionResponse('approved'),
      onReject: (feedback) => sendPermissionResponse('rejected'),
    }
    
    // 按 toolUseID 去重
    // 加入 ToolUseConfirmQueue（与同进程 Worker 共用同一套 UI）
    setToolUseConfirmQueue(prev => [...prev, entry])
  }
}
```

### 其他协议消息

| 类型 | 用途 |
|------|------|
| `idle_notification` | 队友完成当前轮次时通知 |
| `plan_approval_request/response` | Plan 模式审批流程 |
| `mode_set_request` | 广播权限模式变更 |
| `team_permission_update` | 共享路径权限同步 |
| `sandbox_permission_request/response` | 网络访问审批 |

---

## 团队生命周期

### TeamCreateTool：创建团队

> **源码**: `src/tools/TeamCreateTool/TeamCreateTool.ts:128-237`

```
1. 生成唯一团队名称: generateUniqueTeamName()
2. 创建 AgentId: formatAgentId("team-lead", teamName)
3. 构建 TeamFile:
   {
     name, description, createdAt,
     leadAgentId, leadSessionId,
     members: [{ name: "team-lead", ... }]
   }
4. 持久化: writeTeamFileAsync(teamName, teamFile)
5. 注册清理钩子: registerTeamForSessionCleanup(teamName)
6. 创建任务列表: resetTaskList(sanitizeName(teamName))
7. 更新 AppState:
   - 设置 teamContext
   - 初始化 teammates map
   - 分配颜色: assignTeammateColor(leadAgentId)
```

### TeamFile 结构

```
路径: ~/.claude/teams/{team-name}/config.json
```

```typescript
interface TeamFile {
  name: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string           // 用于会话发现
  hiddenPaneIds?: string[]         // UI 可见性控制
  teamAllowedPaths?: Array<{      // 共享权限路径
    path: string
    toolName: string
    addedBy: string
    addedAt: number
  }>
  members: Array<{
    agentId: string                // "researcher@my-team"
    name: string                   // "researcher"
    agentType?: string
    model?: string
    color?: string                 // 分配的颜色
    backendType?: 'tmux' | 'iterm' | 'in-process'
    isActive?: boolean             // false 表示空闲
    mode?: PermissionMode
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    subscriptions: string[]
  }>
}
```

### 颜色分配

> **源码**: `src/utils/swarm/teammateLayoutManager.ts`

```typescript
// 从 AGENT_COLORS 调色板中轮转分配
// 存储在内存 Map<string, AgentColorName>
// 也持久化到 teamFile.members[].color
// clearTeammateColors() 在团队清理时重置
```

### TeamDeleteTool：删除团队

> **源码**: `src/tools/TeamDeleteTool/TeamDeleteTool.ts:71-134`

```
1. 检查是否有活跃成员（非 Leader）
   └── 如果有 → 拒绝删除，提示先停止成员

2. 执行清理:
   ├── cleanupTeamDirectories(teamName)          — 删除团队目录
   ├── unregisterTeamForSessionCleanup(teamName) — 取消清理钩子
   ├── clearTeammateColors()                     — 重置颜色分配
   └── clearLeaderTeamName()                     — 回退到 session ID

3. 清除 AppState:
   ├── teamContext: undefined
   └── inbox: { messages: [] }
```

### 完整生命周期

```
创建: TeamCreateTool
  └── 写入 TeamFile → 注册清理钩子 → 初始化 AppState

加入: AgentTool 创建队友
  └── 更新 teamFile.members[] → 分配颜色

运行: Agent 间通信
  └── SendMessage ↔ 邮箱 ↔ useInboxPoller

关闭: 协商式退出
  └── shutdown_request → shutdown_approved → 成员退出

删除: TeamDeleteTool
  └── 验证无活跃成员 → 清理目录 → 清除 AppState

异常退出: 会话结束清理
  └── 注册的清理钩子自动执行 → 删除团队目录
```

---

## In-Process vs Process-Based 通信对比

### In-Process 队友（同进程）

```
通信方式: queuePendingMessage() → 直接注入消息队列
轮询机制: 不需要（用 waitForNextPromptOrShutdown）
权限 UI: 共享 ToolUseConfirmQueue
延迟: 近乎零（内存操作）
隔离级别: AsyncLocalStorage
```

### Process-Based 队友（独立进程）

```
通信方式: writeToMailbox() → 文件系统写入
轮询机制: useInboxPoller 每秒轮询
权限 UI: 通过邮箱的 permission_request/response 协议
延迟: 最多 1 秒（轮询间隔）
隔离级别: 操作系统进程
```

```
┌────────────────────────────────────────────────┐
│              同一 Node.js 进程                   │
│                                                 │
│  ┌──────────┐   内存队列    ┌──────────┐       │
│  │  Leader   │ ◄──────────► │ Teammate │       │
│  │          │   (~0ms)      │ (in-proc)│       │
│  └──────────┘               └──────────┘       │
│       │                                         │
│       │  文件邮箱 (~1s)                          │
│       │                                         │
└───────┼─────────────────────────────────────────┘
        │
        ▼
┌──────────────┐
│  Teammate    │  (独立进程/tmux)
│ (proc-based) │
└──────────────┘
```

---

## 设计分析：为什么选择文件邮箱？

### 方案对比

| 方案 | 优势 | 劣势 |
|------|------|------|
| **文件邮箱（当前）** | 无服务器依赖、跨进程、可持久化、简单可靠 | 轮询延迟（~1s）、文件锁开销 |
| 共享内存 | 零拷贝、低延迟 | 跨进程困难、需要序列化、崩溃不安全 |
| Event Bus | 推送模式、低延迟 | 需要运行中的服务、复杂度高 |
| Unix Socket | 低延迟、无磁盘 IO | 需要发现机制、不可持久化 |
| Redis/消息队列 | 高吞吐、可靠投递 | 外部依赖、部署复杂度 |

### 为什么文件邮箱是正确选择？

1. **零依赖**：不需要运行额外的服务，CLI 工具的核心优势
2. **天然持久化**：进程崩溃后消息不会丢失
3. **跨进程支持**：tmux 面板中的独立 Claude 实例可以通过同一个文件系统通信
4. **简单调试**：`cat ~/.claude/teams/my-team/inboxes/researcher.json` 就能看到所有消息
5. **1 秒延迟足够**：Agent 间通信不需要毫秒级实时性

### 文件锁的正确性保证

- 使用 `proper-lockfile` 库，而非 `flock()` 或 `O_EXCL`
- 10 次重试 + 5-100ms 随机退避
- 获取锁后**重新读取**文件（避免读-改-写竞争）
- 原子写入整个文件（不是追加）

---

## UDS_INBOX：同机器跨会话通信

> **特性标志**: `feature('UDS_INBOX')`

UDS（Unix Domain Socket）提供比文件邮箱更低延迟的本地通信：

```
                    同一台机器
┌──────────────┐                    ┌──────────────┐
│ Claude 会话 1 │ ─── UDS Socket ──→│ Claude 会话 2 │
│              │ ←── UDS Socket ───│              │
└──────────────┘                    └──────────────┘
     │                                    │
     └──── ListPeers 发现 ───────────────┘
```

工作流程：
1. 用 `ListPeers` 工具发现本地其他 Claude 会话的 socket 路径
2. 用 `SendMessage(to: "uds:/path/to/socket.sock", message: "...")` 发送
3. 只支持纯文本，不支持结构化协议消息

---

## 快速参考

### 文件路径

```
团队配置:       ~/.claude/teams/{team-name}/config.json
成员收件箱:     ~/.claude/teams/{team-name}/inboxes/{agent-name}.json
文件锁:         ~/.claude/teams/{team-name}/inboxes/{agent-name}.json.lock
任务列表:       ~/.claude/tasks/{team-name}/
```

### SendMessage 路由

| `to` 值 | 路由方式 | 安全级别 |
|---------|---------|---------|
| `"researcher"` | 队友名称 → 内存/邮箱 | 无需审批 |
| `"*"` | 广播 → 所有成员邮箱 | 无需审批 |
| `"uds:/path.sock"` | Unix Socket | 无需审批 |
| `"bridge:session_id"` | Anthropic 中继 | **必须用户审批** |
