# Q: 如何让 Agent 在远程服务器上工作？

## 一句话回答

Bridge 是一个长驻守护进程，通过轮询 Environments API 接收工作指令，然后在本地生成子进程运行 CLI 会话，实现 claude.ai 网页端对本地机器的远程控制。

---

## 1. Bridge 整体架构

### 1.1 核心理念

Bridge 解决的问题是：用户在 claude.ai 网页上发起请求，但代码执行需要在用户的本地机器（或开发服务器）上进行。Bridge 充当两者之间的"桥梁"。

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│  claude.ai  │ ←HTTP→  │ Environments API │ ←Poll→  │  Bridge 守护  │
│  (网页前端)  │         │   (后端服务)      │         │  (本地进程)   │
└─────────────┘         └──────────────────┘         └──────┬───────┘
                                                           │ spawn
                                                    ┌──────▼───────┐
                                                    │  CLI 子进程   │
                                                    │ (会话执行器)  │
                                                    └──────────────┘
```

### 1.2 目录结构

`src/bridge/` 包含约 31 个 TypeScript 文件，按职责可分为：

| 类别 | 文件 | 职责 |
|------|------|------|
| **核心循环** | `bridgeMain.ts` (112.9 KB) | 独立桥接的主守护循环 |
| **REPL 桥接** | `remoteBridgeCore.ts` (38.5 KB) | 无环境变量模式的远程控制（REPL 内） |
| **会话管理** | `sessionRunner.ts` (551 行) | 子进程生成与生命周期 |
| **类型定义** | `types.ts` | BridgeConfig、WorkSecret 等 |
| **API 客户端** | `bridgeApi.ts` | Environments API 的 HTTP 调用 |
| **配置** | `bridgeConfig.ts`, `pollConfig.ts` | 认证与轮询配置 |
| **传输层** | `replBridgeTransport.ts` | v1 (HybridTransport) / v2 (SSE+CCR) |
| **令牌管理** | `jwtUtils.ts`, `trustedDevice.ts` | JWT 刷新、可信设备 |

---

## 2. 关键类型定义

### 2.1 BridgeConfig — 桥接配置

> 源码: `src/bridge/types.ts:81-115`

```typescript
export type BridgeConfig = {
  dir: string                    // 工作目录
  machineName: string            // 主机名
  branch: string                 // Git 分支
  gitRepoUrl: string | null      // Git 远程 URL
  maxSessions: number            // 最大并发会话数 (默认 1)
  spawnMode: SpawnMode           // 会话生成模式
  verbose: boolean               // 详细日志
  sandbox: boolean               // 沙箱模式
  bridgeId: string               // 客户端生成的 UUID
  workerType: string             // 'claude_code' | 'claude_code_assistant'
  environmentId: string          // 幂等的环境注册 ID
  reuseEnvironmentId?: string    // 后端返回的 env_id（用于重连）
  apiBaseUrl: string             // Environments API 地址
  sessionIngressUrl: string      // WebSocket 入口 URL
  debugFile?: string             // 调试日志路径
  sessionTimeoutMs?: number      // 会话超时（默认 24 小时）
}
```

### 2.2 SpawnMode — 会话生成策略

> 源码: `src/bridge/types.ts:68-69`

```typescript
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir'
```

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `single-session` | 一个会话在 cwd，结束后桥接关闭 | 单次任务 |
| `worktree` | 持久服务器，每个会话获得独立的 git worktree | 并发开发 |
| `same-dir` | 持久服务器，会话共享 cwd（可能冲突） | 快速迭代 |

### 2.3 WorkSecret — 工作密钥

> 源码: `src/bridge/types.ts:33-51`

后端通过 `pollForWork` 下发的加密工作包，Base64URL 编码的 JSON：

```typescript
export type WorkSecret = {
  version: number                    // 当前为 1
  session_ingress_token: string      // 会话认证 JWT
  api_base_url: string               // API 端点
  sources: Array<{                   // 代码源配置
    type: string
    git_info?: {
      type: string
      repo: string
      ref?: string
      token?: string                 // Git 认证令牌
    }
  }>
  auth: Array<{ type: string; token: string }>  // 认证凭据
  claude_code_args?: Record<string, string>     // CLI 参数
  mcp_config?: unknown | null                    // MCP 配置
  environment_variables?: Record<string, string> // 环境变量
  use_code_sessions?: boolean                    // CCR v2 选择器
}
```

**解码过程** (`workSecret.ts:6-32`)：
```typescript
export function decodeWorkSecret(secret: string): WorkSecret {
  const json = Buffer.from(secret, 'base64url').toString('utf-8')
  const parsed = jsonParse(json)
  // 校验 version === 1
  // 校验 session_ingress_token 和 api_base_url 存在
  return parsed as WorkSecret
}
```

### 2.4 BridgeWorkerType — 工作者类型

> 源码: `src/bridge/types.ts:79`

```typescript
export type BridgeWorkerType = 'claude_code' | 'claude_code_assistant'
```

在环境注册时作为 `metadata.worker_type` 发送，用于 claude.ai 前端按来源筛选会话。

---

## 3. 主循环架构 (bridgeMain.ts)

### 3.1 整体流程

`bridgeMain.ts` 实现了独立桥接的核心轮询循环（约 112.9 KB），其伪代码逻辑如下：

```
while (!loopSignal.aborted):
  ① getPollIntervalConfig()       // 从 GrowthBook 获取轮询参数
  ② api.pollForWork()             // 轮询后端获取工作
  ③ 如果无工作:
     - 若满载: 进入心跳循环或慢轮询
     - 否则: 快轮询 (默认 2s 间隔)
  ④ 如果有工作:
     - 解码 WorkSecret
     - 检查是否已有该会话 → 更新令牌
     - 若有容量 → 生成新会话
     - 确认 (ack) 工作
  ⑤ 等待会话完成
```

### 3.2 环境注册

启动时，Bridge 向后端注册自己：

```
POST /v1/environments/bridge
Body: {
  machine_name,          // 主机名
  directory,             // 工作目录
  branch,                // Git 分支
  git_repo_url,          // 仓库 URL
  max_sessions,          // 最大并发数
  metadata: {
    worker_type          // 'claude_code'
  },
  environment_id         // 幂等 ID（可选，用于重用）
}
返回: { environment_id, environment_secret }
```

### 3.3 轮询与工作获取

```
GET /v1/environments/{environmentId}/work/poll
Query: reclaim_older_than_ms (可选，重新获取未确认的工作)
返回: WorkResponse | null
```

- 每第 100 次空轮询记录一次日志
- 成功获取后重置计数器

### 3.4 满载时的心跳机制

当 `activeSessions.size >= maxSessions` 时，Bridge 有两种策略：

**策略一: 非独占心跳** (`non_exclusive_heartbeat_interval_ms > 0`)

```
心跳循环:
  ① 按配置间隔发送心跳
  ② 定期让出给轮询 (multisession_poll_interval_ms_at_capacity)
  ③ 检测容量变化和认证失败
  退出原因: poll_due | auth_failed | capacity_changed | shutdown
```

**策略二: 慢轮询** (心跳禁用时)

```
以 multisession_poll_interval_ms_at_capacity 间隔轮询 (默认 600s)
充当 Redis TTL 的存活信号 (BRIDGE_LAST_POLL_TTL = 4h)
```

**容量唤醒信号**: 会话完成 → 发出唤醒信号 → 立即退出心跳循环去轮询新工作。

---

## 4. 会话生成 (sessionRunner.ts)

### 4.1 子进程参数

> 源码: `src/bridge/sessionRunner.ts:287-304`

```typescript
const args = [
  ...deps.scriptArgs,              // 编译版为空，npm 版为 [script.js]
  '--print',                       // NDJSON 输出协议
  '--sdk-url', opts.sdkUrl,        // WebSocket 入口 URL
  '--session-id', opts.sessionId,  // 会话标识符
  '--input-format', 'stream-json', // 输入协议
  '--output-format', 'stream-json',// 输出协议
  '--replay-user-messages',        // 重放用户消息
  ...(deps.verbose ? ['--verbose'] : []),
  ...(debugFile ? ['--debug-file', debugFile] : []),
  ...(deps.permissionMode ? ['--permission-mode', deps.permissionMode] : []),
]
```

关键标志:
- `--sdk-url`: 将子进程连接到后端的 WebSocket 入口
- `--session-id`: 标识此次会话
- `--print`: 使用 NDJSON (换行分隔 JSON) 协议输出

### 4.2 环境变量注入

> 源码: `src/bridge/sessionRunner.ts:306-323`

```typescript
const env = {
  ...deps.env,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,              // 移除桥接令牌
  CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',          // 标记为桥接上下文
  ...(deps.sandbox && { CLAUDE_CODE_FORCE_SANDBOX: '1' }),
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken,    // 会话 JWT
  CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
  ...(opts.useCcrV2 && {
    CLAUDE_CODE_USE_CCR_V2: '1',                   // 启用 CCR v2 传输
    CLAUDE_CODE_WORKER_EPOCH: String(opts.workerEpoch),
  }),
}
```

安全考虑: 桥接自身的 OAuth 令牌被显式移除 (`undefined`)，子进程仅能使用为其分配的会话 JWT。

### 4.3 活动跟踪 — TOOL_VERBS 映射

> 源码: `src/bridge/sessionRunner.ts:70-89`

Bridge 从子进程的 stdout 解析 NDJSON，提取工具使用活动并映射为人类可读描述：

```typescript
const TOOL_VERBS: Record<string, string> = {
  Read: 'Reading',           FileReadTool: 'Reading',
  Write: 'Writing',          FileWriteTool: 'Writing',
  Edit: 'Editing',           FileEditTool: 'Editing',
  MultiEdit: 'Editing',
  Bash: 'Running',           BashTool: 'Running',
  Glob: 'Searching',         GlobTool: 'Searching',
  Grep: 'Searching',         GrepTool: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching',
  Task: 'Running task',
  NotebookEditTool: 'Editing notebook',
  LSP: 'LSP',
}
```

### 4.4 活动提取逻辑

> 源码: `src/bridge/sessionRunner.ts:107-200`

```typescript
function extractActivities(line: string): SessionActivity[] {
  // 解析 NDJSON 行
  // 提取:
  //   - tool_use 块 → type: 'tool_start'，摘要如 "Reading src/foo.ts"
  //   - text 块 → type: 'text'，取前 80 个字符
  //   - result success → type: 'result'
  //   - result error → type: 'error'
  // 环形缓冲区: 保留最近 MAX_ACTIVITIES (10) 条
}
```

摘要构建规则 (`sessionRunner.ts:91-105`)：

| 输入类型 | 摘要格式 | 示例 |
|----------|----------|------|
| 工具调用 | `"{动词} {file_path\|pattern\|command}"` | `"Reading src/foo.ts"` |
| 文本输出 | 前 80 个字符 | `"Let me analyze this..."` |
| 完成结果 | `"Session completed"` | — |
| 错误 | 错误消息 | `"Permission denied"` |

### 4.5 会话句柄

> 源码: `src/bridge/sessionRunner.ts:482-543`

```typescript
const handle: SessionHandle = {
  sessionId: string,
  done: Promise<SessionDoneStatus>,     // 子进程退出时 resolve
  activities: SessionActivity[],         // 环形缓冲区 (最多 10 条)
  currentActivity: SessionActivity | null,
  accessToken: string,                   // 会话 JWT
  lastStderr: string[],                  // 最近 10 行 stderr
  kill(),                                // 发送 SIGTERM
  forceKill(),                           // 发送 SIGKILL
  writeStdin(data: string),              // 向子进程发送 JSON
  updateAccessToken(token: string),      // 通过 stdin 刷新 JWT
}
```

**令牌刷新机制** — 通过 stdin 向子进程发送更新消息：
```json
{
  "type": "update_environment_variables",
  "variables": {
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN": "new_jwt_token"
  }
}
```

---

## 5. 重连策略

### 5.1 退避配置

> 源码: `src/bridge/bridgeMain.ts:59-79`

```typescript
export type BackoffConfig = {
  connInitialMs: number        // 2s — 连接错误退避起始
  connCapMs: number            // 120s — 连接退避上限
  connGiveUpMs: number         // 600s (10分钟) — 放弃阈值
  generalInitialMs: number     // 500ms — 一般错误退避起始
  generalCapMs: number         // 30s — 一般退避上限
  generalGiveUpMs: number      // 600s (10分钟) — 放弃阈值
  shutdownGraceMs?: number     // SIGTERM→SIGKILL 宽限期 (默认 30s)
  stopWorkBaseDelayMs?: number // stopWork 重试基础延迟 (默认 1s)
}
```

### 5.2 指数退避算法

```
连接错误:
  2s → 4s → 8s → 16s → 32s → 64s → 120s (上限)
  持续 10 分钟无法恢复 → 放弃

一般错误:
  500ms → 1s → 2s → 4s → 8s → 16s → 30s (上限)
  持续 10 分钟无法恢复 → 放弃

成功后: 退避重置为 0

休眠检测:
  如果延迟超过 2× 上限 (240s)，
  认为是笔记本电脑唤醒，重置退避
```

### 5.3 REPL 模式的 401 恢复

> 源码: `src/bridge/remoteBridgeCore.ts:450+`

当 SSE 传输收到 401 时：

```
① 设置 authRecoveryInFlight = true（锁定恢复路径）
② withRetry(() => fetchRemoteCredentials(...))
③ 指数退避重试（按配置的 initial_delay_ms / cap_ms / max_retries）
④ 重建传输: rebuildTransport(fresh, 'auth_401_recovery')
⑤ 重新连接回调并恢复
```

安全机制: `authRecoveryInFlight` 标志序列化主动刷新与 401 恢复，两者都调用 `/bridge`（递增 epoch），因此只能有一个成功。

---

## 6. API 接口清单 (bridgeApi.ts)

| 方法 | 端点 | 用途 |
|------|------|------|
| `registerBridgeEnvironment` | `POST /v1/environments/bridge` | 注册桥接环境 |
| `pollForWork` | `GET /v1/environments/{id}/work/poll` | 轮询工作 |
| `acknowledgeWork` | `POST /v1/environments/{id}/work/{wid}/ack` | 确认工作 |
| `stopWork` | `POST /v1/environments/{id}/work/{wid}/stop` | 停止工作 |
| `heartbeatWork` | `POST /v1/environments/{id}/work/{wid}/heartbeat` | 心跳保活 |
| `deregisterEnvironment` | `DELETE /v1/environments/bridge/{id}` | 注销环境 |
| `archiveSession` | `POST /v1/sessions/{id}/archive` | 归档会话 |
| `reconnectSession` | `POST /v1/environments/{id}/bridge/reconnect` | 重连会话 |
| `sendPermissionResponseEvent` | `POST /v1/sessions/{id}/events` | 权限响应 |

所有 API 调用都通过 `withOAuthRetry` 包装，在收到 401 时自动刷新 OAuth 令牌并重试一次。

---

## 7. 轮询参数动态调优

### 7.1 PollIntervalConfig

> 源码: `src/bridge/pollConfigDefaults.ts`

```typescript
export type PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: number               // 2000ms (寻找工作)
  poll_interval_ms_at_capacity: number                    // 600000ms (10分钟，存活信号)
  non_exclusive_heartbeat_interval_ms: number             // 0 (默认禁用)
  multisession_poll_interval_ms_not_at_capacity: number   // 2000ms
  multisession_poll_interval_ms_partial_capacity: number  // 2000ms
  multisession_poll_interval_ms_at_capacity: number       // 600000ms
  reclaim_older_than_ms: number                           // 5000ms (重新获取未确认工作)
  session_keepalive_interval_v2_ms: number                // 120000ms (2分钟保活)
}
```

通过 GrowthBook 特性标志 `tengu_bridge_poll_interval_config` 动态配置：
- 5 分钟刷新窗口（带缓存）
- Zod 校验确保：寻找工作间隔 ≥ 100ms，满载间隔为 0（禁用）或 ≥ 100ms

### 7.2 状态感知轮询

| 桥接状态 | 轮询间隔 | 目的 |
|----------|----------|------|
| 未满载，寻找工作 | 2s | 快速响应新任务 |
| 部分满载 | 2s | 继续接受任务 |
| 满载 | 600s 或心跳 | 存活信号 + Redis TTL |
| 满载 + 会话完成 | 立即唤醒 | 快速获取下一个任务 |

---

## 8. JWT 令牌刷新调度

> 源码: `src/bridge/jwtUtils.ts`

```typescript
export function createTokenRefreshScheduler({
  getAccessToken,         // 获取 OAuth 令牌
  onRefresh,              // 刷新回调
  label,                  // 标签（用于日志）
  refreshBufferMs = 5 * 60 * 1000,  // 到期前 5 分钟刷新
}) {
  schedule(sessionId, token)                 // 解码 JWT，安排刷新
  scheduleFromExpiresIn(sessionId, seconds)  // 使用 TTL 直接安排
  cancel(sessionId)                          // 取消某会话的计时器
  cancelAll()                                // 取消所有计时器
}
```

**时序计算**:
```
delayMs = JWT.exp * 1000 - Date.now() - refreshBufferMs
如果已过期: 立即触发
成功后: 30 分钟后安排后续刷新（兜底）
失败处理: 最多 3 次连续失败，每 60 秒重试
```

---

## 9. REPL 桥接模式 (remoteBridgeCore.ts)

与独立桥接不同，REPL 桥接直接在交互式会话中连接到后端，不经过 Environments API 的工作分发层：

```
REPL 桥接初始化流程:
  ① POST /v1/code/sessions (OAuth) → session_id
  ② POST /v1/code/sessions/{id}/bridge (OAuth) → worker_jwt, expires_in, epoch
  ③ createV2ReplTransport(worker_jwt, epoch) → SSE + CCRClient
  ④ createTokenRefreshScheduler → 主动刷新 /bridge
  ⑤ 401 on SSE → 用新凭据重建传输
```

由 GrowthBook 标志 `tengu_bridge_repl_v2` 控制，仅在 REPL 模式下启用。

---

## 10. 完整工作流时序

```
用户在 claude.ai 点击 "编辑代码"
         │
         ▼
    后端创建工作项
         │
         ▼
    Bridge 轮询 → 收到工作
         │
         ▼
    解码 WorkSecret
    ├── session_ingress_token (JWT)
    ├── api_base_url
    ├── mcp_config
    └── environment_variables
         │
         ▼
    生成子进程:
    claude --print --sdk-url <url> --session-id <id>
         │
         ▼
    子进程连接 WebSocket → 执行用户请求
         │
         ▼
    Bridge 解析 stdout NDJSON
    ├── tool_use → "Reading src/foo.ts"
    ├── text → 前 80 字符
    └── result → "Session completed"
         │
         ▼
    活动信息上报 → claude.ai 展示实时状态
         │
         ▼
    会话完成 → Bridge 确认 → 等待下一个工作
```

---

## 11. 设计分析

### 为什么选择轮询而非 WebSocket？

1. **防火墙友好**: HTTP 轮询穿透企业防火墙和代理更容易
2. **断线恢复**: 轮询天然具备重连能力，无需 WebSocket 重建
3. **服务端简单**: 后端只需维护无状态的 REST API，不需要 WebSocket 连接管理
4. **休眠兼容**: 笔记本电脑合盖唤醒后，轮询自动恢复

### 为什么子进程而非进程内？

1. **隔离性**: 子进程崩溃不影响 Bridge 守护进程
2. **安全**: WorkSecret 中的凭据仅注入到子进程环境，Bridge 自身的 OAuth 令牌被移除
3. **资源控制**: 每个会话独立的内存空间和 CPU 限制
4. **并发**: 通过 `maxSessions` 控制并发数，轻松实现多会话

### 三种 SpawnMode 的取舍

| 模式 | 优点 | 缺点 |
|------|------|------|
| `single-session` | 最简单，无冲突 | 一次只能一个任务 |
| `worktree` | 真正隔离，并发安全 | 磁盘开销大，worktree 管理复杂 |
| `same-dir` | 无额外开销 | 并发时文件可能冲突 |
