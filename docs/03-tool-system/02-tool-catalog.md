# Q: Claude Code 的 43+ 工具全图鉴——每个工具解决什么问题？

> 本文通过 `src/tools.ts:getAllBaseTools()` 收集所有工具，按类别分组，提供完整工具图鉴。

---

## 1. 全景概览

Claude Code 的工具池由 `getAllBaseTools()` 函数定义（`src/tools.ts:L193-L251`），根据运行时环境和 feature flag 动态组装。完整工具可分为以下类别：

```
文件操作 (5)  │  搜索 (3)  │  Shell (2)  │  代理/任务 (7)
MCP (3)      │  规划 (3)  │  协作 (4)   │  Web (2)
特殊工具 (8+) │  Feature-gated (13+)
```

---

## 2. 文件操作工具

### FileReadTool — 读取文件
| 属性 | 值 |
|------|-----|
| 名称 | `Read` |
| 源码 | `src/tools/FileReadTool/FileReadTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 输入 | `{file_path: string, offset?: number, limit?: number}` |
| 关键实现 | 支持行范围读取、图片 base64 编码、PDF 文本提取；`maxResultSizeChars: Infinity`（防止 Read→file→Read 循环） |

### FileEditTool — 编辑文件
| 属性 | 值 |
|------|-----|
| 名称 | `Edit` |
| 源码 | `src/tools/FileEditTool/FileEditTool.ts` |
| 只读 | ❌ `false` |
| 并发安全 | ❌ `false` |
| 输入 | `{file_path: string, old_string: string, new_string: string}` |
| 关键实现 | 基于精确字符串匹配的 search-and-replace；要求 `old_string` 在文件中唯一匹配；产生 unified diff 输出 |

### FileWriteTool — 创建/覆写文件
| 属性 | 值 |
|------|-----|
| 名称 | `Write` |
| 源码 | `src/tools/FileWriteTool/FileWriteTool.ts` |
| 只读 | ❌ `false` |
| 并发安全 | ❌ `false` |
| 输入 | `{file_path: string, content: string}` |
| 关键实现 | 创建新文件或覆写整个文件；会自动创建中间目录；被标记为 `isDestructive` |

### NotebookEditTool — 编辑 Jupyter Notebook
| 属性 | 值 |
|------|-----|
| 名称 | `NotebookEdit` |
| 源码 | `src/tools/NotebookEditTool/NotebookEditTool.ts` |
| 只读 | ❌ `false` |
| 并发安全 | ❌ `false` |
| 输入 | `{notebook_path: string, cell_number: number, new_source?: string, cell_type?: string}` |
| 关键实现 | 操作 .ipynb 文件的 JSON 结构，支持增/删/改 cell |

### ConfigTool — 配置管理
| 属性 | 值 |
|------|-----|
| 名称 | `Config` |
| 源码 | `src/tools/ConfigTool/ConfigTool.ts` |
| 只读 | 取决于操作：`get` 只读，`set` 非只读 |
| 并发安全 | ❌ `false` |
| 输入 | `{action: 'get'|'set', key: string, value?: string}` |
| Feature Flag | `USER_TYPE === 'ant'` |

---

## 3. Shell 工具

### BashTool — 执行 Shell 命令
| 属性 | 值 |
|------|-----|
| 名称 | `Bash` |
| 源码 | `src/tools/BashTool/BashTool.tsx` |
| 只读 | **取决于命令** — 通过 shell 命令静态分析判断 |
| 并发安全 | **取决于命令** — `isReadOnly` 为 true 时可并发 |
| 输入 | `{command: string, timeout?: number, description?: string}` |
| 关键实现 | 最复杂的工具之一；命令分析引擎判断只读性；沙箱隔离；超时控制；进度流式输出；speculative classifier 预检 |

```typescript
// src/tools/BashTool/BashTool.tsx:L434-L438
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
isReadOnly(input) {
  // 对 shell 命令做静态分析：
  // grep, cat, ls, find, wc → 只读
  // rm, mv, echo >, pip install → 非只读
}
```

### PowerShellTool — PowerShell 命令
| 属性 | 值 |
|------|-----|
| 名称 | `PowerShell` |
| 源码 | `src/tools/PowerShellTool/PowerShellTool.tsx` |
| 只读 | 取决于命令（类似 BashTool 的分析逻辑） |
| 并发安全 | 取决于只读性 |
| 输入 | `{command: string, timeout?: number}` |
| Feature Flag | `isPowerShellToolEnabled()` — Windows 平台 |

---

## 4. 搜索工具

### GrepTool — 内容搜索
| 属性 | 值 |
|------|-----|
| 名称 | `Grep` |
| 源码 | `src/tools/GrepTool/GrepTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 输入 | `{pattern: string, path?: string, glob?: string, include?: string}` |
| 关键实现 | 底层调用 ripgrep；自动排除 .gitignore 文件；支持正则表达式 |

### GlobTool — 文件名搜索
| 属性 | 值 |
|------|-----|
| 名称 | `Glob` |
| 源码 | `src/tools/GlobTool/GlobTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 输入 | `{pattern: string, path?: string}` |
| 关键实现 | 快速文件路径匹配；支持 `**` 递归通配符 |

### ToolSearchTool — 工具搜索
| 属性 | 值 |
|------|-----|
| 名称 | `ToolSearch` |
| 源码 | `src/tools/ToolSearchTool/ToolSearchTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 输入 | `{query: string}` |
| 关键实现 | 当工具数量超过阈值时启用；模型通过关键词搜索发现被延迟加载的工具；支持 `select:ToolName` 精确选择 |
| Feature Flag | `isToolSearchEnabledOptimistic()` |

> **注意**: 当 ant-native 构建嵌入了 bfs/ugrep 时（`hasEmbeddedSearchTools()`），GlobTool 和 GrepTool 会被移除，因为 shell 中的 grep/find 已经被别名到快速工具。

---

## 5. 代理/任务工具

### AgentTool — 创建子代理
| 属性 | 值 |
|------|-----|
| 名称 | `Agent` |
| 源码 | `src/tools/AgentTool/AgentTool.tsx` |
| 只读 | ❌ `false` |
| 并发安全 | ❌ `false` |
| 输入 | `{prompt: string, agent_name?: string}` |
| 关键实现 | 创建独立的子代理会话，拥有自己的工具集和上下文；支持自定义代理定义（从 `.claude/agents/` 加载） |

### TaskOutputTool — 输出任务结果
| 属性 | 值 |
|------|-----|
| 名称 | `TaskOutput` |
| 源码 | `src/tools/TaskOutputTool/TaskOutputTool.tsx` |
| 只读 | 取决于输入 |
| 并发安全 | 取决于只读性 |
| 输入 | `{output: string}` |
| 关键实现 | 子代理向父代理返回结果的专用通道 |

### TaskStopTool — 停止任务
| 属性 | 值 |
|------|-----|
| 名称 | `TaskStop` |
| 源码 | `src/tools/TaskStopTool/TaskStopTool.ts` |
| 只读 | 默认 `false` |
| 并发安全 | ❌ `false` |
| 输入 | `{task_id: string}` |
| 关键实现 | 停止正在运行的子代理任务 |

### TaskCreateTool — 创建任务
| 属性 | 值 |
|------|-----|
| 名称 | `TaskCreate` |
| 源码 | `src/tools/TaskCreateTool/TaskCreateTool.ts` |
| 只读 | 默认 `false` |
| 并发安全 | ✅ `true` |
| 输入 | `{title: string, description?: string}` |
| Feature Flag | `isTodoV2Enabled()` |

### TaskGetTool — 获取任务详情
| 属性 | 值 |
|------|-----|
| 名称 | `TaskGet` |
| 源码 | `src/tools/TaskGetTool/TaskGetTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| Feature Flag | `isTodoV2Enabled()` |

### TaskUpdateTool — 更新任务
| 属性 | 值 |
|------|-----|
| 名称 | `TaskUpdate` |
| 源码 | `src/tools/TaskUpdateTool/TaskUpdateTool.ts` |
| 只读 | 默认 `false` |
| 并发安全 | ❌ `false` |
| Feature Flag | `isTodoV2Enabled()` |

### TaskListTool — 列出任务
| 属性 | 值 |
|------|-----|
| 名称 | `TaskList` |
| 源码 | `src/tools/TaskListTool/TaskListTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| Feature Flag | `isTodoV2Enabled()` |

---

## 6. 规划工具

### EnterPlanModeTool — 进入计划模式
| 属性 | 值 |
|------|-----|
| 名称 | `EnterPlanMode` |
| 源码 | `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ❌ `false` |
| 关键实现 | 切换到 plan 权限模式，限制写入操作 |

### ExitPlanModeV2Tool — 退出计划模式
| 属性 | 值 |
|------|-----|
| 名称 | `ExitPlanMode` |
| 源码 | `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` |
| 只读 | ❌ `false` |
| 并发安全 | ❌ `false` |
| 关键实现 | 恢复之前的权限模式 |

### TodoWriteTool — 待办事项
| 属性 | 值 |
|------|-----|
| 名称 | `TodoWrite` |
| 源码 | `src/tools/TodoWriteTool/TodoWriteTool.ts` |
| 只读 | 默认 `false` |
| 并发安全 | 默认 `false` |
| 输入 | `{todos: Array<{id, title, status, priority?, ...}>}` |
| 关键实现 | 管理任务清单，支持状态追踪 |

---

## 7. 交互工具

### AskUserQuestionTool — 询问用户
| 属性 | 值 |
|------|-----|
| 名称 | `AskUserQuestion` |
| 源码 | `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` |
| 只读 | ✅ `true` |
| 并发安全 | ❌ `false` |
| 输入 | `{question: string}` |
| 关键实现 | 暂停执行，等待用户输入；`requiresUserInteraction()` 返回 `true` |

### BriefTool — 简短回复
| 属性 | 值 |
|------|-----|
| 名称 | `Brief` |
| 源码 | `src/tools/BriefTool/BriefTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 关键实现 | 标记当前回复为简短模式 |

### SendMessageTool — 发送消息
| 属性 | 值 |
|------|-----|
| 名称 | `SendMessage` |
| 源码 | `src/tools/SendMessageTool/SendMessageTool.ts` |
| 只读 | 取决于输入 |
| 并发安全 | 默认 `false` |
| 关键实现 | 通过 lazy require 加载，打破循环依赖；用于代理间通信 |

---

## 8. Web 工具

### WebFetchTool — 获取网页
| 属性 | 值 |
|------|-----|
| 名称 | `WebFetch` |
| 源码 | `src/tools/WebFetchTool/WebFetchTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 输入 | `{url: string, raw?: boolean, max_length?: number}` |
| 关键实现 | 获取 URL 内容，支持 HTML→Markdown 转换 |

### WebSearchTool — Web 搜索
| 属性 | 值 |
|------|-----|
| 名称 | `WebSearch` |
| 源码 | `src/tools/WebSearchTool/WebSearchTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 输入 | `{query: string}` |
| 关键实现 | 调用搜索 API，返回带引用的结果 |

---

## 9. MCP 工具

### MCPTool — MCP 工具调用
| 属性 | 值 |
|------|-----|
| 名称 | `mcp__<server>__<tool>` (动态) |
| 源码 | `src/tools/MCPTool/` |
| 关键实现 | 桥接 MCP 协议，动态注册；`isMcp: true` 标记 |

### ListMcpResourcesTool — 列出 MCP 资源
| 属性 | 值 |
|------|-----|
| 名称 | `ListMcpResources` |
| 源码 | `src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 关键实现 | 列出 MCP 服务器提供的资源 |

### ReadMcpResourceTool — 读取 MCP 资源
| 属性 | 值 |
|------|-----|
| 名称 | `ReadMcpResource` |
| 源码 | `src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 关键实现 | 通过 URI 读取 MCP 服务器的特定资源 |

---

## 10. 协作工具

### TeamCreateTool — 创建团队
| 属性 | 值 |
|------|-----|
| 名称 | `TeamCreate` |
| 源码 | `src/tools/TeamCreateTool/TeamCreateTool.ts` |
| Feature Flag | `isAgentSwarmsEnabled()` |
| 关键实现 | 通过 lazy require 加载，打破循环依赖 |

### TeamDeleteTool — 删除团队
| 属性 | 值 |
|------|-----|
| 名称 | `TeamDelete` |
| 源码 | `src/tools/TeamDeleteTool/TeamDeleteTool.ts` |
| Feature Flag | `isAgentSwarmsEnabled()` |

### EnterWorktreeTool — 进入 Git worktree
| 属性 | 值 |
|------|-----|
| 名称 | `EnterWorktree` |
| 源码 | `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts` |
| Feature Flag | `isWorktreeModeEnabled()` |

### ExitWorktreeTool — 退出 Git worktree
| 属性 | 值 |
|------|-----|
| 名称 | `ExitWorktree` |
| 源码 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts` |
| Feature Flag | `isWorktreeModeEnabled()` |

---

## 11. 特殊工具

### SkillTool — 技能调用
| 属性 | 值 |
|------|-----|
| 名称 | `Skill` |
| 源码 | `src/tools/SkillTool/SkillTool.ts` |
| 关键实现 | 加载和执行预定义技能（skill）文件 |

### TungstenTool — 虚拟终端
| 属性 | 值 |
|------|-----|
| 名称 | `Tungsten` |
| 源码 | `src/tools/TungstenTool/TungstenTool.ts` |
| Feature Flag | `USER_TYPE === 'ant'` |
| 关键实现 | 使用单例虚拟终端抽象 |

### LSPTool — Language Server Protocol
| 属性 | 值 |
|------|-----|
| 名称 | `LSP` |
| 源码 | `src/tools/LSPTool/LSPTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| Feature Flag | `ENABLE_LSP_TOOL` 环境变量 |

### SyntheticOutputTool — 合成输出
| 属性 | 值 |
|------|-----|
| 名称 | `SyntheticOutput` |
| 源码 | `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts` |
| 只读 | ✅ `true` |
| 并发安全 | ✅ `true` |
| 关键实现 | 作为"特殊工具"不在 getAllBaseTools 中直接注册，而是作为 specialTools 集合管理 |

---

## 12. Feature-Gated 工具全览

以下工具通过 `feature()` 编译时门控或运行时环境变量控制加载：

| 工具 | Feature Flag | 用途 |
|------|-------------|------|
| `REPLTool` | `USER_TYPE === 'ant'` | 在 VM 沙箱中包装 Bash/Read/Edit |
| `SuggestBackgroundPRTool` | `USER_TYPE === 'ant'` | 建议创建后台 PR |
| `SleepTool` | `PROACTIVE \|\| KAIROS` | 暂停执行指定时间 |
| `CronCreateTool` | `AGENT_TRIGGERS` | 创建定时任务 |
| `CronDeleteTool` | `AGENT_TRIGGERS` | 删除定时任务 |
| `CronListTool` | `AGENT_TRIGGERS` | 列出定时任务 |
| `RemoteTriggerTool` | `AGENT_TRIGGERS_REMOTE` | 远程触发器 |
| `MonitorTool` | `MONITOR_TOOL` | 监控工具 |
| `SendUserFileTool` | `KAIROS` | 向用户发送文件 |
| `PushNotificationTool` | `KAIROS \|\| KAIROS_PUSH_NOTIFICATION` | 推送通知 |
| `SubscribePRTool` | `KAIROS_GITHUB_WEBHOOKS` | 订阅 PR 事件 |
| `WebBrowserTool` | `WEB_BROWSER_TOOL` | 浏览器操作 |
| `OverflowTestTool` | `OVERFLOW_TEST_TOOL` | 溢出测试（内部） |
| `CtxInspectTool` | `CONTEXT_COLLAPSE` | 上下文检查 |
| `TerminalCaptureTool` | `TERMINAL_PANEL` | 终端截图 |
| `SnipTool` | `HISTORY_SNIP` | 历史裁剪 |
| `ListPeersTool` | `UDS_INBOX` | 列出对等节点 |
| `WorkflowTool` | `WORKFLOW_SCRIPTS` | 执行工作流脚本 |
| `VerifyPlanExecutionTool` | `CLAUDE_CODE_VERIFY_PLAN` 环境变量 | 验证计划执行 |

```typescript
// src/tools.ts:L26-L28 — feature() 编译门控示例
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
```

---

## 13. 工具加载模式

### 静态 import
大部分核心工具使用标准 ES import：
```typescript
// src/tools.ts:L3-L11
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
```

### Lazy require — 打破循环依赖
```typescript
// src/tools.ts:L63-L72
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool

const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool
```

### 条件 require + Dead Code Elimination
```typescript
// src/tools.ts:L117-L119
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
```

当 `feature('WEB_BROWSER_TOOL')` 在编译时为 `false`，esbuild 的 dead code elimination 会移除整个 require 调用。

---

## 14. 并发安全性速查表

| 始终并发安全 | 有条件并发安全 | 始终串行 |
|-------------|--------------|----------|
| GrepTool ✅ | BashTool（只读命令） | FileEditTool ❌ |
| GlobTool ✅ | PowerShellTool（只读命令） | FileWriteTool ❌ |
| FileReadTool ✅ | ConfigTool（get 操作） | AgentTool ❌ |
| WebFetchTool ✅ | TaskOutputTool（只读输入） | NotebookEditTool ❌ |
| WebSearchTool ✅ | | EnterPlanModeTool ❌ |
| ToolSearchTool ✅ | | ExitPlanModeTool ❌ |
| ListMcpResourcesTool ✅ | | AskUserQuestionTool ❌ |
| ReadMcpResourceTool ✅ | | TaskStopTool ❌ |
| LSPTool ✅ | | |
| BriefTool ✅ | | |
| TaskCreateTool ✅ | | |
| TaskGetTool ✅ | | |
| TaskListTool ✅ | | |

---

## 15. 设计分析：为什么这么多工具？

### 粒度选择的权衡

Claude Code 选择了**细粒度**的工具设计，原因包括：

1. **权限精细控制**: 每个工具有独立的权限检查。FileRead 和 FileEdit 分开，允许"只读模式"只启用读取
2. **并发优化**: 细粒度使得系统可以精确判断哪些操作可以并发
3. **提示词优化**: 每个工具有独立的 `prompt()`，可以针对性地优化系统提示
4. **UI 定制**: 每个工具有独立的渲染方法，展示最适合的 UI

### 工具数量膨胀的控制

`ToolSearchTool` 就是应对工具膨胀的解决方案：当工具总数超过阈值时，不常用的工具被标记为 `shouldDefer`，模型需要先搜索才能使用它们：

```typescript
// src/tools.ts:L248-L250
// Include ToolSearchTool when tool search might be enabled
...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
```

### 子代理工具限制

不同执行上下文使用不同的工具子集：

```typescript
// src/constants/tools.ts:L36-L46
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,        // 防止子代理直接输出到父级
  EXIT_PLAN_MODE_V2_TOOL_NAME,  // 计划模式是主线程抽象
  ENTER_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,  // 子代理不能直接询问用户
  TASK_STOP_TOOL_NAME,          // 需要主线程任务状态
])
```

Coordinator 模式更极端——只允许 Agent、TaskStop、SendMessage、SyntheticOutput 四个工具：

```typescript
// src/constants/tools.ts:L107-L112
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

---

## 16. 关键总结

| 维度 | 数据 |
|------|------|
| 核心内置工具 | ~25 个（始终可用） |
| Feature-gated 工具 | ~18 个（条件加载） |
| MCP 动态工具 | 无限量（运行时注册） |
| 始终并发安全 | ~13 个 |
| 始终串行 | ~8 个 |
| 条件并发 | ~4 个 |
| 加载模式 | 静态 import / lazy require / conditional require |
