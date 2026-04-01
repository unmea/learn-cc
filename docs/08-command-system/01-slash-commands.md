# 如何设计一个可扩展的命令系统？

> **Q: Claude Code 有 101 个命令目录、多种命令类型、条件启用、Tab 补全——
> 这个命令系统是如何设计的？**

---

## 1. 命令系统全景

### 1.1 数字概览

```
src/commands/ 统计:
├── 目录数: 89 个命令目录（每个目录一个命令）
├── 独立文件: 12 个 .ts/.tsx 文件（简单命令）
├── 总计: ~101 个命令注册点
├── 注册入口: src/commands.ts (754 行)
├── 类型定义: src/types/command.ts (220+ 行)
├── 解析工具: src/utils/slashCommandParsing.ts (60 行)
└── 补全入口: src/hooks/useTypeahead.tsx
```

### 1.2 三种命令类型

```typescript
// src/types/command.ts:205-206
export type Command = CommandBase & (
  | PromptCommand      // AI 驱动：发送 prompt 给模型执行
  | LocalCommand       // 本地执行：直接在 CLI 中运行
  | LocalJSXCommand    // UI 渲染：返回 React 组件展示在界面中
)
```

```
命令类型对比:

PromptCommand (type: 'prompt')
├── 执行方式: 构造 prompt → 发送给 AI 模型 → 模型输出结果
├── 典型命令: /commit, /review, /compact, /init, /security-review
├── 特点: 需要 AI 理解和执行
├── 关键字段: getPromptForCommand(), progressMessage, contentLength
└── 来源: 技能系统（skills）、插件、MCP

LocalCommand (type: 'local')
├── 执行方式: 直接在 Node.js 中执行函数
├── 典型命令: /clear, /exit, /cost, /help, /vim
├── 特点: 不需要 AI，即时完成
├── 关键字段: load() → { call(args, context) }
└── 支持: supportsNonInteractive（headless 模式可用）

LocalJSXCommand (type: 'local-jsx')
├── 执行方式: 返回 React JSX 组件渲染到终端
├── 典型命令: /config, /context, /mcp, /permissions
├── 特点: 需要用户交互的全屏界面
├── 关键字段: call() → JSX.Element
└── onDone: 渲染完成后的回调
```

---

## 2. Command 接口详解

### 2.1 CommandBase 类型

```typescript
// src/types/command.ts:175-203
export type CommandBase = {
  // ── 基本信息 ──
  name: string                        // 命令名: 'help', 'clear', 'config'
  description: string                 // 用户可见描述
  aliases?: string[]                  // 别名: ['settings'] for 'config'
  argumentHint?: string               // 参数提示（灰色显示在命令后）

  // ── 可见性控制 ──
  isEnabled?: () => boolean           // 条件启用（默认 true）
  isHidden?: boolean                  // 从 typeahead/help 中隐藏（默认 false）
  availability?: CommandAvailability[]// 认证要求: ['claude-ai', 'console']

  // ── 技能/插件相关 ──
  isMcp?: boolean                     // MCP 命令标记
  whenToUse?: string                  // 使用场景描述
  version?: string                    // 版本号
  disableModelInvocation?: boolean    // 禁止模型调用此命令
  userInvocable?: boolean             // 用户可通过 /skill-name 调用
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'                   // 工作流命令（在补全中有标记）

  // ── 执行控制 ──
  immediate?: boolean                 // 立即执行，不排队
  isSensitive?: boolean               // 参数从对话历史中隐去
  hasUserSpecifiedDescription?: boolean

  // ── 显示 ──
  userFacingName?: () => string       // 覆盖显示名称
}
```

### 2.2 PromptCommand 详解

```typescript
// src/types/command.ts:36-73
export type PromptCommand = {
  type: 'prompt'
  progressMessage: string              // 执行时的进度提示
  contentLength: number                // 内容长度（用于 token 估算）
  argNames?: string[]                  // 命名参数
  allowedTools?: string[]              // 允许使用的工具
  model?: string                       // 指定使用的模型
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'

  // 技能执行上下文
  context?: 'inline' | 'fork'         // inline=内联展开, fork=子代理执行
  agent?: string                       // fork 时使用的代理类型
  effort?: EffortValue                 // 执行力度
  paths?: string[]                     // 文件路径 glob 模式

  // 插件信息
  pluginInfo?: {
    pluginManifest: PluginManifest
    repository: string
  }

  // 钩子
  hooks?: HooksSettings
  skillRoot?: string

  // 核心方法：构造 prompt
  getPromptForCommand(
    args: string,
    context: ToolUseContext,
  ): Promise<ContentBlockParam[]>
}
```

### 2.3 LocalCommand

```typescript
// src/types/command.ts:84-88
type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean     // 支持 headless 模式
  load: () => Promise<LocalCommandModule>  // 懒加载实现
}

// 懒加载模块
export type LocalCommandModule = {
  call: LocalCommandCall              // 实际执行函数
}

export type LocalCommandCall = (
  args: string,
  context: LocalJSXCommandContext,
) => Promise<LocalCommandResult>

// 执行结果
export type LocalCommandResult =
  | { type: 'text'; value: string }           // 文本结果
  | { type: 'compact'; compactionResult: CompactionResult } // 压缩结果
  | { type: 'skip' }                         // 跳过（不显示）
```

### 2.4 LocalJSXCommand

```typescript
// src/types/command.ts
type LocalJSXCommand = {
  type: 'local-jsx'
  call: (
    args: string,
    onDone: (result: CommandResultDisplay) => void,
    context: LocalJSXCommandContext,
  ) => JSX.Element                    // 返回 React 组件
}

// 结果显示方式
export type CommandResultDisplay =
  | 'skip'    // 不显示结果
  | 'system'  // 显示为系统消息
  | 'user'    // 显示为用户消息
```

---

## 3. 命令注册机制

### 3.1 getCommands() — 命令收集

```typescript
// src/commands.ts:476-517
export async function getCommands(cwd: string): Promise<Command[]> {
  // 1. 加载所有命令
  const allCommands = await loadAllCommands(cwd)

  // 2. 获取动态技能（运行时注册的）
  const dynamicSkills = getDynamicSkills()

  // 3. 按条件过滤
  const baseCommands = allCommands.filter(cmd =>
    meetsAvailabilityRequirement(cmd) &&  // 认证要求
    isCommandEnabled(cmd)                  // 条件启用
  )

  // 4. 动态技能去重
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(s =>
    !baseCommandNames.has(s.name) &&
    meetsAvailabilityRequirement(s) &&
    isCommandEnabled(s)
  )

  // 5. 排序插入：动态技能在插件之后、内置之前
  const insertIndex = findInsertionPoint(baseCommands)
  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}
```

### 3.2 loadAllCommands() — 命令加载链

```
命令加载优先级链:
1. 内置命令 (COMMANDS 函数)
   └── src/commands/ 目录中的所有命令
2. 用户技能 (skills)
   └── ~/.claude/skills/ 和项目级 .claude/skills/
3. 插件命令 (plugins)
   └── 第三方插件注册的命令
4. 托管命令 (managed)
   └── 组织管理的命令
5. MCP 命令
   └── MCP 服务器提供的命令
6. 动态技能
   └── 运行时动态注册的技能
```

### 3.3 命令查找

```typescript
// src/commands.ts 中的查找函数

// 精确查找（含别名）
export function findCommand(
  name: string,
  commands: Command[]
): Command | undefined {
  return commands.find(cmd =>
    cmd.name === name || cmd.aliases?.includes(name)
  )
}

// 布尔检查
export function hasCommand(name: string, commands: Command[]): boolean {
  return findCommand(name, commands) !== undefined
}

// 断言查找（不存在则抛错）
export function getCommand(name: string, commands: Command[]): Command {
  const cmd = findCommand(name, commands)
  if (!cmd) throw new Error(`Command not found: ${name}`)
  return cmd
}
```

---

## 4. 命令解析流程

### 4.1 从用户输入到命令执行

```
用户输入: "/commit -m 'feat: add auth'"
          │
          ▼
┌──────────────────────────────────────┐
│  parseSlashCommand(input)            │
│  ├── 检测 '/' 前缀                   │
│  ├── 分割: 命令名 + 参数             │
│  └── 返回:                           │
│      {                               │
│        commandName: 'commit',        │
│        args: "-m 'feat: add auth'",  │
│        isMcp: false                  │
│      }                               │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│  findCommand('commit', commands)     │
│  ├── 遍历所有已注册命令              │
│  ├── 匹配 name 或 aliases            │
│  └── 返回: Command 对象              │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│  根据 Command.type 执行              │
│                                      │
│  type: 'prompt'                      │
│  ├── cmd.getPromptForCommand(args)   │
│  ├── 构造 prompt                     │
│  └── 发送给 AI 模型执行              │
│                                      │
│  type: 'local'                       │
│  ├── module = await cmd.load()       │
│  ├── result = await module.call(args)│
│  └── 显示 result                     │
│                                      │
│  type: 'local-jsx'                   │
│  ├── jsx = cmd.call(args, onDone)    │
│  └── 渲染 JSX 组件到终端             │
└──────────────────────────────────────┘
```

### 4.2 parseSlashCommand 实现

```typescript
// src/utils/slashCommandParsing.ts:25-60

export type ParsedSlashCommand = {
  commandName: string   // 如 'search'
  args: string          // 如 'foo bar'
  isMcp: boolean        // MCP 命令标记
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmedInput = input.trim()

  // 必须以 '/' 开头
  if (!trimmedInput.startsWith('/')) return null

  const withoutSlash = trimmedInput.slice(1)
  const words = withoutSlash.split(' ')

  if (!words[0]) return null

  let commandName = words[0]
  let isMcp = false
  let argsStartIndex = 1

  // MCP 命令: '/mcp:tool (MCP) arg1 arg2'
  if (words.length > 1 && words[1] === '(MCP)') {
    commandName = commandName + ' (MCP)'
    isMcp = true
    argsStartIndex = 2
  }

  const args = words.slice(argsStartIndex).join(' ')
  return { commandName, args, isMcp }
}
```

---

## 5. 条件命令与可用性

### 5.1 isEnabled — 条件启用

```typescript
// isEnabled 允许命令在运行时决定是否可用

// 示例：基于 feature flag
const myCommand: Command = {
  name: 'my-feature',
  description: 'Experimental feature',
  isEnabled: () => feature('MY_FEATURE_FLAG'),
  // ...
}

// 示例：基于环境
const debugCommand: Command = {
  name: 'debug',
  description: 'Debug tools',
  isEnabled: () => process.env.NODE_ENV === 'development',
  // ...
}

// isEnabled 的调用时机:
// 1. getCommands() 过滤命令列表时
// 2. 每次调用都重新评估（不缓存）
// 3. 默认为 true（未设置时）
```

### 5.2 availability — 认证要求

```typescript
// src/types/command.ts:169-173
export type CommandAvailability =
  | 'claude-ai'   // Claude.ai OAuth 用户 (Pro/Max/Team/Enterprise)
  | 'console'     // Console API Key 用户 (直接 api.anthropic.com)

// 使用示例:
const upgradeCommand: Command = {
  name: 'upgrade',
  description: 'Upgrade to Max',
  availability: ['claude-ai'],    // 只对 Claude.ai 用户可见
  // ...
}

// 没有 availability 的命令对所有用户可见
const helpCommand: Command = {
  name: 'help',
  description: 'Show help',
  // 无 availability — 所有人可用
}
```

### 5.3 meetsAvailabilityRequirement

```typescript
// src/commands.ts:417-427
function meetsAvailabilityRequirement(cmd: CommandBase): boolean {
  if (!cmd.availability) return true  // 无要求 = 通用

  // 检查用户的认证类型是否在命令的 availability 列表中
  const userAuthType = getCurrentAuthType()
  return cmd.availability.includes(userAuthType)
}
```

### 5.4 isHidden — 隐藏命令

```typescript
// isHidden = true 的命令:
// - 不出现在 /help 列表中
// - 不出现在 typeahead 自动补全中
// - 但仍然可以手动输入执行

const debugCommand: Command = {
  name: 'heapdump',
  description: 'Dump the JS heap to ~/Desktop',
  isHidden: true,    // 开发者工具，不展示给普通用户
  // ...
}
```

---

## 6. 命令完整目录

### 6.1 会话管理

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/clear` | `/reset`, `/new` | local | 清除对话历史，释放上下文 |
| `/compact` | — | prompt | 压缩对话上下文 |
| `/resume` | `/continue` | local-jsx | 恢复之前的会话 |
| `/branch` | `/fork` | local | 创建会话分支 |
| `/rename` | — | local | 重命名当前会话 |
| `/tag` | — | local | 为会话添加可搜索标签 |
| `/export` | — | local-jsx | 导出会话到文件或剪贴板 |
| `/rewind` | `/checkpoint` | local-jsx | 回退到之前的检查点 |
| `/exit` | `/quit` | local | 退出 REPL |

### 6.2 AI 辅助（Prompt 命令）

| 命令 | 类型 | 说明 |
|------|------|------|
| `/commit` | prompt | 创建 git commit（AI 生成 commit message） |
| `/commit-push-pr` | prompt | Commit + push + 开 PR |
| `/review` | prompt | 代码审查 |
| `/security-review` | prompt | 安全审查 |
| `/init` | prompt | 项目初始化 |
| `/copy` | prompt | 复制内容 |
| `/fast` | prompt | 快速模式 |
| `/model` | prompt | 切换模型 |
| `/sandbox` | prompt | 沙箱模式 |

### 6.3 配置与设置

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/config` | `/settings` | local-jsx | 打开配置面板 |
| `/permissions` | `/allowed-tools` | local-jsx | 管理工具权限 |
| `/keybindings` | — | local | 打开快捷键配置 |
| `/memory` | — | local-jsx | 编辑 Claude 记忆文件 |
| `/theme` | — | local-jsx | 切换主题 |
| `/vim` | — | local | 切换 Vim/Normal 编辑模式 |
| `/effort` | — | local-jsx | 设置模型使用力度 |
| `/color` | — | local-jsx | 设置提示栏颜色 |
| `/privacy-settings` | — | local-jsx | 隐私设置 |
| `/output-style` | — | local | 已弃用：使用 /config |

### 6.4 信息与诊断

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/help` | — | local-jsx | 显示帮助和可用命令 |
| `/cost` | — | local | 显示当前会话的总花费和时长 |
| `/context` | — | local-jsx | 可视化上下文使用情况 |
| `/files` | — | local | 列出上下文中的所有文件 |
| `/status` | — | local | 显示 Claude Code 状态 |
| `/stats` | — | local-jsx | 显示使用统计 |
| `/usage` | — | local | 显示计划使用限制 |
| `/doctor` | — | local | 诊断安装和设置 |
| `/diff` | — | local-jsx | 查看未提交的更改和逐轮 diff |
| `/release-notes` | — | local | 查看更新日志 |

### 6.5 连接与集成

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/login` | — | local-jsx | 登录 Anthropic 账号 |
| `/logout` | — | local | 登出 |
| `/mcp` | — | local-jsx | 管理 MCP 服务器 |
| `/ide` | — | local-jsx | 管理 IDE 集成 |
| `/desktop` | `/app` | local-jsx | 在 Claude Desktop 中继续 |
| `/mobile` | `/ios`, `/android` | local | 显示移动应用下载二维码 |
| `/install-github-app` | — | local-jsx | 设置 GitHub Actions |
| `/install-slack-app` | — | local-jsx | 安装 Slack 应用 |
| `/chrome` | — | local-jsx | Chrome 扩展设置 |
| `/session` | `/remote` | local | 显示远程会话 URL |

### 6.6 高级功能

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/plan` | — | local | 启用计划模式 |
| `/tasks` | `/bashes` | local-jsx | 列出和管理后台任务 |
| `/agents` | — | local-jsx | 管理代理配置 |
| `/skills` | — | local | 列出可用技能 |
| `/hooks` | — | local | 查看钩子配置 |
| `/plugin` | `/plugins`, `/marketplace` | local-jsx | 管理插件 |
| `/reload-plugins` | — | local | 刷新插件 |
| `/add-dir` | — | local-jsx | 添加工作目录 |
| `/pr-comments` | — | local | 获取 GitHub PR 评论 |
| `/remote-env` | — | local-jsx | 配置远程环境 |
| `/voice` | — | local | 切换语音模式 |

### 6.7 账号与限制

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/upgrade` | — | local-jsx | 升级到 Max 以获取更高限额 |
| `/extra-usage` | — | local-jsx | 配置额外用量 |
| `/rate-limit-options` | — | local | 限流时显示选项 |
| `/passes` | — | prompt | Guest Pass 管理 |
| `/advisor` | — | local | 配置顾问模型 |

### 6.8 趣味与其他

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/feedback` | `/bug` | local-jsx | 提交反馈 |
| `/stickers` | — | local | 订购 Claude Code 贴纸 |
| `/thinkback` | — | local-jsx | 2025 Claude Code 年度回顾 |
| `/thinkback-play` | — | local | 播放回顾动画 |

### 6.9 内部/隐藏命令

| 命令 | 说明 |
|------|------|
| `/heapdump` | 转储 JS 堆到桌面 |
| `/bridge-kick` | 注入 bridge 故障状态（测试用） |
| `/brief` | 切换简洁模式 |
| `/debug-tool-call` | 调试工具调用 |
| `/mock-limits` | 模拟速率限制 |
| `/reset-limits` | 重置限制 |
| `/version` | 显示版本 |
| `/ant-trace` | Anthropic 追踪 |
| `/backfill-sessions` | 回填会话数据 |
| `/break-cache` | 清除缓存 |

---

## 7. Tab 补全机制

### 7.1 补全流程

```
用户输入 "/he"
    │
    ▼
useTypeahead() Hook
    │
    ├── 1. 检测到 '/' 前缀
    │
    ├── 2. generateCommandSuggestions('/he', commands)
    │      ├── 遍历所有命令
    │      ├── 匹配: name.startsWith('he') || aliases.startsWith('he')
    │      ├── 排除: isHidden === true
    │      └── 返回匹配项: [/help, /heapdump, /hooks]
    │
    ├── 3. 排序
    │      ├── 精确前缀匹配优先
    │      ├── 常用命令权重高
    │      └── 最多显示 5 项 (OVERLAY_MAX_ITEMS)
    │
    └── 4. 渲染补全浮层
           ┌──────────────────────────────┐
           │ /help       Show help        │  ← 选中
           │ /heapdump   Dump JS heap     │
           │ /hooks      View hooks       │
           └──────────────────────────────┘
```

### 7.2 参数补全

```
命令参数补全:
├── argumentHint 字段 — 显示在命令名后的灰色提示文本
│   例如: /commit [-m message]
│
├── 文件路径补全 — @ 触发
│   例如: /read @src/ut → @src/utils.ts
│
└── Shell 补全 — ! 前缀时
    例如: !git che → !git checkout
```

### 7.3 MCP 命令的特殊处理

```
MCP 命令格式:
  /mcp-server:tool-name (MCP) args

补全中的标识:
  ◇ /mcp:search (MCP)   Search using MCP server
                  ^^^^   MCP 标记

解析特殊处理:
  words[1] === '(MCP)' → isMcp = true
  commandName = 'mcp:search (MCP)'
```

---

## 8. 命令 vs 工具：两套执行系统

### 8.1 根本区别

```
命令 (Command):                          工具 (Tool):
├── 用户发起: '/command args'            ├── AI 模型发起: tool_use block
├── 入口: '/' 前缀                       ├── 入口: 系统 prompt 中的工具定义
├── 参数: 字符串 args                    ├── 参数: Zod Schema 验证的结构化输入
├── 补全: typeahead + Tab                ├── 补全: 无（模型自己决定）
├── 权限: 内置在命令实现中               ├── 权限: 显式权限规则系统
├── UI: typeahead, /help                 ├── UI: tool_use 块渲染
├── 执行: 顺序或延迟                     ├── 执行: 可并行
└── 结果: text/JSX/skip                  └── 结果: 结构化 ToolResult
```

### 8.2 SkillTool：连接命令和工具的桥梁

```typescript
// src/tools/SkillTool/SkillTool.ts
// SkillTool 是一个特殊的 Tool，让 AI 模型可以调用 PromptCommand 类型的命令

// 模型视角（在系统 prompt 中）:
{
  name: 'skill',
  description: 'Execute a skill/command',
  input_schema: {
    skill_name: { type: 'string' },
    args: { type: 'string' }
  }
}

// 执行流程:
// 1. 模型决定调用: tool_use { name: 'skill', input: { skill_name: 'commit', args: '' } }
// 2. SkillTool.call() 接收调用
// 3. findCommand('commit', commands) 找到命令
// 4. 如果是 PromptCommand: cmd.getPromptForCommand(args, context)
// 5. 将 prompt 发送给模型执行
// 6. 返回结果
```

### 8.3 执行路径对比

```
用户输入 "/commit -m 'fix bug'":
  PromptInput → parseSlashCommand → findCommand → PromptCommand.getPromptForCommand
  → 构造 prompt → AI 模型生成 commit message → git commit → 显示结果

AI 模型调用 BashTool:
  模型输出 tool_use block → 权限检查 → BashTool.call({ command: 'git status' })
  → child_process.exec → 返回 stdout → 模型处理输出

AI 模型通过 SkillTool 调用 /commit:
  模型输出 tool_use { name: 'skill', input: { skill_name: 'commit' } }
  → SkillTool.call() → findCommand('commit') → PromptCommand.getPromptForCommand
  → 构造 prompt → 发送给模型（自身或子代理）→ 返回结果
```

---

## 9. 懒加载设计

### 9.1 LocalCommand 的懒加载

```typescript
// 命令实现不在注册时加载，而是在执行时按需加载
const clearCommand: Command = {
  name: 'clear',
  type: 'local',
  description: 'Clear conversation history',
  load: () => import('./clear/index.js'),  // ← 动态 import
}

// 好处:
// 1. 启动时不加载 101 个命令的实现
// 2. 只加载用户实际使用的命令
// 3. 减少内存占用
// 4. 加快启动速度
```

### 9.2 技能的懒加载

```typescript
// 技能（skills）从文件系统动态加载
// 目录: ~/.claude/skills/ 和 .claude/skills/

// 扫描目录 → 读取 manifest → 注册为 PromptCommand
// prompt 内容只在执行时读取
```

---

## 10. 设计分析

### 10.1 为什么三种命令类型？

```
设计决策:

PromptCommand — 需要 AI 智能的任务
├── 代码审查需要理解代码
├── Commit message 需要理解变更
└── 不能用简单函数完成

LocalCommand — 纯粹的 CLI 操作
├── /clear, /exit 不需要 AI
├── 执行快速、确定性强
└── 可在 headless 模式下使用

LocalJSXCommand — 需要交互式 UI
├── /config 需要设置面板
├── /mcp 需要服务器管理界面
└── 不是简单的文本输出
```

### 10.2 为什么命令和工具分开？

```
命令:  用户意图的表达 — "我想做 X"
工具:  AI 能力的暴露 — "模型可以做 Y"

分开的理由:
├── 不同的触发方 — 用户 vs 模型
├── 不同的参数模型 — 字符串 vs 结构化
├── 不同的权限模型 — 内置 vs 显式规则
├── 不同的 UX — typeahead vs tool_use 渲染
└── SkillTool 作为桥梁，在需要时连接两者
```

### 10.3 可扩展性

```
添加新命令只需:
1. 创建 src/commands/my-command/index.ts
2. 实现 Command 接口（选择 type）
3. 在 COMMANDS() 中注册

添加新技能只需:
1. 创建 .claude/skills/my-skill.md
2. 定义 prompt 内容
3. 自动被发现和注册

添加 MCP 命令只需:
1. 配置 MCP 服务器
2. 服务器提供 tool 定义
3. 自动注册为命令（带 (MCP) 标记）
```

---

## 11. 关键源码索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/types/command.ts` | 220+ | Command 类型定义 |
| `src/commands.ts` | 754 | 命令注册、查找、过滤 |
| `src/utils/slashCommandParsing.ts` | 60 | 斜杠命令解析 |
| `src/hooks/useTypeahead.tsx` | 200+ | Tab 补全引擎 |
| `src/utils/processUserInput/processSlashCommand.tsx` | — | 命令执行分发 |
| `src/tools/SkillTool/SkillTool.ts` | — | 命令⇄工具桥梁 |
| `src/commands/*/index.ts` | 各异 | 各命令实现 |

> **一句话总结**：Claude Code 的命令系统通过三种类型（Prompt/Local/LocalJSX）、
> 条件启用（isEnabled + availability）、懒加载（动态 import）、Tab 补全、
> 以及 SkillTool 桥梁，实现了一个支持 ~101 个命令的可扩展架构——
> 从简单的 /exit 到复杂的 AI 驱动 /commit，统一在同一个框架下。
