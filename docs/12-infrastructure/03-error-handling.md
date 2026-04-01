# Q: Agent 的错误处理有哪些特殊考量？

> **核心问题**：AI 编码代理不同于普通应用——它需要在不确定的环境中（网络不稳定、API 限流、文件系统变化、用户中断）持续运行。Claude Code 如何构建一个健壮的错误处理体系？

---

## 1. 错误处理架构全景

```
┌────────────────────────────────────────────────────────────────┐
│                     用户交互层                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  React Error Boundary (SentryErrorBoundary)              │ │
│  │  → UI 组件崩溃不会影响主进程                             │ │
│  └──────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│                     API 通信层                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  withRetry (10 次重试 + 指数退避)                        │ │
│  │  → 429 限流 / 529 过载 / 网络错误                        │ │
│  └──────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│                     工具执行层                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Tool error isolation + graceful degradation             │ │
│  │  → 单个工具失败不影响整体对话                            │ │
│  └──────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│                     进程生命周期层                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  gracefulShutdown (信号处理 + 终端清理 + 会话保存)        │ │
│  │  → 任何退出方式都保证状态持久化                           │ │
│  └──────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│                     会话恢复层                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  conversationRecovery (JSONL 重建 + 文件历史恢复)         │ │
│  │  → 崩溃后可从上次中断处继续                               │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. 自定义错误类型体系

### 2.1 核心错误类

> **源码引用**：`src/utils/errors.ts`（239 行）

```typescript
// 基础应用错误
export class ClaudeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeError'
  }
}

// 中断/取消错误
export class AbortError extends Error {
  constructor(message?: string) {
    super(message ?? 'Operation aborted')
    this.name = 'AbortError'
  }
}

// 配置解析错误（附带文件路径和默认值）
export class ConfigParseError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly defaultConfig: unknown
  ) { ... }
}

// Shell 执行错误（附带完整上下文）
export class ShellError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code: number | null,
    public readonly interrupted: boolean
  ) { ... }
}
```

### 2.2 遥测安全错误

```typescript
// 特殊命名约定：强制开发者确认错误消息不含代码或文件路径
export class TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  constructor(
    fullMessage: string,           // 完整错误信息（内部使用）
    public readonly safeMessage: string  // 可安全上报的信息
  ) { ... }
}
```

**设计智慧**：这个刻意冗长的类名 `_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 是一种"代码审查强制"——每次使用时，开发者都必须确认错误消息不包含敏感信息。这种命名约定比注释更有效。

### 2.3 错误工具函数

```typescript
// src/utils/errors.ts

// 判断是否是中断类错误（支持多种中断形态）
export function isAbortError(e: unknown): boolean

// 安全地将 unknown 转为 Error
export function toError(e: unknown): Error

// 安全提取错误信息
export function errorMessage(e: unknown): string

// 提取 errno 代码（ENOENT, EACCES 等）
export function getErrnoCode(e: unknown): string | undefined

// 判断文件系统是否不可访问
export function isFsInaccessible(e: unknown): boolean
// 检查: ENOENT, EACCES, EPERM, ENOTEMPTY, EISDIR, ENOTDIR

// 分类 Axios 错误
export function classifyAxiosError(e: unknown):
  'auth' | 'timeout' | 'network' | 'http' | 'other'

// 截断错误栈（默认最多 5 帧）
export function shortErrorStack(e: unknown, maxFrames = 5): string
```

---

## 3. API 错误处理——重试与退避

### 3.1 重试机制

> **源码引用**：`src/services/api/withRetry.ts`（822 行）

```typescript
const DEFAULT_MAX_RETRIES = 10
const MAX_529_RETRIES = 3
const BASE_DELAY_MS = 500
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000   // 5 分钟
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000  // 6 小时
```

重试循环的核心逻辑：

```
attempt 0: 直接请求
attempt 1: 429 → 等 500ms → 重试
attempt 2: 429 → 等 1000ms → 重试
attempt 3: 529 → 等 2000ms → 重试
attempt 4: ECONNRESET → 禁用 keep-alive → 重试
...
attempt 10: 放弃
```

### 3.2 HTTP 错误分类处理

```
HTTP 429 (Rate Limited):
┌─────────────┐
│ 检测 Retry-After Header │
│ 短延迟等待              │
│ 考虑 Fast Mode 降级     │
│ 最多重试 10 次          │
└─────────────┘

HTTP 529 (Overloaded):
┌─────────────┐
│ 只有前台操作重试        │    ← 关键决策！
│ 后台操作立即失败        │
│ 更长的退避时间          │
│ 最多重试 3 次           │
└─────────────┘

ECONNRESET / EPIPE:
┌─────────────┐
│ 禁用 HTTP keep-alive    │
│ 新建连接重试            │
│ SSL 错误给出提示        │
└─────────────┘
```

### 3.3 529 选择性重试

```typescript
// 只有用户等待的前台操作才重试 529
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',  // 用户直接交互
  'sdk',               // SDK 调用
  'agent:*',           // Agent 操作
  'compact',           // 压缩操作
  'hook_agent',        // Hook Agent
  'auto_mode',         // 自动模式
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  return querySource === undefined ||
    FOREGROUND_529_RETRY_SOURCES.has(querySource)
}
```

**设计原理**：529 表示服务端过载。后台操作（摘要生成、分类器）的重试会加剧过载（"拥堵放大"效应），应该立即失败。只有用户正在等待的操作才值得重试。

### 3.4 无人值守持久重试

```typescript
// 环境变量启用：CLAUDE_CODE_UNATTENDED_RETRY
// 在 CI/CD 场景中，429/529 会无限重试

// 退避策略：指数增长，上限 5 分钟
// 总时间上限：6 小时
// 定期发送 keep-alive 消息给调用者
```

### 3.5 Prompt Too Long 处理

```typescript
// src/services/api/errors.ts
export function parsePromptTooLongTokenCounts(message: string): {
  actual: number
  limit: number
} | undefined

export function getPromptTooLongTokenGap(message: string): number | undefined
```

当消息超过模型上下文窗口时：
1. 解析错误消息中的 token 数量（实际 vs 限制）
2. 触发**响应式压缩**（reactive compact）——自动压缩消息
3. 使用压缩后的消息重试

---

## 4. 工具执行错误处理

### 4.1 工具错误隔离

每个工具调用被独立的 try/catch 包裹：

```typescript
// 工具执行框架
async function executeToolCall(tool: Tool, input: unknown): Promise<ToolResult> {
  try {
    return await tool.call(input, context)
  } catch (error) {
    if (isAbortError(error)) {
      // 用户中断——不是错误，正常退出
      throw error
    }
    // 其他错误：格式化后返回给 LLM
    return {
      type: 'error',
      error: formatError(error)
    }
  }
}
```

**关键设计**：工具错误**不终止对话**，而是作为 `tool_result` 返回给 LLM。LLM 看到错误后可以：
- 尝试不同的参数重新调用
- 选择替代工具
- 向用户解释问题

### 4.2 特定工具错误

```typescript
// 文件读取：token 超限
class MaxFileReadTokenExceededError extends Error {
  // 文件内容超过 maxTokens 限制
  // 自动截断或建议使用 view_range
}

// MCP 工具：会话过期
class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends Error {
  // MCP 服务端返回错误
  // 需要重新认证或重连
}

// Shell 执行：进程错误
class ShellError extends Error {
  // 附带 stdout, stderr, exit code
  // 以及是否是用户中断
}
```

### 4.3 工具错误格式化

> **源码引用**：`src/utils/toolErrors.ts`

```typescript
export function formatError(error: unknown): string {
  if (error instanceof AbortError) return 'Operation was aborted'
  if (error instanceof ShellError) {
    // 组合 stdout + stderr + exit code
    return getErrorParts(error).join('\n')
  }
  return errorMessage(error)
}

export function formatZodValidationError(
  toolName: string,
  error: ZodError
): string {
  // 将 Zod 验证错误转换为 LLM 可理解的格式
}
```

---

## 5. React Error Boundary

### 5.1 UI 错误边界

> **源码引用**：`src/components/SentryErrorBoundary.ts`

```typescript
export class SentryErrorBoundary extends React.Component<Props, State> {
  static getDerivedStateFromError(): State {
    return { hasError: true }
  }
  
  render(): React.ReactNode {
    if (this.state.hasError) {
      return null  // 出错的组件变为空
    }
    return this.props.children
  }
}
```

**使用位置**：
- `PromptInput/Notifications.tsx` — 通知组件
- `UserToolResultMessage/UserToolSuccessMessage.tsx` — 工具结果展示
- `AssistantToolUseMessage.tsx` — Assistant 工具调用消息

### 5.2 设计决策：出错渲染为 null

当 UI 组件抛出异常时，`SentryErrorBoundary` 将其渲染为空（`null`），而不是显示错误信息或崩溃整个应用。

**为什么？**
- Terminal UI 空间有限，显示错误堆栈会扰乱布局
- 用户更关心对话能否继续，而非某个 UI 组件是否正确渲染
- 错误通过遥测上报，开发者可以在后台分析

---

## 6. 进程退出与信号处理

### 6.1 优雅关闭系统

> **源码引用**：`src/utils/gracefulShutdown.ts`（530 行）

```typescript
// 信号注册
process.on('SIGINT',  () => gracefulShutdown(0))     // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown(143))    // kill
process.on('SIGHUP',  () => gracefulShutdown(129))    // 终端关闭

// macOS 孤儿进程检测
if (process.stdin.isTTY) {
  orphanCheckInterval = setInterval(() => {
    if (!process.stdout.writable || !process.stdin.readable) {
      gracefulShutdown(129)  // TTY 已断开
    }
  }, 30_000)
}
```

### 6.2 关闭流程详解

```
gracefulShutdown(exitCode)
│
├─ 1. 设置安全超时 (max(5s, hookBudget + 3.5s))
│     → 即使清理卡住也保证退出
│
├─ 2. 终端模式清理
│     ├─ 禁用鼠标追踪
│     ├─ 卸载 Ink 渲染
│     ├─ 禁用 Kitty 键盘协议
│     ├─ 显示光标
│     └─ 清除 iTerm2 进度条
│
├─ 3. 打印会话恢复提示
│     → "claude --resume" 提示用户如何恢复
│
├─ 4. 运行清理函数 (2s 超时)
│     → 注册的 cleanup callbacks
│
├─ 5. 执行 SessionEnd Hooks (受 hook 超时约束)
│     → 用户自定义的会话结束钩子
│
├─ 6. 刷新分析数据 (500ms 上限)
│     → 确保遥测数据不丢失
│
└─ 7. 强制退出
      → process.exit(exitCode)
      → 处理 EIO 错误（死终端）
```

### 6.3 安全超时机制

```typescript
// src/utils/gracefulShutdown.ts:414-425
failsafeTimer = setTimeout(
  (code) => {
    cleanupTerminalModes()
    printResumeHint()
    forceExit(code)
  },
  Math.max(5000, sessionEndTimeoutMs + 3500),
  exitCode
)
failsafeTimer.unref()  // 不阻止进程退出
```

**为什么需要安全超时？**
- MCP 连接可能挂起
- Hook 脚本可能无响应
- 分析数据 flush 可能网络超时
- 用户期望 Ctrl+C 能立即（或接近立即）退出

### 6.4 未捕获异常处理

```typescript
// src/utils/gracefulShutdown.ts:301-310
process.on('uncaughtException', error => {
  logForDiagnosticsNoPII('error', 'uncaught_exception', {
    error_name: error.name,
    error_message: error.message.slice(0, 2000),
  })
})

process.on('unhandledRejection', reason => {
  logForDiagnosticsNoPII('error', 'unhandled_rejection', errorInfo)
})
```

**设计决策**：未捕获异常**不终止进程**，只记录日志。对于 Agent 应用，保持运行比崩溃更重要。

### 6.5 EPIPE 处理

```typescript
// src/utils/process.ts
export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
}
```

当用户运行 `claude -p "question" | head -1` 时，`head` 读完一行就关闭管道。后续的 `stdout.write()` 会抛 EPIPE。这个处理器确保 EPIPE 不会变成未捕获异常。

---

## 7. 会话恢复

### 7.1 崩溃恢复机制

> **源码引用**：`src/utils/conversationRecovery.ts`

会话以 JSONL 格式持久化到磁盘。崩溃后恢复流程：

```
1. 加载 JSONL 消息文件
2. 过滤异常消息：
   ├─ 孤立的 thinking-only 消息
   ├─ 未解决的 tool_use（无对应 tool_result）
   └─ 纯空白的 assistant 消息
3. 重建对话链
4. 恢复文件历史快照（copyFileHistoryForResume）
5. 执行 session-start hooks
6. 检查恢复一致性
```

### 7.2 消息修复

```typescript
// 恢复后的消息规范化
filterOrphanedThinkingOnlyMessages()  // 移除只有思考没有输出的消息
filterUnresolvedToolUses()             // 移除没有结果的工具调用
filterWhitespaceOnlyAssistantMessages() // 移除空白消息
buildConversationChain()               // 重建对话链
checkResumeConsistency()               // 验证恢复一致性
```

**为什么需要消息修复？**

如果 Agent 在以下时刻崩溃：
- 工具调用发出后、结果返回前 → 产生"未解决的 tool_use"
- 思考过程中 → 产生"孤立的 thinking 消息"
- API 响应中 → 产生"不完整的 assistant 消息"

这些不完整消息如果直接发给 API，会导致错误。恢复流程通过清理确保消息序列合法。

---

## 8. SSL/TLS 错误特殊处理

> **源码引用**：`src/services/api/errorUtils.ts`

```typescript
// 深度遍历错误链找到根因
export function extractConnectionErrorDetails(error: unknown): {
  code: string
  rootCause: Error
} {
  // 遍历 error.cause 链
  // 提取 ECONNRESET, ECONNREFUSED, SSL 错误码等
}

// SSL 错误特殊提示
export function getSSLErrorHint(code: string): string | null {
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE → "检查代理证书配置"
  // SELF_SIGNED_CERT_IN_CHAIN → "设置 NODE_EXTRA_CA_CERTS"
  // ERR_TLS_CERT_ALTNAME_INVALID → "检查 API URL 是否正确"
}
```

**被追踪的 SSL 错误码**：
- 证书验证：`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_CHAIN_TOO_LONG`
- 自签名：`DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`
- 主机名：`ERR_TLS_CERT_ALTNAME_INVALID`, `HOSTNAME_MISMATCH`

**为什么专门处理 SSL？** 企业环境中，SSL 中间人代理（MITM proxy）是最常见的连接问题。给出精确的错误提示能大幅减少用户排障时间。

---

## 9. Bridge/OAuth 错误处理

> **源码引用**：`src/bridge/bridgeApi.ts`

```typescript
// OAuth 401 自动刷新
async function withOAuthRetry<T>(fn: () => Promise<Response>): Promise<Response> {
  const response = await fn()
  if (response.status === 401 && onAuth401) {
    const tokenRefreshed = await onAuth401(getAccessToken())
    if (tokenRefreshed) {
      return fn()  // 用新 token 重试一次
    }
  }
  return response
}

// 状态码分类处理
function handleErrorStatus(status: number, data: unknown, context: string): never {
  switch (status) {
    case 404: throw new BridgeFatalError(`Not found`, 404, errorType)
    case 410: throw new BridgeFatalError('Session expired', 410, 'environment_expired')
    case 429: throw new Error(`Rate limited`)
    default:  throw new Error(`Failed with status ${status}`)
  }
}
```

---

## 10. 设计哲学：Fail-Open vs Fail-Closed

### 10.1 Agent 应用的特殊性

传统应用的错误处理原则是"fail-closed"（遇到错误就停止），但 Agent 应用更偏向"fail-open"：

| 场景 | 传统应用 | Agent 应用 |
|------|----------|-----------|
| UI 组件崩溃 | 显示错误页面 | 渲染为空，继续运行 |
| 工具调用失败 | 抛异常中断 | 返回错误消息给 LLM |
| API 超时 | 返回错误给用户 | 自动重试 10 次 |
| 未捕获异常 | 进程退出 | 记录日志，继续运行 |
| 会话崩溃 | 数据丢失 | JSONL 自动恢复 |

### 10.2 为什么 Agent 更适合 Fail-Open？

1. **LLM 有自愈能力**：看到工具错误后可以尝试其他方法
2. **对话有上下文**：中断意味着丢失已建立的上下文（代价极高）
3. **用户容忍度不同**：偶尔的 UI 抖动 < 对话突然终止
4. **幂等操作居多**：大多数文件操作可以安全重试

### 10.3 例外：必须 Fail-Closed 的场景

- **权限检查**：任何权限相关错误必须 deny（安全边界不能 fail-open）
- **文件写入**：写入操作必须在确认前获得用户许可
- **Git 推送**：推送到远程必须确认成功或失败

---

## 11. 启发与超越

### 构建你自己的错误处理体系

1. **分层设计**：UI 层、API 层、工具层、进程层各自处理各自的错误
2. **优雅降级**而非硬崩溃——Agent 的价值在于持续运行
3. **遥测安全**：用命名约定（`_I_VERIFIED_...`）强制开发者注意信息安全
4. **会话恢复必须从第一天就设计**，不能事后补
5. **分类重试策略**：前台和后台操作的重试策略应该不同
6. **安全超时是最后防线**：任何清理过程都可能卡住，必须有最终超时
7. **SSL 错误值得特殊对待**——它是企业环境中最常见的痛点
