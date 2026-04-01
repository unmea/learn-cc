# Q: 什么是"技能"？与工具有什么区别？

## 一句话回答

Skills 是由 Markdown 文件定义的高层级可复用行为模式，通过 SkillTool 集成到工具系统中；与 Tools 的核心区别在于 Skills 是"指导模型怎么做"的提示文本，而 Tools 是"模型能做什么"的执行函数。

---

## 1. Skills vs Tools 核心对比

### 1.1 本质差异

| 维度 | **Skills (技能)** | **Tools (工具)** |
|------|-------------------|------------------|
| **定义方式** | Markdown + YAML 前置信息 | TypeScript 类/函数 |
| **文件位置** | `.claude/skills/SKILL.md` | `src/tools/ToolName/` |
| **调用方式** | 通过 SkillTool 或 `/skill-name` | 模型/用户直接调用 |
| **内容本质** | Prompt 文本（指导性指令） | 执行函数（实际动作） |
| **目的** | 引导模型行为和决策 | 与外部系统交互 |
| **作用域** | 工作流、决策逻辑 | 系统能力（文件、网络、进程） |
| **典型示例** | `/commit`, `/review-pr`, `/pdf` | BashTool, FileReadTool, WebSearchTool |
| **注册方式** | 从磁盘自动发现 | 代码中程序化注册 |

### 1.2 协作关系

```
用户请求: "帮我提交代码"
         │
         ▼
    模型选择 SkillTool("commit")    ← Skill: 告诉模型"怎么提交"
         │
         ▼
    展开 Skill Prompt:
    "1. 运行 git diff 查看变更
     2. 编写有意义的提交信息
     3. 使用 conventional commits 格式"
         │
         ▼
    模型根据 Prompt 调用:
    ├── BashTool("git diff")        ← Tool: 实际执行命令
    ├── BashTool("git add .")       ← Tool: 实际执行命令
    └── BashTool("git commit ...")  ← Tool: 实际执行命令
```

Skills 提供**决策智慧**，Tools 提供**执行能力**。

---

## 2. Skill 定义格式

### 2.1 YAML 前置信息规范

> 源码: `src/skills/loadSkillsDir.ts`

Skills 是带有 YAML 前置信息的 Markdown 文件：

```yaml
---
name: skill-name                    # 显示名称（可选）
description: |                      # 必须: 一行描述
  Detailed description...
when_to_use: |                      # 发现辅助: 何时使用
  Specific scenarios...
allowed-tools:                      # 此技能可使用的工具白名单
  - bash
  - file-read
  - file-write
argument-hint: "arg description"    # 参数提示
arguments: [arg1, arg2]             # 参数名列表
disable-model-invocation: false     # 阻止模型自动调用
user-invocable: true                # false 则对用户隐藏
model: claude-opus                  # 覆盖默认模型
context: fork                       # 'inline' (默认) 或 'fork'
agent: Bash                         # fork 时的子 Agent 类型
effort: high                        # 复杂度级别
version: "1.0"                      # 技能版本
paths:                              # 文件可见性 glob 模式
  - src/**
hooks:                              # 调用时注册的钩子
  postUserMessage: hook-name
---

# 技能的实际 Prompt 内容

这里是技能的指令文本...
```

### 2.2 文件结构

**推荐格式 (`.claude/skills/`)**:
```
.claude/skills/
├── commit/
│   └── SKILL.md
├── review-pr/
│   └── SKILL.md
└── deploy/
    └── SKILL.md
```

**兼容格式 (`.claude/commands/`)**:
```
.claude/commands/
├── commit/
│   └── skill.md          # 大小写不敏感
```

---

## 3. Skill 发现机制

### 3.1 发现位置（优先级顺序）

> 源码: `src/skills/loadSkillsDir.ts:1-150`

```
① 内置技能 (Bundled Skills) — 编译到 CLI 中
② 策略设置 (Policy) — 管理员管控
③ 用户设置 (User) — 全局 ~/.claude/skills/
④ 项目设置 (Project) — 仓库 .claude/skills/
⑤ 插件技能 (Plugin) — 已安装插件提供
⑥ MCP 技能 — MCP 服务器提供
```

### 3.2 加载流程

> 源码: `src/commands.ts:353-398`

```typescript
async function getSkills(cwd) {
  // 并行加载磁盘技能和插件技能
  const [skillDirCommands, pluginSkills] = await Promise.all([
    getSkillDirCommands(cwd),     // 从 /skills/ 目录
    getPluginSkills()              // 从插件
  ])
  // 同步获取内置技能
  const bundledSkills = getBundledSkills()
  return { skillDirCommands, pluginSkills, bundledSkills }
}
```

### 3.3 去重策略

> 源码: `src/skills/loadSkillsDir.ts:107-124`

```typescript
// 通过 realpath() 获取文件的唯一标识，检测符号链接
async function getFileIdentity(filePath: string): Promise<string | null> {
  // 解析符号链接到规范路径
  // 如果文件不存在返回 null
  // 防止跨重叠路径的重复
}
```

当多个发现路径指向同一个物理文件时（如通过符号链接），去重机制确保技能只被加载一次。

---

## 4. SkillTool — 技能的工具化封装

### 4.1 工具定义

> 源码: `src/tools/SkillTool/SkillTool.ts:331-352`

```typescript
export const SkillTool: Tool = buildTool({
  name: 'Skill',
  searchHint: 'invoke a slash-command skill',
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  description: async ({ skill }) => `Execute skill: ${skill}`,
  prompt: async () => getPrompt(getProjectRoot()),
  validateInput,
  checkPermissions,
  call,
})
```

### 4.2 输入/输出模式

> 源码: `src/tools/SkillTool/SkillTool.ts:291-326`

```typescript
// 输入
const inputSchema = z.object({
  skill: z.string()
    .describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
  args: z.string().optional()
    .describe('Optional arguments for the skill'),
})

// 内联输出
const inlineOutputSchema = z.object({
  success: z.boolean(),
  commandName: z.string(),
  allowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  status: z.literal('inline'),
})

// Fork 输出
const forkedOutputSchema = z.object({
  success: z.boolean(),
  commandName: z.string(),
  status: z.literal('forked'),
  agentId: z.string(),
  result: z.string(),
})
```

### 4.3 验证流程

> 源码: `src/tools/SkillTool/SkillTool.ts:354-430`

```typescript
async validateInput({ skill }, context) {
  // ① 清理技能名（trim、去掉前导斜杠）
  // ② 获取所有命令
  // ③ 查找命令: findCommand()
  // ④ 检查 disableModelInvocation 是否为 false
  // ⑤ 检查 type === 'prompt'
  // → 返回 { result: true/false, errorCode, message }
}

async checkPermissions({ skill, args }, context) {
  // ① 检查 deny 规则
  // ② 检查 allow 规则（前缀匹配）
  // ③ 远程规范技能（仅限 ant）
  // ④ 插件特定权限
  // → 返回 { behavior: 'allow'|'deny', message }
}
```

---

## 5. 两种执行模式

### 5.1 内联执行 (Inline, 默认)

```
Skill Prompt → 展开到当前对话 → 模型直接处理

用户: /commit
       │
       ▼
SkillTool.call()
       │
       ▼
getPromptForCommand(args, context)
       │
       ├── 加载 Markdown 内容
       ├── 替换参数: ${arg_name} → 实际值
       ├── 替换变量:
       │   ├── ${CLAUDE_SKILL_DIR} → 技能根目录
       │   └── ${CLAUDE_SESSION_ID} → 会话 ID
       ├── 执行内联 Shell: !`command` → 输出替换
       └── 如果有文件: 前置基础目录提示
       │
       ▼
[{ type: 'text', text: '展开后的完整 Prompt' }]
       │
       ▼
注入到当前对话 → 模型继续处理
```

### 5.2 Fork 执行 (context: 'fork')

> 源码: `src/tools/SkillTool/SkillTool.ts:122-289`

```
Skill Prompt → 创建子 Agent → 独立执行 → 返回结果

用户: /complex-task
       │
       ▼
SkillTool.call()
       │
       ▼
executeForkedSkill()
       │
       ├── createAgentId()              // 创建子 Agent 标识
       ├── prepareForkedCommandContext() // 准备 Fork 上下文
       ├── runAgent()                   // 子 Agent 独立运行
       ├── 收集子 Agent 消息
       ├── extractResultText()          // 提取结果文本
       └── 记录遥测事件
       │
       ▼
{ success, commandName, status: 'forked', agentId, result }
       │
       ▼
父 Agent 继续处理结果文本
```

### 5.3 内联 vs Fork 的选择

| 维度 | 内联 (inline) | Fork |
|------|---------------|------|
| **上下文** | 共享父对话上下文 | 独立上下文窗口 |
| **Token 消耗** | 占用父对话的 Token | 独立 Token 预算 |
| **适用场景** | 简单指令、快速操作 | 复杂多步任务 |
| **结果可见性** | 模型看到全部工具调用 | 模型只看到结果摘要 |
| **配置方式** | `context: inline` (默认) | `context: fork` |

---

## 6. Prompt 展开细节

### 6.1 参数替换

> 源码: `src/skills/loadSkillsDir.ts:344-399`

```markdown
# SKILL.md 内容
---
arguments: [file, message]
---

Review ${file} and write: ${message}
```

调用 `/review src/main.ts "检查类型安全"` 后展开为：
```
Review src/main.ts and write: 检查类型安全
```

### 6.2 内联 Shell 命令

```markdown
# 在 Skill Markdown 中:
当前分支: !`git branch --show-current`
最近提交: !`git log --oneline -5`
```

- 模式: `!`command`` 或 ````! command ````
- 在展开时执行，替换为命令输出
- **MCP 技能不执行**内联 Shell（安全考虑）

### 6.3 变量替换

| 变量 | 值 | 用途 |
|------|-----|------|
| `${CLAUDE_SKILL_DIR}` | 技能根目录路径 | 引用技能自带的资源文件 |
| `${CLAUDE_SESSION_ID}` | 当前会话 ID | 用于状态追踪 |

---

## 7. 内置技能系统 (Bundled Skills)

### 7.1 注册机制

> 源码: `src/skills/bundledSkills.ts:15-41`

```typescript
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean          // 特性标志检查
  hooks?: HooksSettings
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string>     // 内嵌文件
  getPromptForCommand(
    args: string,
    context: ToolUseContext
  ): Promise<ContentBlockParam[]>
}
```

### 7.2 内置技能列表

> 源码: `src/skills/bundled/index.ts:1-80`

```typescript
export function initBundledSkills(): void {
  registerUpdateConfigSkill()     // 更新配置
  registerKeybindingsSkill()      // 快捷键管理
  registerVerifySkill()           // 验证检查
  registerDebugSkill()            // 调试辅助
  registerLoremIpsumSkill()       // 占位文本
  registerSkillifySkill()         // 将会话捕获为技能
  registerRememberSkill()         // 保存到记忆
  registerSimplifySkill()         // 简化代码
  registerBatchSkill()            // 批量操作
  registerStuckSkill()            // 解除卡顿

  // 特性门控:
  if (feature('KAIROS')) registerDreamSkill()
  if (feature('REVIEW_ARTIFACT')) registerHunterSkill()
  if (feature('AGENT_TRIGGERS')) registerLoopSkill()
  // ... 更多
}
```

### 7.3 内嵌文件机制

> 源码: `src/skills/bundledSkills.ts:59-72`

内置技能可以携带资源文件：

```typescript
registerBundledSkill({
  name: 'my-skill',
  files: {
    'scripts/helper.sh': '#!/bin/bash\necho hello',
    'docs/README.md': '# Documentation'
  },
  // ...
})
```

行为:
1. 首次调用时解压文件到 `getBundledSkillsRoot()/skillName`
2. 写入权限: `0o700`（仅所有者）
3. 基础目录提示前置到 Prompt
4. 模型可通过 Read/Grep 工具访问这些文件
5. 解压失败不阻塞技能执行

---

## 8. 命令查找与聚合

### 8.1 完整注册流程

> 源码: `src/commands.ts:258-517`

```
阶段 1: 启动
  initBundledSkills()
  → 每个技能调用 registerBundledSkill()
  → 加入 bundledSkills 注册表

阶段 2: 按需加载 (按 cwd 记忆化)
  getCommands(cwd)
    → loadAllCommands(cwd)
      → getSkills(cwd)
        → getSkillDirCommands(cwd)    // /skills/ 目录
        → getPluginSkills()           // 插件
        → getBundledSkills()          // 内置注册表
      → getPluginCommands()           // 插件命令
      → getWorkflowCommands()         // 工作流
    → 按可用性和 isEnabled() 过滤
    → 合并所有来源
    → 返回 Command[]

阶段 3: SkillTool 特定过滤
  getSkillToolCommands(cwd)
    → 过滤: type='prompt' AND !disableModelInvocation
    → 过滤: source != 'builtin'
    → 过滤: 有 description 或 whenToUse
    → 返回供 SkillTool 提示使用
```

### 8.2 命令查找

> 源码: `src/commands.ts:688-719`

```typescript
export function findCommand(
  commandName: string,
  commands: Command[]
): Command | undefined {
  return commands.find(_ =>
    _.name === commandName ||              // 精确名称
    getCommandName(_) === commandName ||   // 显示名称
    _.aliases?.includes(commandName)       // 别名
  )
}
```

匹配规则:
- 前导斜杠被移除: `/skill` → `skill`
- 大小写敏感
- 支持别名匹配

---

## 9. MCP 技能集成

### 9.1 如何工作

> 源码: `src/tools/SkillTool/SkillTool.ts:81-94`

```typescript
getAllCommands(context): Command[] {
  const mcpSkills = context.getAppState().mcp.commands
    .filter(cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp')

  return [...localCommands, ...mcpSkills]
}
```

MCP 技能特点:
- 从 AppState 加载（MCP 服务器连接）
- 无需预先发现
- 与本地技能相同的接口
- **不执行**内联 Shell 命令（安全限制）

---

## 10. 缓存失效

### 10.1 失效策略

> 源码: `src/commands.ts:519-539`

```typescript
clearCommandMemoizationCaches()
  - loadAllCommands.cache.clear()
  - getSkillToolCommands.cache.clear()
  - getSlashCommandToolSkills.cache.clear()
  - clearSkillIndexCache()

clearCommandsCache()
  - clearCommandMemoizationCaches()
  - clearPluginCommandCache()
  - clearPluginSkillsCache()
  - clearSkillCaches()
```

触发时机:
- 磁盘上的技能文件被修改
- 插件安装/卸载
- 认证状态变更
- 动态技能被发现

---

## 12. 高级特性

### 12.1 路径约束

```yaml
---
paths:
  - src/**
  - tests/**
---
```

技能仅在模型触及匹配文件后可见，实现上下文感知的技能发现。

### 12.2 动态技能发现

> 源码: `src/commands.ts:479-516`

文件操作过程中自动发现新技能，与基础命令去重后插入注册表，变更时清除缓存。

---

## 13. 设计分析

### 13.1 为什么分离 Skills 和 Tools？

**关注点分离**: Tools 关注"能做什么"（能力），Skills 关注"应该怎么做"（智慧）。类比：Tools 是工人的工具箱，Skills 是施工方案。

### 13.2 为什么用 Markdown 而非代码？

1. **低门槛**: 任何人都能编写技能，不需要编程
2. **可读性**: Markdown 天然适合表达指令
3. **版本控制**: 可以和项目代码一起 Git 管理
4. **安全性**: Prompt 文本比可执行代码更安全

### 13.3 内联 vs Fork 的权衡

| 考量 | 内联 | Fork |
|------|------|------|
| **上下文利用** | ✅ 共享完整对话历史 | ❌ 需要重新建立上下文 |
| **Token 效率** | ❌ 消耗父对话预算 | ✅ 独立预算 |
| **复杂任务** | ❌ 对话过长降低质量 | ✅ 专注的子对话 |
| **结果可见** | ✅ 所有中间步骤可见 | ❌ 只有最终结果 |
| **并行性** | ❌ 串行执行 | ✅ 可与其他工具并行 |
