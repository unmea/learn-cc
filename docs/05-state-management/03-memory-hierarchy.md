# 如何让 Agent 拥有跨会话记忆？

> **核心问题**：AI Agent 的对话天然是"无状态"的——每次新会话都从零开始。如何让 Agent 记住用户的偏好、项目约定、甚至上次对话的关键信息？Claude Code 设计了一个三层记忆体系来解决这个问题。
>

---

## 1. 三层记忆架构

```
┌───────────────────────────────────────────────────────────┐
│ 第 1 层：CLAUDE.md 持久记忆                               │
│                                                            │
│  存储位置：文件系统（Git 仓库 / home 目录）                │
│  生命周期：永久（除非用户手动删除）                         │
│  写入者：用户手动编辑                                      │
│  4 个子层：Managed → User → Project → Local                │
├───────────────────────────────────────────────────────────┤
│ 第 2 层：Session Memory 会话记忆                           │
│                                                            │
│  存储位置：sessionMemory.md                                │
│  生命周期：当前会话（可跨 compaction 存活）                │
│  写入者：后台 AI agent 自动提取                            │
│  Feature-gated：tengu_session_memory                       │
├───────────────────────────────────────────────────────────┤
│ 第 3 层：AutoMem / TeamMem 运行时记忆                     │
│                                                            │
│  AutoMem: ~/.claude/projects/<git-root>/memory/MEMORY.md   │
│  TeamMem: 团队共享动态同步                                 │
│  生命周期：跨会话持久（AI 自动生成）                       │
│  限制：200 行 / 25KB                                       │
└───────────────────────────────────────────────────────────┘
```

---

## 2. 第 1 层：CLAUDE.md 持久记忆

### 2.1 文件层级（优先级从低到高）

```typescript
// src/utils/claudemd.ts:L2-10

// 1. Managed（企业管控）
/etc/claude-code/CLAUDE.md

// 2. User（用户全局）
~/.claude/CLAUDE.md
~/.claude/rules/*.md

// 3. Project（项目共享，提交到 Git）
CLAUDE.md
.claude/CLAUDE.md
.claude/rules/*.md

// 4. Local（个人项目私有，不提交）
CLAUDE.local.md
```

**关键设计**：文件**越靠近 CWD 优先级越高**（加载越晚）。这利用了 LLM 的**近因偏差**——context 末尾的内容得到更多关注。

### 2.2 发现算法

```typescript
// src/utils/claudemd.ts:L790-1075 (getMemoryFiles)

async function getMemoryFiles(): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []
  const processedPaths = new Set<string>()
  
  // === 阶段 1：Managed（固定路径）===
  result.push(...await processMemoryFile(
    '/etc/claude-code/CLAUDE.md', 'Managed', processedPaths
  ))

  // === 阶段 2：User（固定路径）===
  result.push(...await processMemoryFile(
    join(homeDir, '.claude', 'CLAUDE.md'), 'User', processedPaths
  ))
  result.push(...await processMdRules({
    rulesDir: join(homeDir, '.claude', 'rules'), type: 'User', processedPaths
  }))

  // === 阶段 3 & 4：Project + Local（目录遍历）===
  
  // 从 CWD 向上遍历到根目录
  const dirs: string[] = []
  let currentDir = originalCwd
  while (currentDir !== parse(currentDir).root) {
    dirs.push(currentDir)
    currentDir = dirname(currentDir)
  }
  
  // 反转：从根目录向下处理（低优先级 → 高优先级）
  for (const dir of dirs.reverse()) {
    // Project 文件（提交到 Git）
    result.push(...await processMemoryFile(
      join(dir, 'CLAUDE.md'), 'Project', processedPaths
    ))
    result.push(...await processMemoryFile(
      join(dir, '.claude', 'CLAUDE.md'), 'Project', processedPaths
    ))
    result.push(...await processMdRules({
      rulesDir: join(dir, '.claude', 'rules'), type: 'Project', processedPaths
    }))
    
    // Local 文件（不提交）
    result.push(...await processMemoryFile(
      join(dir, 'CLAUDE.local.md'), 'Local', processedPaths
    ))
  }
  
  // === 阶段 5：AutoMem ===
  result.push(...await getAutoMemEntrypoint())
  
  // === 阶段 6：TeamMem（Feature-gated）===
  if (feature('TEAMMEM')) {
    result.push(...await teamMemPaths.getTeamMemEntrypoint())
  }
  
  return result
}
```

### 2.3 目录遍历示例

假设 CWD 是 `/home/user/projects/myapp/src/components`：

```
遍历顺序（构建 dirs 数组，CWD → 根）：
  /home/user/projects/myapp/src/components
  /home/user/projects/myapp/src
  /home/user/projects/myapp
  /home/user/projects
  /home/user
  /home

反转后处理顺序（根 → CWD）：
  /home            ← 最低优先级
  /home/user
  /home/user/projects
  /home/user/projects/myapp
  /home/user/projects/myapp/src
  /home/user/projects/myapp/src/components  ← 最高优先级
```

在 `/home/user/projects/myapp` 找到 `CLAUDE.md` 和 `.claude/rules/coding-style.md`，在 `/home/user/projects/myapp/src/components` 找到 `CLAUDE.local.md`。后者优先级更高。

---

## 3. @import 指令（@include）

### 3.1 语法

```markdown
# CLAUDE.md

项目约定如下：

@./docs/coding-style.md
@./docs/api-conventions.md
@~/global-rules/security.md
@/absolute/path/to/rules.md
@./README.md#installation
```

### 3.2 路径解析

```typescript
// src/utils/claudemd.ts:L459-489

// 正则匹配 @path 模式
const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g

// 支持的路径格式：
// @path           → 相对路径（等同于 @./path）
// @./relative     → 相对于当前 CLAUDE.md 所在目录
// @~/home/path    → 用户 home 目录
// @/absolute/path → 绝对路径
// @path#heading   → 带 fragment 标识符（fragment 被忽略）
```

### 3.3 递归处理与安全

```typescript
// src/utils/claudemd.ts:L537, L618-685

const MAX_INCLUDE_DEPTH = 5  // 防止循环引用

async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,  // 已处理路径集合
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  // 深度检查
  if (depth >= MAX_INCLUDE_DEPTH) return []
  
  // 循环检查（路径规范化后比较）
  if (processedPaths.has(normalizePathForComparison(filePath))) return []
  
  processedPaths.add(normalizePathForComparison(filePath))
  
  // 读取文件内容
  const rawContent = await readFile(filePath, 'utf-8')
  
  // 提取 @include 路径
  const includePaths = extractIncludePathsFromTokens(
    marked.lexer(rawContent), dirname(filePath)
  )
  
  const result: MemoryFileInfo[] = []
  
  // 递归处理 includes（include 的文件在主文件之前）
  for (const includePath of includePaths) {
    result.push(...await processMemoryFile(
      includePath, type, processedPaths, includeExternal,
      depth + 1, filePath  // 追踪父文件
    ))
  }
  
  // 主文件在 includes 之后
  result.push(memoryFile)
  
  return result
}
```

**关键设计**：被 include 的文件排在 include 它的文件**之前**。这确保了引用的上下文先于使用它的指令出现。

### 3.4 文件类型白名单

```typescript
// src/utils/claudemd.ts:L96-227

// 只允许文本文件类型
const TEXT_FILE_EXTENSIONS = [
  '.md', '.txt', '.js', '.ts', '.py', '.json', '.yaml', '.yml',
  '.toml', '.cfg', '.ini', '.sh', '.bash', '.zsh',
  // ... 更多文本格式
]

// 阻止二进制文件
// .pdf, .jpg, .png, .zip, .exe 等 → 被忽略
```

### 3.5 HTML 注释中的 @path 被忽略

```typescript
// extractIncludePathsFromTokens 使用 marked 的 lexer
// → HTML 注释内的 @paths 不会被处理

// ✅ 生效
@./active-rule.md

// ❌ 被忽略
<!-- @./disabled-rule.md -->
```

---

## 4. .claude/rules/ 与 Frontmatter 条件规则

### 4.1 基本结构

```
.claude/rules/
├── coding-style.md       # 无条件生效
├── react-rules.md        # 只对特定文件生效
└── security.md            # 无条件生效
```

### 4.2 Frontmatter 路径过滤

```typescript
// src/utils/claudemd.ts:L254-279

function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  
  if (!frontmatter.paths) return { content }  // 无条件生效
  
  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(p => p.endsWith('/**') ? p.slice(0, -3) : p)
    .filter(p => p.length > 0)
  
  return { content, paths: patterns }
}
```

**示例**：

```markdown
---
paths:
  - src/components/**/*.tsx
  - src/hooks/*.ts
---

# React 组件规范

- 使用函数式组件
- Props 类型用 interface 定义
- 避免使用 class 组件
```

这条规则只在编辑匹配路径的文件时注入到 context 中。

---

## 5. 内容注入到 System Prompt

### 5.1 注入管道

```
会话启动
    ↓
getUserContext() [memoized]  ← src/context.ts:L155
    ↓
getMemoryFiles() [memoized]  ← 异步 I/O：目录遍历、文件读取
    ↓
filterInjectedMemoryFiles()  ← 根据 feature flag 过滤 AutoMem/TeamMem
    ↓
getClaudeMds(memoryFiles)    ← 格式化 + 前缀
    ↓
System Prompt { claudeMd: string }
    ↓
API Request（含 prompt cache）
```

### 5.2 格式化函数

```typescript
// src/utils/claudemd.ts:L1153-1195

export const getClaudeMds = (memoryFiles: MemoryFileInfo[]): string => {
  const memories: string[] = []
  
  for (const file of memoryFiles) {
    if (file.content) {
      // 根据类型添加描述
      const description = file.type === 'Project'
        ? ' (project instructions, checked into the codebase)'
        : file.type === 'Local'
          ? " (user's private project instructions, not checked in)"
          : " (user's auto-memory, persists across conversations)"
      
      memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
    }
  }
  
  if (memories.length === 0) return ''
  
  // 注入指令前缀
  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}
```

### 5.3 指令前缀

```typescript
// src/utils/claudemd.ts:L89-90

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. ' +
  'Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior ' +
  'and you MUST follow them exactly as written.'
```

### 5.4 字符限制

```typescript
// src/utils/claudemd.ts:L92
export const MAX_MEMORY_CHARACTER_COUNT = 40000  // 推荐最大字符数

// 超过限制 → 发出警告，但仍然注入
// 用户需要自行精简 CLAUDE.md 内容
```

---

## 6. 第 2 层：Session Memory

### 6.1 自动记忆提取

```typescript
// src/services/SessionMemory/

// Session Memory 通过后台 AI agent 自动提取
// Feature-gated: tengu_session_memory

// 工作流程：
// 1. 对话进行中（每 N 步 或 N 分钟）
// 2. 后台 agent 分析当前对话
// 3. 提取关键记忆（用户偏好、项目决策、上下文）
// 4. 写入 sessionMemory.md
// 5. 下次 compaction 后重新注入
```

### 6.2 获取会话记忆

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts

function getSessionMemoryContent(): string | null {
  // 返回当前会话的自动提取记忆
  // 用于 compaction 后恢复上下文
}
```

### 6.3 Compaction 存活机制

```typescript
// src/services/compact/sessionMemoryCompact.ts

function shouldUseSessionMemoryCompaction(): boolean {
  // 两个 feature flag 都需要开启：
  // 1. tengu_session_memory
  // 2. tengu_session_memory_compaction
  return sessionMemoryFlag && smCompactFlag
}

// 阈值：
// 最少保留 10K tokens
// 最多保留 40K tokens
```

---

## 7. 第 3 层：AutoMem

### 7.1 存储位置

```typescript
// src/memdir/paths.ts:L223-235

const getAutoMemPath = memoize((): string => {
  // 优先级：
  // 1. 环境变量 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  // 2. settings.json 中的 autoMemoryDirectory
  // 3. 默认：~/.claude/projects/{sanitized-git-root}/memory/
  
  const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
  if (override) return override
  
  return join(
    getMemoryBaseDir(), 'projects',
    sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME
  ) + sep
})
```

### 7.2 MEMORY.md 入口点

```typescript
// src/memdir/memdir.ts

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200   // 最多 200 行
export const MAX_ENTRYPOINT_BYTES = 25_000 // 最多 25KB
```

### 7.3 截断逻辑

```typescript
// src/memdir/memdir.ts:L48-80

function truncateEntrypointContent(content: string): string {
  // 1. 先按行截断（200 行）
  const lines = content.split('\n')
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    content = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    reason = 'too many lines'
  }
  
  // 2. 再按字节截断（25KB）
  if (Buffer.byteLength(content) > MAX_ENTRYPOINT_BYTES) {
    // 在最后一个换行符处截断
    content = content.slice(0, lastNewlineBeforeLimit)
    reason = 'too large'
  }
  
  // 3. 追加警告
  if (reason) {
    content += `\n\n> WARNING: MEMORY.md is ${reason}. Only part was loaded.`
  }
  
  return content
}
```

### 7.4 记忆类型

```typescript
// src/memdir/memoryTypes.ts:L14-31

const MEMORY_TYPES = [
  'user',      // 用户反馈 & 偏好（私有）
  'feedback',  // 方法指导（私有或团队）
  'project',   // 进行中的工作/目标（私有或团队）
  'reference', // 外部系统指针（团队共享）
] as const
```

---

## 8. 内容处理管道

### 8.1 从磁盘到 System Prompt 的完整流程

```
CLAUDE.md 文件（磁盘）
    ↓
processMemoryFile()  [claudemd.ts:L618]
    ├─ 读取文件内容
    ├─ 剥离 YAML Frontmatter
    ├─ 剥离 HTML 注释 (<!-- ... -->)
    ├─ 提取 @include 路径 → 递归处理
    ├─ MEMORY.md → 截断（200 行 / 25KB）
    └─ 设置 contentDiffersFromDisk 标志
    ↓
MemoryFileInfo[]
    ↓
getClaudeMds()  [claudemd.ts:L1153]
    ├─ 添加文件路径和类型描述
    ├─ 合并所有文件内容
    └─ 添加指令前缀
    ↓
claudeMd: string
    ↓
getUserContext()  [context.ts:L170]
    ↓
System Prompt（包含 claudeMd 字段）
    ↓
API 请求（prompt cache 缓存 claudeMd 部分）
```

### 8.2 Frontmatter 剥离

```typescript
// processMemoryFile 内部

// 输入：
// ---
// paths:
//   - src/**/*.ts
// ---
// # 编码规范
// 使用 TypeScript strict mode

// 输出（content 字段）：
// # 编码规范
// 使用 TypeScript strict mode

// paths 字段保留在 MemoryFileInfo.paths 中
```

### 8.3 HTML 注释剥离

```typescript
// 使用 marked lexer 解析 Markdown
// HTML 类型的 token 被跳过

// 输入：
// # 规范
// <!-- 这是注释，不会注入到 prompt -->
// 使用 ESLint

// 输出：
// # 规范
// 使用 ESLint
```

---

## 9. 记忆如何存活 Compaction

### 9.1 三层存活机制

#### CLAUDE.md（始终存活）

```typescript
// src/utils/claudemd.ts:L1124-1129

// CLAUDE.md 是静态文件，不受 compaction 影响
// Compaction 后重新加载：

export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}

// 调用方：
// - src/services/compact/postCompactCleanup.ts:L31-77
// - compaction 完成后 → 清除缓存 → 下次使用时从磁盘重新加载
```

#### Session Memory（通过 Compaction 附件存活）

```
Compaction 前：
  对话消息 + Session Memory → 发送给 compactor

Compaction 中：
  compactor 生成摘要 → 包含 Session Memory 要点

Compaction 后：
  摘要消息 + 重新加载的 CLAUDE.md + 重新提取的 Session Memory
```

#### AutoMem/TeamMem（通过文件系统存活）

```
AutoMem: MEMORY.md 存在磁盘上，不受 compaction 影响
TeamMem: 通过 teamMemorySync.watcher.ts 持续同步

Compaction 后：
  resetGetMemoryFilesCache('compact') → 重新加载 MEMORY.md
```

### 9.2 Post-Compaction 清理

```typescript
// src/services/compact/postCompactCleanup.ts:L31-77

function runPostCompactCleanup(querySource?: QuerySource): void {
  const isMainThreadCompact = 
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'
  
  if (isMainThreadCompact) {
    // 清除两层缓存：
    // 1. getUserContext（外层）→ 持有格式化后的 claudeMd
    getUserContext.cache.clear?.()
    
    // 2. getMemoryFiles（内层）→ 持有原始文件数组
    resetGetMemoryFilesCache('compact')
    // reason 设为 'compact' → InstructionsLoaded hooks 感知 compaction
  }
  
  clearSystemPromptSections()
}
```

---

## 10. 缓存策略

### 10.1 两层 Memoization

```typescript
// 外层：getUserContext()
//   缓存整个会话的 system prompt context
//   只在 compaction 或显式 cache reset 时清除

// 内层：getMemoryFiles()
//   缓存文件读取结果
//   在设置变化或 compaction 时清除
```

### 10.2 缓存失效时机

| 事件 | getUserContext | getMemoryFiles |
|------|---------------|----------------|
| Compaction | ✅ 清除 | ✅ 清除 |
| 设置变化 | ❌ 不清除 | ✅ 清除 |
| 会话开始 | 首次调用时填充 | 首次调用时填充 |
| 文件修改 | ❌ 不自动检测 | ❌ 不自动检测 |

**注意**：CLAUDE.md 文件修改**不会自动检测**。用户需要重启会话或触发 compaction 才能看到新内容。

---

## 11. 过滤与 Feature Flag

```typescript
// src/utils/claudemd.ts:L1142-1151

export function filterInjectedMemoryFiles(
  files: MemoryFileInfo[],
): MemoryFileInfo[] {
  // Feature flag: tengu_moth_copse
  // 开启时：AutoMem 和 TeamMem 通过附件方式注入（而非 system prompt）
  
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse', false
  )
  
  if (!skipMemoryIndex) return files  // 全部注入 system prompt
  
  // 过滤掉 AutoMem 和 TeamMem（它们会作为附件注入）
  return files.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
}
```

---

## 12. 设计分析

### 12.1 为什么是文件而不是数据库？

CLAUDE.md 用文件存储记忆的好处：

1. **Git 友好**：`CLAUDE.md` 和 `.claude/rules/*.md` 可以提交到 Git，团队共享
2. **人类可编辑**：用任何文本编辑器打开即可修改
3. **可审查**：Code Review 中可以看到记忆的变化
4. **版本化**：Git 历史追踪记忆的演进
5. **无依赖**：不需要数据库、不需要额外工具

### 12.2 三层记忆的设计意图

| 层级 | 谁写 | 谁读 | 目的 |
|------|------|------|------|
| CLAUDE.md | 人类 | AI | 明确的指令和约定 |
| Session Memory | AI（后台） | AI（compaction 后） | 保持对话连续性 |
| AutoMem | AI（运行时） | AI（跨会话） | 学习和记忆偏好 |

### 12.3 近因偏差的利用

LLM 对 context 末尾的内容更敏感。Claude Code 利用这一点：
- 远离 CWD 的 CLAUDE.md → context 前部（低优先级）
- 靠近 CWD 的 CLAUDE.md → context 后部（高优先级）
- Local 文件 → 最后加载（最高优先级）

### 12.4 安全考量

**@include 的安全性**：
- 最大深度 5 级，防止无限递归
- 路径去重（processedPaths Set），防止循环引用
- 文件类型白名单，防止二进制文件注入
- HTML 注释中的 @path 被忽略

**Project CLAUDE.md 的信任问题**：
- Project 文件来自 Git 仓库，可能包含恶意指令
- Claude Code 在注入时标注来源：`(project instructions, checked into the codebase)`
- 允许用户通过 Local 文件覆盖 Project 指令

---

## 13. 完整记忆发现示例

假设项目结构：

```
~/projects/myapp/
├── CLAUDE.md              # "使用 TypeScript, 遵循 ESLint"
├── .claude/
│   ├── CLAUDE.md          # "API 使用 REST 风格"
│   └── rules/
│       ├── style.md       # "缩进用 2 空格"
│       └── react.md       # (paths: src/components/**) "使用函数式组件"
├── CLAUDE.local.md        # "我的 API key: 不要暴露在代码中"
├── src/
│   └── components/
│       └── Button.tsx

~/.claude/
├── CLAUDE.md              # "我偏好简洁的代码风格"
└── rules/
    └── global.md          # "总是添加类型注解"

~/.claude/projects/myapp-abc123/memory/
└── MEMORY.md              # "用户上次在实现登录功能，偏好 JWT"
```

**加载顺序**（低 → 高优先级）：

```
1. ~/.claude/CLAUDE.md           (User)     "我偏好简洁的代码风格"
2. ~/.claude/rules/global.md     (User)     "总是添加类型注解"
3. ~/projects/myapp/CLAUDE.md    (Project)  "使用 TypeScript, 遵循 ESLint"
4. ~/projects/myapp/.claude/CLAUDE.md (Project) "API 使用 REST 风格"
5. ~/projects/myapp/.claude/rules/style.md (Project) "缩进用 2 空格"
6. ~/projects/myapp/.claude/rules/react.md (Project) [条件] "使用函数式组件"
7. ~/projects/myapp/CLAUDE.local.md (Local) "我的 API key 不要暴露"
8. MEMORY.md                     (AutoMem)  "用户偏好 JWT"
```

注入到 System Prompt 中：

```
Codebase and user instructions are shown below.
Be sure to adhere to these instructions.
IMPORTANT: These instructions OVERRIDE any default behavior...

Contents of ~/.claude/CLAUDE.md (user's instructions):

我偏好简洁的代码风格

Contents of ~/.claude/rules/global.md (user's instructions):

总是添加类型注解

Contents of ~/projects/myapp/CLAUDE.md (project instructions, checked into the codebase):

使用 TypeScript, 遵循 ESLint

[... 更多文件 ...]

Contents of ~/projects/myapp/CLAUDE.local.md (user's private project instructions, not checked in):

我的 API key: 不要暴露在代码中

Contents of ~/.claude/projects/myapp-abc123/memory/MEMORY.md (user's auto-memory, persists across conversations):

用户上次在实现登录功能，偏好 JWT
```

---

## 15. 思考题

1. **CLAUDE.md 应该放在仓库根目录还是 .claude/ 下？** 根目录更可见，但可能污染项目结构。Claude Code 同时支持两种位置，让用户选择。

2. **AutoMem 的 200 行限制够用吗？** 这是一个保守的限制，防止 MEMORY.md 占用过多 context。如果用户需要更多记忆空间，可以通过 @include 引用外部文件。

3. **文件修改不自动检测是否有问题？** 这是一个有意识的权衡：自动文件监听（inotify/FSEvents）会增加复杂性和资源消耗。对于大多数用户来说，CLAUDE.md 修改频率很低，重启会话是可接受的。

4. **Session Memory 和 AutoMem 的边界在哪？** Session Memory 是会话级的上下文保持（compaction 后恢复），AutoMem 是跨会话的长期学习。一个是短期记忆，一个是长期记忆。

5. **如果多个 CLAUDE.md 有冲突指令怎么办？** 利用 LLM 的近因偏差：后加载的文件（更高优先级）的指令会自然"覆盖"先加载的文件。但这不是确定性的覆盖——LLM 可能两者都参考。
