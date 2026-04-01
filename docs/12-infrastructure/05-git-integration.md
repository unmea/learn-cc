# Q: Agent 如何与 Git 深度集成？

> **核心问题**：Git 是代码开发的基础设施。Claude Code 不仅用 Git 读写代码，还将其作为多 Agent 协作的隔离机制、上下文信息源、以及安全边界。这种深度集成是如何实现的？

---

## 1. Git 集成架构全景

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code Git 集成                        │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ 上下文层         │  │ 操作层           │  │ 协作层        │  │
│  │                  │  │                  │  │              │  │
│  │ • 仓库根检测     │  │ • Diff 计算      │  │ • Worktree   │  │
│  │ • 分支/状态      │  │ • Stash 管理     │  │ • Bundle     │  │
│  │ • 最近提交       │  │ • 操作追踪       │  │ • 会话隔离   │  │
│  │ • Gitignore      │  │ • 安全检查       │  │ • CCR 克隆   │  │
│  └──────────────────┘  └──────────────────┘  └──────────────┘  │
│                                                                 │
│  核心文件:                                                       │
│  src/utils/git.ts (926 行)           ← Git 基础操作             │
│  src/utils/gitDiff.ts (532 行)       ← Diff 计算与解析          │
│  src/utils/worktree.ts (1519 行)     ← Worktree 管理           │
│  src/context.ts (111 行)             ← Git 上下文采集           │
│  src/tools/shared/gitOperationTracking.ts (278 行) ← 操作追踪  │
│  src/utils/git/gitignore.ts (100 行) ← Gitignore 处理          │
│  src/utils/git/gitFilesystem.ts       ← Git 目录解析            │
│  src/utils/teleport/gitBundle.ts      ← Bundle 创建            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 仓库根检测——Agent 的空间感知

### 2.1 Git Root 查找

> **源码引用**：`src/utils/git.ts:97-109`

```typescript
export function findGitRoot(startDir: string): string | null {
  // 向上遍历目录树，寻找 .git 目录或文件
  // 处理常规仓库和 worktree/submodule
  // LRU 缓存（最多 50 条），防止内存无限增长
  // 返回 NFC 规范化的路径（Unicode 正规化）
  // 记录诊断日志：find_git_root_started, find_git_root_completed
}
```

**关键细节**：
- **LRU 缓存**：对同一路径的重复查询直接返回缓存结果
- **Unicode NFC**：macOS 的 HFS+ 文件系统使用 NFD 编码，统一为 NFC 防止路径比较问题
- **性能追踪**：记录 stat 调用次数和耗时（Git root 查找是常见的性能瓶颈）

### 2.2 Canonical Root（规范根）

```typescript
// src/utils/git.ts:195-210
export function findCanonicalGitRoot(startDir: string): string | null {
  // 对于 worktree，解析到主仓库根
  // 通过 .git → gitdir → commondir 链路解析
  // 安全验证：防止 symlink 绕过
}
```

**安全验证**（`src/utils/git.ts:148-169`）：
```
.git 文件 → 读取 gitdir 路径
           → 解析 commondir
           → realpath 防止 symlink 攻击
           → 验证 backlink 一致性
           → 确保结构匹配 git worktree add 格式
```

---

## 3. Git 上下文——对话的环境信息

### 3.1 上下文采集

> **源码引用**：`src/context.ts:36-111`

```typescript
export async function getGitStatus(): Promise<string> {
  // 采集并格式化 git 上下文

  // 1. 当前分支和状态
  const status = exec('git --no-optional-locks status --short')
  // 输出: M  src/main.ts
  //       ?? new-file.ts

  // 2. 最近 5 次提交
  const log = exec('git --no-optional-locks log --oneline -n 5')
  // 输出: abc1234 feat: add user auth
  //       def5678 fix: memory leak in query loop

  // 3. 用户信息
  const userName = exec('git config user.name')

  // 返回格式化字符串（最多 2000 字符）
  return formatGitContext(branch, status, log, userName)
}
```

**`--no-optional-locks` 的作用**：告诉 Git 不要获取仓库锁。这允许在其他 Git 操作（如 `git commit`）进行时并行读取状态，避免死锁。

### 3.2 上下文在系统提示词中的使用

```
[System Prompt]
...
Current git status:
Branch: feature/add-auth
Modified files: 3
Recent commits:
  abc1234 feat: add user auth
  def5678 fix: memory leak
Git user: John Doe
...
```

这让 LLM 能够：
- 了解当前工作分支和开发方向
- 看到哪些文件已修改（避免重复修改）
- 理解最近的变更上下文

### 3.3 Git 状态快照

```typescript
// src/utils/git.ts:463-500
export async function getGitState(): Promise<GitRepoState> {
  return {
    commitHash: await getHead(),
    branchName: await getBranch(),
    remoteUrl: await getRemoteUrl(),
    isHeadOnRemote: await getIsHeadOnRemote(),
    isClean: await getIsClean(),
    worktreeCount: await getWorktreeCount(),
  }
}
```

---

## 4. Diff 计算——编辑效果的量化

### 4.1 工作区 Diff

> **源码引用**：`src/utils/gitDiff.ts:49-107`

```typescript
export async function fetchGitDiff(): Promise<GitDiffResult> {
  // 快速探测：总体统计
  const shortstat = exec('git --no-optional-locks diff HEAD --shortstat')
  // 输出: 3 files changed, 150 insertions(+), 23 deletions(-)

  // 详细统计：每文件 +/- 行数
  const numstat = exec('git --no-optional-locks diff HEAD --numstat')
  // 输出: 120  10  src/main.ts
  //         30  13  src/utils.ts

  // 返回结构化结果
  return {
    stats: { filesCount: 3, linesAdded: 150, linesRemoved: 23 },
    fileStats: [...],  // 每文件统计
    hunks: new Map(),  // 延迟加载
  }
}
```

**性能优化**：Diff hunks（详细的代码变更块）不在初次调用时获取。`fetchGitDiffHunks()` 是独立函数，仅在需要时调用：

```typescript
// src/utils/gitDiff.ts:114-135
export async function fetchGitDiffHunks(): Promise<Map<string, Hunk[]>> {
  // 获取完整 unified diff
  const diff = exec('git --no-optional-locks diff HEAD')
  // 解析为结构化 hunk
  return parseGitDiff(diff)
}
```

### 4.2 单文件 Diff

> **源码引用**：`src/utils/gitDiff.ts:405-441`

```typescript
export async function fetchSingleFileGitDiff(
  filePath: string
): Promise<string> {
  // 1. 检查文件是否被 Git 追踪
  exec('git --no-optional-locks ls-files --error-unmatch <file>')

  // 2. 获取 diff 基准引用
  const diffRef = getDiffRef()
  // 优先级: CLAUDE_CODE_BASE_REF 环境变量
  //       → merge-base with default branch
  //       → HEAD

  // 3. 已追踪文件：标准 diff
  exec('git --no-optional-locks diff <diffRef> -- <file>')

  // 4. 未追踪文件：生成合成 diff（全部为新增行）
  return generateSyntheticDiff(content)
}
```

**使用场景**：
- `FileEditTool`（`src/tools/FileEditTool/FileEditTool.ts:551`）：编辑文件后显示 diff
- `FileWriteTool`（`src/tools/FileWriteTool/FileWriteTool.ts:350`）：写入文件后显示 diff

### 4.3 Diff 基准选择

```typescript
// src/utils/gitDiff.ts:490-502
function getDiffRef(): string {
  // 1. 用户指定的基准
  if (process.env.CLAUDE_CODE_BASE_REF) {
    return process.env.CLAUDE_CODE_BASE_REF
  }

  // 2. 与默认分支的 merge-base
  const mergeBase = exec('git merge-base HEAD <defaultBranch>')
  if (mergeBase) return mergeBase

  // 3. 回退到 HEAD
  return 'HEAD'
}
```

**设计决策**：使用 `merge-base` 而非简单的 `HEAD`，这样 diff 显示的是"自分支创建以来的所有变更"，而非"自上次提交以来的变更"。这更符合 PR review 的语义。

### 4.4 瞬态状态检测

```typescript
// src/utils/gitDiff.ts:307-326
export function isInTransientGitState(): boolean {
  // 检查是否处于 merge/rebase/cherry-pick/revert 中间状态
  return exists(gitDir + '/MERGE_HEAD') ||
         exists(gitDir + '/REBASE_HEAD') ||
         exists(gitDir + '/CHERRY_PICK_HEAD') ||
         exists(gitDir + '/REVERT_HEAD')
}
```

在瞬态状态下跳过 diff 计算，避免显示不完整或误导的 diff。

---

## 5. Git 操作追踪

> **源码引用**：`src/tools/shared/gitOperationTracking.ts`（278 行）

### 5.1 操作检测

```typescript
// 解析命令输出，识别 Git 操作类型

// Commit 检测
parseGitCommitId(output)
// 正则: /\[(\S+)\s+([a-f0-9]+)\]/ → 从 "[branch abc1234] message" 提取 SHA

// Push 检测
parseGitPushBranch(output)
// 从 ref 更新行提取分支名

// PR 检测
findPrInStdout(output)
// 从 GitHub PR URL 提取 PR 编号
parsePrNumberFromText(text)
```

### 5.2 追踪与计数

```typescript
// src/tools/shared/gitOperationTracking.ts:189-277
export function trackGitOperations(command: string, output: string): void {
  const operation = detectGitOperation(command, output)
  if (!operation) return

  // 递增 OpenTelemetry 计数器
  // 触发分析事件
  logEvent('tengu_git_operation', {
    type: operation.type,  // 'commit' | 'push' | 'merge' | 'rebase' | 'pr'
    // ...
  })
}
```

---

## 6. Worktree 管理——多 Agent 协作基础

> **源码引用**：`src/utils/worktree.ts`（1519 行）

### 6.1 为什么用 Worktree？

```
问题: 多个 Agent 同时修改代码会冲突

方案 1: 文件锁                 方案 2: Git Worktree
┌─────────────┐               ┌─────────────┐
│ Agent A     │               │ Agent A     │
│ 锁定 main.ts│               │ worktree-a/ │ ← 独立工作树
│ Agent B 等待│               │   main.ts   │
└─────────────┘               ├─────────────┤
                              │ Agent B     │
缺点: 串行化                   │ worktree-b/ │ ← 独立工作树
                              │   main.ts   │
                              └─────────────┘
                              优点: 完全并行
```

Git Worktree 允许在同一个仓库中创建多个工作目录，每个目录有自己的分支和文件状态，但共享 Git 对象和引用。

### 6.2 Worktree 创建与管理

```typescript
// src/utils/worktree.ts:235-299
export async function getOrCreateWorktree(options: {
  slug: string
  prNumber?: number
}): Promise<WorktreeCreateResult> {
  
  // 快速恢复：直接读 .git 指针文件（不需要子进程）
  const headSha = readWorktreeHeadSha(worktreePath)
  if (headSha) return resume(worktreePath, headSha)

  // 新建 worktree
  if (prNumber) {
    // PR 场景：fetch PR head
    exec('git fetch origin pull/<pr>/head')
  }
  exec('git fetch origin <defaultBranch>')
  
  // 环境变量禁止 Git 交互式提示
  // GIT_TERMINAL_PROMPT=0, GIT_ASKPASS='', stdin: 'ignore'
  
  return { worktreePath, worktreeBranch, ... }
}
```

### 6.3 Worktree 会话状态

```typescript
// src/utils/worktree.ts:140-154
type WorktreeSession = {
  originalCwd: string          // 原始工作目录
  worktreePath: string         // Worktree 路径
  worktreeName: string         // Worktree 名称
  worktreeBranch: string       // Worktree 分支
  originalBranch: string       // 原始分支
  originalHeadCommit: string   // 原始 HEAD
  sessionId: string            // 会话 ID
  tmuxSessionName: string      // Tmux 会话名
  hookBased: boolean           // 是否基于 Hook
  creationDurationMs: number   // 创建耗时
  usedSparsePaths: string[]    // 稀疏路径
}
```

### 6.4 分支命名

```typescript
// src/utils/worktree.ts:221
export function worktreeBranchName(slug: string): string {
  // user/feature → worktree-user+feature
  return `worktree-${slug.replace(/\//g, '+')}`
}
```

### 6.5 Symlink 优化

```typescript
// src/utils/worktree.ts:102-138
export function symlinkDirectories(
  sourceDir: string,
  targetDir: string,
  dirs: string[]
): void {
  // 将 node_modules 等大目录 symlink 到 worktree
  // 避免重复磁盘占用
}
```

**为什么 symlink node_modules？** 一个 `node_modules/` 可能占 1GB+。每个 worktree 复制一份不可接受。Symlink 让所有 worktree 共享同一份依赖。

### 6.6 Worktree 清理

```typescript
// src/utils/worktree.ts:305+
export async function removeWorktreeSession(session: WorktreeSession) {
  exec('git worktree remove --force <path>')  // 删除 worktree
  exec('git branch -D <branch>')              // 删除分支
  exec('git worktree prune')                  // 清理过期引用
  exec('git status --porcelain')              // 验证清理完成
}
```

### 6.7 Worktree 安全

```typescript
// src/utils/worktree.ts:66-87
export function validateWorktreeSlug(slug: string): boolean {
  // 防止路径遍历攻击
  // 只允许字母数字和 - _ / .
  // 不允许 .. 或绝对路径
}
```

---

## 7. Git Bundle——远程克隆优化

> **源码引用**：`src/utils/teleport/gitBundle.ts`

### 7.1 三级 Bundle 降级策略

```typescript
// src/utils/teleport/gitBundle.ts:50-130

// Level 1: 完整 bundle（所有引用和对象）
exec('git bundle create <path> --all')
// 成功 → 使用完整 bundle

// Level 2: HEAD-only bundle（如果完整 bundle 太大）
exec('git bundle create <path> HEAD')
// 成功 → 使用精简 bundle

// Level 3: 最小 bundle（squash root commit）
exec('git commit-tree')  // 创建合并根提交
exec('git update-ref refs/seed/root')
exec('git bundle create <path> refs/seed/root')
```

**大小限制**：`tengu_ccr_bundle_max_bytes`（默认 100MB）

### 7.2 Stash 保存

```typescript
// 保存工作进度到 bundle
exec('git stash create')                    // 创建临时 stash
exec('git update-ref refs/seed/stash ...')  // 让 stash 可被 bundle 包含
```

---

## 8. Gitignore 处理

> **源码引用**：`src/utils/git/gitignore.ts`

```typescript
// 检查文件是否被忽略
export async function isPathGitignored(filePath: string): Promise<boolean> {
  // 使用 git check-ignore
  // exit 0 = 被忽略, exit 1 = 未忽略, exit 128 = 非 git 仓库
  // 参考: .gitignore, .git/info/exclude, ~/.config/git/ignore
}

// 添加规则到全局 gitignore
export async function addFileGlobRuleToGitignore(pattern: string): Promise<void> {
  // 1. 检查是否已经被忽略（避免重复）
  // 2. 创建 ~/.config/git/ignore（如果不存在）
  // 3. 追加规则
}
```

---

## 9. Git 安全防护

### 9.1 PowerShell Git 安全

> **源码引用**：`src/tools/PowerShellTool/gitSafety.ts`

```typescript
// 防止 git-as-sandbox-escape 攻击
// 攻击场景: 通过 bare repo 或 hook 注入执行恶意代码

normalizeGitPathArg()    // 规范化路径，检测 git 内部路径
resolveCwdReentry()      // 处理通过父目录的重入攻击

// 检测的敏感路径: HEAD, objects/, refs/, hooks/
// 防止用户通过 git 参数操纵仓库内部结构
```

### 9.2 Ref 名称验证

```typescript
// src/utils/git/gitFilesystem.ts:98-107
export function isSafeRefName(ref: string): boolean {
  // 白名单字符: 字母、数字、/ . _ + - @
  // 拒绝: 路径遍历 (..), shell 元字符, 参数注入
  return /^[a-zA-Z0-9\/._+\-@]+$/.test(ref)
}
```

---

## 10. 会话中的 Git 上下文

### 10.1 会话元数据

```typescript
// src/utils/sessionStorage.ts
export async function getSessionMetadata(): Promise<SessionMetadata> {
  const gitBranch = await getBranch().catch(() => undefined)
  // 会话元数据中保存 git 分支
  // 用于: 会话列表显示、会话搜索、恢复时上下文
}
```

### 10.2 会话搜索

```typescript
// src/utils/agenticSessionSearch.ts
// 支持按分支名搜索会话
// 显示: "[branch: feature/add-auth]"
```

---

## 11. 设计分析：Git 作为 Agent 协作基础设施

### 11.1 Git 在 Claude Code 中的多重角色

```
1. 版本控制（基本功能）
   └── commit, push, branch, merge

2. 上下文信息源
   ├── 当前分支 → 理解开发方向
   ├── 最近提交 → 理解变更历史
   ├── 文件状态 → 避免重复修改
   └── Diff → 量化编辑效果

3. 隔离机制
   ├── Worktree → 多 Agent 并行编辑
   ├── Branch → 每个任务独立分支
   └── Stash → 保存/恢复工作进度

4. 安全边界
   ├── Gitignore → 文件过滤
   ├── Ref 验证 → 防注入攻击
   └── 路径规范化 → 防遍历攻击

5. 分发机制
   ├── Bundle → 远程克隆优化
   └── Sparse checkout → 减少磁盘占用
```

### 11.2 为什么不用 Docker/VM 作为隔离？

| 维度 | Git Worktree | Docker | VM |
|------|-------------|--------|-----|
| 创建速度 | 毫秒级 | 秒级 | 分钟级 |
| 磁盘占用 | symlink 共享 | 层级共享 | 完整复制 |
| 网络隔离 | 无 | 有 | 有 |
| 文件系统 | 共享 | 独立 | 独立 |
| 适用场景 | 代码编辑 | 运行时隔离 | 完整环境 |

**结论**：对于代码编辑场景，Git Worktree 提供了最轻量的隔离。不需要网络隔离或运行时隔离——Agent 只是在不同目录编辑文件。

---

## 12. 启发与超越

### 在你的 Agent 中集成 Git

1. **Git 上下文是免费的午餐**——分支、状态、最近提交可以大幅提高 LLM 的决策质量
2. **`--no-optional-locks` 是必须的**——避免并行操作死锁
3. **Worktree 是多 Agent 编辑的最佳隔离方案**——比 Docker 轻 1000x
4. **Diff 基准用 merge-base**——比 HEAD 语义更正确
5. **别忘了安全**——Git 参数是注入攻击的常见向量
6. **Bundle 降级策略**——大仓库需要分级策略（完整 → HEAD-only → squash root）
7. **缓存 Git 根查找**——LRU 缓存防止性能问题
8. **unicode 规范化**——macOS 上不做 NFC 转换会导致诡异的路径匹配 bug
