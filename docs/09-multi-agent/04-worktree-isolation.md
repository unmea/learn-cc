# Q: 多 Agent 同时改代码如何不冲突？


---

## 问题：并发编辑的冲突

当多个 Agent 同时修改代码时，最直观的问题是：

```
Agent A: 编辑 src/auth.ts 第 42 行 → 添加 null check
Agent B: 编辑 src/auth.ts 第 45 行 → 重构函数签名
                    ↓
     同一个文件、同一时间、不同修改
              → 冲突、覆盖、损坏
```

解决方案是 **Git Worktree**：每个 Agent 在独立的工作目录中操作，共享同一个 `.git` 仓库。

---

## Git Worktree 基础知识

### 什么是 Worktree？

Git worktree 是同一个仓库的**另一个工作目录**。它与主仓库共享 `.git` 数据库
（对象、引用、配置），但有自己的：
- 工作目录（独立的文件副本）
- 索引（staging area）
- HEAD 指针（可以在不同的分支上）

```
主仓库: /project/
  ├── .git/            ← 共享的 Git 数据库
  ├── src/auth.ts      ← Agent A 编辑这里
  └── ...

Worktree: /project/.claude/worktrees/feature-login/
  ├── .git             ← 指向主仓库 .git 的文件（不是目录）
  ├── src/auth.ts      ← Agent B 编辑这里（独立副本）
  └── ...
```

### 为什么 Worktree 解决并发编辑问题？

1. **物理隔离**：每个 Agent 操作不同的文件系统路径
2. **独立分支**：每个 Worktree 在自己的分支上提交
3. **共享历史**：所有 Worktree 共享对象数据库，最终合并无缝

---

## EnterWorktreeTool：创建并进入 Worktree

> **源码**: `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-127`

### 输入 Schema

```typescript
// 输入验证
name?: string  // Worktree 名称，可选
// 限制：最多 64 字符
// 每个 "/" 分隔段：只允许字母、数字、点、下划线、短横线
// 示例：valid: "feature/login-system", invalid: "../escape"
```

### 核心流程

```typescript
async call(input) {
  // 1. 作用域保护：每个 session 只允许一个 worktree
  if (getCurrentWorktreeSession()) {
    throw new Error('Already in a worktree session')
  }

  // 2. 回到主仓库根目录（处理从 worktree 内调用的情况）
  const mainRepoRoot = findCanonicalGitRoot(getCwd())
  if (mainRepoRoot && mainRepoRoot !== getCwd()) {
    process.chdir(mainRepoRoot)
    setCwd(mainRepoRoot)
  }

  // 3. 创建 worktree
  const slug = input.name ?? getPlanSlug()
  const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

  // 4. 切换工作目录（进程级 + 会话级）
  process.chdir(worktreeSession.worktreePath)
  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())

  // 5. 持久化 session 状态
  saveWorktreeState(worktreeSession)

  // 6. 清除依赖缓存
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()

  // 7. 分析事件
  logEvent('tengu_worktree_created', { mid_session: true })
}
```

### 输出

```typescript
interface Output {
  worktreePath: string      // 绝对路径
  worktreeBranch: string    // Git 分支名
  message: string           // 成功消息
}
```

---

## createWorktreeForSession：核心创建逻辑

> **源码**: `src/utils/worktree.ts:702-778`

```typescript
export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession>
```

### 创建流程

```
1. validateWorktreeSlug(slug)
   └── 长度检查、字符验证、防止路径穿越

2. 尝试 Hook 方式（非 Git VCS 支持）
   └── hasWorktreeCreateHook() ?
       ├── Yes → executeWorktreeCreateHook(slug)
       │         → hookBased: true
       └── No → 继续 Git 方式

3. Git 方式创建
   ├── findGitRoot()
   ├── getBranch()  → 记录原始分支
   ├── getOrCreateWorktree()
   │   ├── 快速恢复路径：已存在则直接返回
   │   ├── git fetch（获取最新基础分支）
   │   ├── git worktree add（创建 worktree）
   │   └── 处理 sparse-checkout（如果配置了）
   └── performPostCreationSetup()

4. 持久化状态
   └── saveCurrentProjectConfig()
```

### 分支命名约定

```
slug: "feature/login-system"
     ↓ 扁平化：/ → +
branch: "worktree-feature+login-system"
```

**为什么扁平化？**

Git 引用系统中存在 D/F（Directory/File）冲突：
- `refs/heads/worktree-user`（文件）
- `refs/heads/worktree-user/feature`（需要 `user` 是目录）
- 两者不能同时存在

扁平化用 `+` 替代 `/`，确保所有分支名在同一层级，避免冲突。

### 快速恢复优化

> **源码**: `src/utils/worktree.ts:235-255`

```typescript
// 如果 worktree 已存在，跳过 fetch 和创建
const existingHead = await readWorktreeHeadSha(worktreePath)
if (existingHead) {
  return {
    worktreePath,
    worktreeBranch,
    headCommit: existingHead,
    existed: true,  // 跳过 postCreationSetup
  }
}
```

**性能收益**：在大型仓库（210k 文件、16M 对象）中，`git fetch` 需要 6-8 秒。
快速恢复通过直接读取 `.git` 指针文件，跳过所有 git 子进程。

---

## WorktreeSession：会话状态

> **源码**: `src/utils/worktree.ts:140-154`

```typescript
export type WorktreeSession = {
  originalCwd: string           // 进入 worktree 前的工作目录
  worktreePath: string          // worktree 绝对路径
  worktreeName: string          // slug（如 "feature-login"）
  worktreeBranch?: string       // Git 分支名（仅 git 模式）
  originalBranch?: string       // 原始分支（仅 git 模式）
  originalHeadCommit?: string   // 原始 HEAD SHA（用于变更检测）
  sessionId: string             // 创建此 worktree 的 session ID
  tmuxSessionName?: string      // tmux session 名（如果用了 --tmux）
  hookBased?: boolean           // 是否通过 hook 创建
  creationDurationMs?: number   // 创建耗时（临时字段）
  usedSparsePaths?: boolean     // 是否用了 sparse-checkout（临时字段）
}
```

### 持久化

> **源码**: `src/utils/sessionStorage.ts:2889-2920`

```typescript
export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  // 剥离临时字段（creationDurationMs, usedSparsePaths）
  const stripped = worktreeSession ? {
    originalCwd, worktreePath, worktreeName,
    worktreeBranch, originalBranch, originalHeadCommit,
    sessionId, tmuxSessionName, hookBased
  } : null

  // 写入项目配置
  const project = getProject()
  project.currentSessionWorktree = stripped

  // 写入 session 文件（用于 --resume）
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: 'worktree-state',
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}
```

`--resume` 时恢复流程：
1. 从 session 文件读取 `PersistedWorktreeSession`
2. 验证 `worktreePath` 仍然存在
3. 调用 `restoreWorktreeSession()` 恢复模块状态
4. `process.chdir()` 进入 worktree

---

## ExitWorktreeTool：退出 Worktree

> **源码**: `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`

### 两种退出方式

**action: 'keep'** — 保留 worktree，仅切回主仓库

```
worktree 和分支保留在磁盘上
用户可以手动 cd 回去继续工作
如果有 tmux session，保持运行
```

**action: 'remove'** — 清理 worktree 和分支

```
删除 worktree 目录
删除临时分支
如果有 tmux session，kill 掉
```

### 验证阶段：Fail-Closed 安全模式

> **源码**: `ExitWorktreeTool.ts:174-224`

```typescript
async validateInput(input) {
  // 1. 作用域保护：只操作本 session 创建的 worktree
  const session = getCurrentWorktreeSession()
  if (!session) {
    return { result: false, message: 'No active EnterWorktree session' }
  }

  // 2. 如果要删除，检查未提交的变更
  if (input.action === 'remove' && !input.discard_changes) {
    const summary = await countWorktreeChanges(
      session.worktreePath,
      session.originalHeadCommit,
    )
    
    // Fail-closed：无法确定状态时，拒绝删除
    if (summary === null) {
      return { result: false, message: 'Could not verify worktree state' }
    }

    // 有未保存变更时，要求确认
    if (changedFiles > 0 || commits > 0) {
      return {
        result: false,
        message: `Worktree has ${parts}. Re-invoke with discard_changes: true`
      }
    }
  }
}
```

### 变更检测：Fail-Closed 模式

> **源码**: `ExitWorktreeTool.ts:79-113`

```typescript
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  // 1. 检查未提交文件
  const status = await execFileNoThrow('git', ['status', '--porcelain'], ...)
  if (status.code !== 0) return null     // ← Fail-closed

  const changedFiles = countNonEmpty(status.stdout.split('\n'))

  // 2. 检查新提交
  if (!originalHeadCommit) return null    // ← Fail-closed：无基线无法计数

  const revList = await execFileNoThrow('git',
    ['rev-list', '--count', `${originalHeadCommit}..HEAD`], ...)
  if (revList.code !== 0) return null     // ← Fail-closed

  return { changedFiles, commits: parseInt(revList.stdout.trim(), 10) || 0 }
}
```

**Fail-Closed 原则**：当无法可靠判断 worktree 状态时，返回 `null`。
调用方将 `null` 视为"未知，假设不安全"——拒绝删除，避免静默丢失代码。

返回 `null` 的场景：
- `git status` 失败（损坏的索引、锁文件、坏引用）
- `git rev-list` 失败（损坏的 worktree）
- `originalHeadCommit` 未定义（hook-based worktree 没有基线）

### 清理执行

> **源码**: `src/utils/worktree.ts:813-894`

```typescript
async function cleanupWorktree() {
  // 1. 切回原始目录
  process.chdir(originalCwd)

  // 2. 根据创建方式选择清理方法
  if (hookBased) {
    await executeWorktreeRemoveHook(worktreePath)
  } else {
    // Git 方式：git worktree remove --force
    await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: originalCwd }
    )
  }

  // 3. 清空 session 状态
  currentWorktreeSession = null

  // 4. 删除临时分支（仅 git 模式）
  if (!hookBased && worktreeBranch) {
    await sleep(100)  // 等 git 释放锁
    await execFileNoThrowWithCwd(
      gitExe(),
      ['branch', '-D', worktreeBranch],
      { cwd: originalCwd }
    )
  }
}
```

### 恢复会话状态

> **源码**: `ExitWorktreeTool.ts:122-146`

```typescript
function restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree) {
  setCwd(originalCwd)
  setOriginalCwd(originalCwd)
  
  if (projectRootIsWorktree) {
    setProjectRoot(originalCwd)
    updateHooksConfigSnapshot()  // 从原始目录重新读取
  }
  
  // 持久化退出状态
  saveWorktreeState(null)
  
  // 清除依赖缓存
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
}
```

---

## Agent Worktree：轻量级隔离

对于通过 AgentTool 创建的子 Agent，使用更轻量的 worktree：

> **源码**: `src/utils/worktree.ts:902-952`

```typescript
export async function createAgentWorktree(slug: string) {
  // 关键区别：不修改全局 session 状态
  // - 不调用 process.chdir()
  // - 不调用 setCwd()
  // - 不修改 currentWorktreeSession
  
  return { worktreePath, worktreeBranch, headCommit, gitRoot }
}
```

### 与 Session Worktree 的区别

| 维度 | Session Worktree (EnterWorktree) | Agent Worktree (createAgentWorktree) |
|------|----------------------------------|--------------------------------------|
| 全局状态 | 修改 cwd、currentWorktreeSession | 不修改任何全局状态 |
| process.chdir | 是 | 否 |
| 持久化 | 写入 session 文件 | 不持久化 |
| 使用场景 | 用户手动进入 | AgentTool 自动创建 |
| 清理 | ExitWorktreeTool | removeAgentWorktree() |
| 命名模式 | 用户指定或 plan slug | `agent-{agentId前8位}` |

### AgentTool 中的 Worktree 创建

> **源码**: `src/tools/AgentTool/AgentTool.tsx:592`

```typescript
if (effectiveIsolation === 'worktree') {
  const slug = `agent-${earlyAgentId.slice(0, 8)}`
  worktreeInfo = await createAgentWorktree(slug)
}
```

隔离模式由 `agentDefinition.spawnMode` 或远程控制设置决定：
- `'same-dir'`：Agent 在父目录运行（无隔离）
- `'worktree'`：Agent 获得独立 worktree

---

## Post-Creation Setup：新 Worktree 的后置配置

> **源码**: `src/utils/worktree.ts:510-624`

每个**新创建**的 worktree（不包括快速恢复）会执行以下配置：

### 1. 复制 settings.local.json

```typescript
// 传播本地设置（可能包含密钥）到 worktree
// 优雅降级：文件不存在时跳过
```

### 2. 配置 Git Hooks

```typescript
// 找到 hooks 目录（.husky 或 .git/hooks）
// 设置 core.hooksPath（共享配置，只设置一次）
// 检查避免重复 git 子进程调用
```

### 3. 符号链接目录

```typescript
// 由 settings.worktree.symlinkDirectories 配置
// 例：symlink node_modules → 避免磁盘膨胀
// 安全检查：防止路径穿越
```

### 4. 复制 .worktreeinclude 文件

```typescript
// 复制被 .gitignore 的文件到 worktree
// 使用 .gitignore 语法的 .worktreeinclude 配置
// 优化：单次遍历 + 目录折叠
```

### 5. 安装归属 Hook

```typescript
// 如果 COMMIT_ATTRIBUTION 特性启用
// 安装 prepare-commit-msg hook
// 异步执行，不阻塞 worktree 创建
```

---

## Slug 验证：路径安全

> **源码**: `src/utils/worktree.ts:66-87`

```typescript
export function validateWorktreeSlug(slug: string): void {
  // 长度限制
  if (slug.length > 64) {
    throw new Error(`must be 64 characters or fewer`)
  }

  for (const segment of slug.split('/')) {
    // 防止路径穿越
    if (segment === '.' || segment === '..') {
      throw new Error(`must not contain "." or ".." path segments`)
    }
    
    // 字符白名单
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) {
      throw new Error(
        `each "/"-separated segment must contain only letters, digits, dots, underscores, and dashes`
      )
    }
  }
}
```

为什么需要严格验证？`path.join()` 会规范化 `..` 段——`../../../target` 会逃逸出
`.claude/worktrees/` 目录。绝对路径会完全覆盖前缀。

---

## Sparse-Checkout：大型仓库优化

> **源码**: `src/utils/worktree.ts:321-366`

```typescript
const sparsePaths = getInitialSettings().worktree?.sparsePaths

if (sparsePaths?.length) {
  // 1. git worktree add --no-checkout（不检出任何文件）
  // 2. git sparse-checkout set --cone（配置稀疏检出）
  // 3. git checkout HEAD（只检出指定路径）
}
```

配置示例：

```json
{
  "worktree": {
    "sparsePaths": ["src", "package.json", "tsconfig.json"],
    "symlinkDirectories": ["node_modules", ".cache"]
  }
}
```

**失败安全**：如果 sparse-checkout 或 checkout 失败，立即拆除空 worktree：

```typescript
const tearDown = async (msg: string): Promise<never> => {
  await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'remove', '--force', worktreePath],
    { cwd: repoRoot },
  )
  throw new Error(msg)
}
```

---

## 过期 Worktree 清理

> **源码**: `src/utils/worktree.ts:1058-1136`

```typescript
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,  // 默认 30 天
): Promise<number>
```

### 临时 Worktree 模式

```typescript
// src/utils/worktree.ts:1030-1041
const EPHEMERAL_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,                    // AgentTool worktrees
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,       // Workflow worktrees
  /^wf-\d+$/,                                 // Legacy workflow
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/, // Bridge worktrees
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,  // Template job worktrees
]
```

### 安全检查层

```
1. 模式匹配：只触碰已知的临时模式
   └── 永远不动用户命名的 EnterWorktree worktrees

2. 当前保护：跳过当前 session 的 worktree

3. 状态验证（fail-closed）：
   ├── git status 失败 → 跳过
   ├── 有追踪变更 → 跳过
   └── 提交不可从远程追溯 → 跳过

4. 性能优化：
   └── git status -uno（跳过未追踪文件扫描）
       30 天前的 crash 遗留 worktree 中的未追踪文件是构建产物
```

---

## 局限性和边缘场景

### 局限性 1：每个 Session 只允许一个 Worktree

```typescript
if (getCurrentWorktreeSession()) {
  throw new Error('Already in a worktree session')
}
```

设计选择：简化状态管理。如果需要多个 worktree，通过多个 Agent（各有自己的 session）实现。

### 局限性 2：Git Hooks 共享配置

`core.hooksPath` 是 Git 的全局配置（所有 worktree 共享）：
- 首次创建 worktree 时设置
- Husky 的 `prepare` 脚本可能在 `bun install` 时重置
- Claude Code 的解决方案：直接在 worktree 的 `.husky/` 中安装 hook

### 局限性 3：D/F 冲突强制扁平化

嵌套的 slug（如 `user/feature`）在目录结构中也可能导致问题：
`.claude/worktrees/user/feature/` 在 `user` worktree 内部。
`git worktree remove` 父 worktree 时会删除子 worktree。

解决方案是将所有嵌套 slug 扁平化为单层。

### 局限性 4：filesTouched 不完整（DreamTask）

Worktree 中的文件变更通过 `git status` 追踪，但通过 bash 命令间接写入的文件
可能不在追踪列表中。

### 边缘场景：Hook-Based Worktree

对于非 Git VCS（如 Perforce），通过 hook 机制支持 worktree：

```typescript
if (hasWorktreeCreateHook()) {
  const hookResult = await executeWorktreeCreateHook(slug)
  // hookBased: true — 没有 git branch，没有 originalHeadCommit
  // 变更检测受限（无法 rev-list）
}
```

### 边缘场景：Tmux 嵌套

```typescript
const isAlreadyInTmux = Boolean(process.env.TMUX)

if (isAlreadyInTmux) {
  // 创建分离的 session，然后 switch-client（兄弟关系，非嵌套）
  spawnSync('tmux', ['new-session', '-d', ...])
  spawnSync('tmux', ['switch-client', '-t', tmuxSessionName])
} else {
  // 正常创建并 attach
}
```

### 边缘场景：iTerm2 集成

```typescript
const useControlMode = isInITerm2() && !forceClassicTmux && !isAlreadyInTmux
const tmuxGlobalArgs = useControlMode ? ['-CC'] : []  // tmux 控制模式
```

---

## 设计分析：Worktree vs 其他方案

### 方案对比

| 方案 | 隔离级别 | 合并成本 | 磁盘开销 | 实现复杂度 |
|------|---------|---------|---------|-----------|
| **Git Worktree（当前）** | 目录级 | Git merge | 中等 | 中等 |
| 分支切换 | 无（同目录） | 手动 cherry-pick | 无 | 低 |
| git clone | 仓库级 | 远程 push/pull | 高 | 低 |
| Patch 队列 | 补丁级 | 手动应用 | 低 | 高 |
| 虚拟文件系统 | 文件级 | 合并算法 | 低 | 极高 |

### 为什么 Worktree 是最佳选择？

**vs 分支切换**：分支切换会改变所有文件，不能并发。Agent A 切到 feature-a，
Agent B 就无法在同一目录工作。

**vs git clone**：完整 clone 在大型仓库中耗时且浪费磁盘。
Worktree 共享 `.git` 对象数据库，只复制工作目录。

**vs Patch 队列**：需要复杂的补丁管理和冲突解决逻辑。
Worktree 让 Git 处理这一切。

**vs 虚拟文件系统**：实现复杂度极高，需要 FUSE 或类似技术。
不适合 CLI 工具的约束。

### Worktree 的独特优势

1. **Git 原生**：不需要额外工具或依赖
2. **共享对象**：避免重复存储（大型仓库优势明显）
3. **标准合并**：创建 PR → 代码审查 → 合并，与正常工作流一致
4. **Sparse-Checkout 兼容**：只检出需要的路径，进一步减少磁盘和时间开销
5. **Fail-Safe**：即使 worktree 损坏，主仓库不受影响

---

## 完整架构图

```
┌─────────────────────────────────────────────────────────┐
│                    主仓库 /project/                       │
│  .git/ ←──── 共享的 Git 对象数据库                        │
│  src/                                                    │
│  package.json                                            │
│                                                          │
│  .claude/worktrees/                                      │
│  ├── feature-login/     ← EnterWorktreeTool (Session)    │
│  │   ├── .git           (指针文件，指向主 .git)            │
│  │   ├── src/           (独立文件副本)                     │
│  │   └── node_modules → ../../node_modules (符号链接)     │
│  │                                                       │
│  ├── agent-a1b2c3d4/    ← createAgentWorktree (Agent)    │
│  │   ├── .git                                            │
│  │   └── src/                                            │
│  │                                                       │
│  └── agent-e5f6g7h8/    ← createAgentWorktree (Agent)    │
│      ├── .git                                            │
│      └── src/                                            │
└─────────────────────────────────────────────────────────┘
```

---

## 快速参考

### 关键函数

| 函数 | 用途 |
|------|------|
| `createWorktreeForSession()` | 创建 Session worktree |
| `createAgentWorktree()` | 创建 Agent worktree（轻量） |
| `removeAgentWorktree()` | 清理 Agent worktree |
| `cleanupStaleAgentWorktrees()` | 清理 30 天前的临时 worktree |
| `validateWorktreeSlug()` | 验证 slug 安全性 |
| `countWorktreeChanges()` | Fail-closed 变更检测 |
| `performPostCreationSetup()` | 新 worktree 后置配置 |
| `saveWorktreeState()` | 持久化/清除 worktree 状态 |
