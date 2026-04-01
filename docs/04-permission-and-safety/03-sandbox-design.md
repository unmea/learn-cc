# 沙箱应该在哪一层实现？

> **核心问题**：权限系统是"逻辑层"的安全——它检查操作是否**应该**被允许。但如果 AI Agent 绕过了权限系统（bug、race condition、prompt injection），谁来阻止它？答案是 OS 级沙箱——**物理层**的安全。
>

---

## 1. 四层纵深防御

```
┌──────────────────────────────────────────────────┐
│ 第 1 层：权限模式 (Permission Modes)              │
│  default / auto / bypassPermissions / dontAsk     │
│  → 决定"问不问用户"                               │
├──────────────────────────────────────────────────┤
│ 第 2 层：权限规则 (Permission Rules)              │
│  allow / deny / ask rules from 7 sources          │
│  → 决定"这个操作允不允许"                         │
├──────────────────────────────────────────────────┤
│ 第 3 层：AI 分类器 (YOLO Classifier)             │
│  独立 AI 调用判断安全性                           │
│  → 决定"这个操作看起来安全吗"                     │
├──────────────────────────────────────────────────┤
│ 第 4 层：OS 沙箱 (Sandbox)                       │  ← 本文焦点
│  seatbelt (macOS) / bwrap+seccomp (Linux)         │
│  → 物理阻止"未授权的文件/网络访问"               │
└──────────────────────────────────────────────────┘
```

**关键区别**：
- 第 1-3 层是**逻辑层安全**——它们检查操作是否应该被允许
- 第 4 层是**物理层安全**——它阻止操作实际发生

即使前三层全部失败（bug、bypass），沙箱仍然保护系统。

---

## 2. Claude Code 的沙箱方案

### 2.1 架构选择

Claude Code 使用 **`@anthropic-ai/sandbox-runtime`** 外部 npm 包，提供跨平台沙箱：

```typescript
// src/utils/sandbox/sandbox-adapter.ts

import { BaseSandboxManager } from '@anthropic-ai/sandbox-runtime'

// SandboxManager 是项目级的适配器层
// 包装了 BaseSandboxManager，添加 Claude Code 特有逻辑
```

### 2.2 平台支持

| 平台 | 技术 | 状态 |
|------|------|------|
| **macOS** | seatbelt (sandbox-exec) | ✅ 内建，无需安装 |
| **Linux** | bubblewrap (bwrap) + seccomp | ✅ 需要安装 bwrap |
| **WSL2+** | bubblewrap (bwrap) + seccomp | ✅ 需要安装 bwrap |
| **WSL1** | — | ❌ 不支持 |
| **Windows Native** | — | ❌ 不支持 |

### 2.3 依赖检测 UI

```typescript
// src/components/sandbox/SandboxDependenciesTab.tsx

// macOS:
//   seatbelt: ✅ built-in (macOS)

// Linux/WSL:
//   bubblewrap: ✅ installed / ❌ run: apt install bubblewrap
//   seccomp:    ⚠️ optional (npm package provides it)
//   socat:      ✅ installed / ❌ run: apt install socat
```

---

## 3. 沙箱激活逻辑

### 3.1 初始化流程

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L730-792

async function initialize(
  sandboxAskCallback?: SandboxAskCallback
): Promise<void> {
  // 1. 检查沙箱是否在设置中启用
  if (!getSandboxEnabledSetting()) return
  
  // 2. 检测 Git worktree 配置（缓存整个会话）
  await detectGitWorktreeConfig()
  
  // 3. 将 Claude Code 设置转换为 SandboxRuntimeConfig
  const config = convertToSandboxRuntimeConfig(settings)
  
  // 4. 初始化 BaseSandboxManager
  await BaseSandboxManager.initialize(config)
  
  // 5. 订阅设置变化，动态更新配置
  subscribeToSettingsChanges((newSettings) => {
    refreshConfig(convertToSandboxRuntimeConfig(newSettings))
  })
  
  // 6. 包装 sandboxAskCallback 以强制 allowManagedDomainsOnly 策略
  wrapCallbackForPolicy(sandboxAskCallback)
}
```

### 3.2 启用条件（全部为 true 才启用）

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L532-547

function isSandboxingEnabled(): boolean {
  // 1. 平台支持（macOS, Linux, WSL2+ 才支持）
  if (!isSupportedPlatform()) return false
  
  // 2. 依赖已安装（无 error 级依赖缺失）
  if (checkDependencies().errors.length > 0) return false
  
  // 3. 平台在 enabledPlatforms 列表中
  if (!isPlatformInEnabledList()) return false
  
  // 4. 用户明确启用
  return getSandboxEnabledSetting()
}
```

### 3.3 何时使用沙箱？

```typescript
// src/tools/BashTool/shouldUseSandbox.ts:L130-153

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  // 1. 沙箱全局启用？
  if (!SandboxManager.isSandboxingEnabled()) return false
  
  // 2. dangerouslyDisableSandbox 且被策略允许？
  if (input.dangerouslyDisableSandbox &&
      SandboxManager.areUnsandboxedCommandsAllowed()) {
    return false  // 用户明确选择不沙箱化此命令
  }
  
  // 3. 命令存在？
  if (!input.command) return false
  
  // 4. 命令在排除列表中？
  if (containsExcludedCommand(input.command)) return false
  
  return true  // 使用沙箱
}
```

### 3.4 命令排除

```typescript
// src/tools/BashTool/shouldUseSandbox.ts:L21-128

// 用户可以通过 /sandbox exclude "pattern" 排除特定命令
// 存储在 sandbox.excludedCommands: string[]
// 支持精确匹配、前缀匹配 (cmd:*)、通配符

function containsExcludedCommand(command: string): boolean {
  const excludedCommands = getExcludedCommands()
  for (const pattern of excludedCommands) {
    if (matchesPattern(command, pattern)) return true
  }
  return false
}
```

---

## 4. 沙箱配置转换

### 4.1 从 Claude Code 设置到沙箱配置

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L172-381

export function convertToSandboxRuntimeConfig(
  settings: SettingsJson,
): SandboxRuntimeConfig {
  // === 文件系统访问 ===
  
  // allowWrite: 始终包含
  //   - "." (当前工作目录)
  //   - getClaudeTempDir() (Claude 临时目录)
  
  // denyWrite: 阻止写入
  //   - settings.json 文件（防止设置逃逸）
  //   - .claude/skills/ 目录
  //   - bare git repo markers (HEAD, objects 等)
  
  // === 网络访问 ===
  
  // allowedDomains: 从 WebFetch(domain:*) 规则提取
  //   + sandbox.network.allowedDomains
  
  // deniedDomains: 从 deny 规则提取
  
  // allowManagedDomainsOnly: 企业策略限制
}
```

### 4.2 路径模式解析

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L99-146

// Claude Code 的特殊路径约定 → 沙箱路径
//
// //path  → 绝对路径 /path（从根开始）
// /path   → 相对于设置文件目录 ($SETTINGS_DIR/path)
// ~/path  → 用户 home 目录
// ./path  → 相对路径（传递给 sandbox-runtime）

function resolvePathPatternForSandbox(pattern: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1)
  if (pattern.startsWith('/'))  return join(settingsDir, pattern)
  if (pattern.startsWith('~')) return pattern  // sandbox-runtime 处理
  return pattern  // 相对路径
}
```

---

## 5. Git 仓库攻击防护

### 5.1 威胁模型

**攻击场景**：恶意用户在工作目录中放置 `HEAD`、`objects`、`refs/`、`hooks/`、`config` 文件，使 git 认为 CWD 是一个 bare repo。然后通过 `core.fsmonitor` 配置触发任意代码执行。

### 5.2 防护措施

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L257-280

// 1. 已存在的 git 文件 → denyWrite（沙箱内只读挂载）
if (existsSync(join(cwd, 'HEAD'))) {
  denyWritePaths.push('HEAD')
}

// 2. 不存在的 git 文件 → 记录到 bareGitRepoScrubPaths
//    命令执行后，scrubBareGitRepoFiles() 删除新创建的可疑文件
if (!existsSync(join(cwd, 'HEAD'))) {
  bareGitRepoScrubPaths.push('HEAD')
}

// 3. 沙箱内：git 本身也被沙箱化
// → 即使 git 被诱导，沙箱限制了它的文件系统访问
```

---

## 6. 沙箱与权限系统的交互

### 6.1 沙箱自动允许（autoAllowBashIfSandboxed）

```typescript
// src/tools/BashTool/bashPermissions.ts

// 当沙箱启用 + autoAllowBashIfSandboxed 配置时：
// → Bash 命令的文件权限检查被跳过
// → 网络操作由沙箱的 seccomp 规则验证
// → 原本需要 'ask' 的路径操作自动允许（因为沙箱会物理阻止越权）

// 逻辑链：
// 1. getAskRuleForTool() 找到全局 Bash ask 规则
// 2. 检查 canSandboxAutoAllow 条件
// 3. 如果沙箱可以自动允许 → 跳过 ask，交给 checkPermissions
// 4. BashTool.checkPermissions 知道有沙箱 → 放宽检查
```

### 6.2 权限层 vs 沙箱层的分工

```
┌────────────────────────────────────────────────────┐
│                  权限层 (逻辑)                      │
│                                                     │
│  "这个操作应该被允许吗？"                           │
│                                                     │
│  ✓ 检查 deny/allow/ask 规则                        │
│  ✓ 运行 AI 分类器                                   │
│  ✓ 提示用户确认                                     │
│  ✗ 无法阻止绕过（bug、race condition）              │
│                                                     │
├────────────────────────────────────────────────────┤
│                  沙箱层 (物理)                       │
│                                                     │
│  "这个进程能否物理访问这个文件/网络？"               │
│                                                     │
│  ✓ 限制文件系统访问（只允许 CWD + 配置目录）        │
│  ✓ 限制网络访问（seccomp 过滤）                     │
│  ✓ 即使权限层被绕过也能阻止                         │
│  ✗ 粒度较粗（无法区分命令的语义意图）               │
│                                                     │
└────────────────────────────────────────────────────┘
```

---

## 7. 与 Codex 的沙箱对比

### 7.1 Codex 的方案：OS 原生沙箱

OpenAI Codex 使用**纯 OS 原生沙箱**，无外部包依赖：

```
macOS:   sandbox-exec (seatbelt)     — 系统自带
Linux:   bwrap + landlock            — 内核特性
```

Codex 的设计哲学：**每个 Agent 任务在隔离的沙箱中运行**，类似容器。

### 7.2 Claude Code 的方案：外部包 + 权限混合

```
macOS:   seatbelt (通过 @anthropic-ai/sandbox-runtime)
Linux:   bwrap + seccomp (通过 @anthropic-ai/sandbox-runtime)
```

Claude Code 的设计哲学：**沙箱是可选的安全增强**，与权限系统协同工作。

### 7.3 对比分析

| 维度 | Claude Code | Codex |
|------|-----------|-------|
| **沙箱定位** | 可选增强层 | 核心隔离层 |
| **实现方式** | npm 包封装 | OS 原生 API |
| **粒度** | 命令级别 | 任务/会话级别 |
| **网络控制** | seccomp + 域名白名单 | landlock + 完全隔离 |
| **文件系统** | CWD + 配置白名单 | 读写白名单 + 只读挂载 |
| **权限联动** | 沙箱影响权限决策 | 沙箱独立于权限 |
| **可配置性** | 高（用户可排除命令） | 低（固定隔离策略） |
| **平台支持** | macOS + Linux/WSL2 | macOS + Linux |
| **Windows** | 不支持 | 不支持 |
| **启用方式** | 用户手动启用 | 默认启用 |

### 7.4 灵活性 vs 安全深度

**Claude Code 的权衡**：
- ✅ 更灵活：用户可以精细配置沙箱行为
- ✅ 渐进式：不启用沙箱也能用（权限系统仍然保护）
- ✅ 可调优：排除特定命令以适应复杂工作流
- ❌ 安全深度较浅：沙箱是可选的，用户可能不启用
- ❌ 依赖外部包：@anthropic-ai/sandbox-runtime 本身的安全性

**Codex 的权衡**：
- ✅ 安全深度更深：默认全隔离
- ✅ 无外部依赖：直接使用 OS API
- ❌ 灵活性差：难以适应需要网络/特殊文件访问的工作流
- ❌ 上手门槛高：用户需要理解沙箱配置

---

## 8. 沙箱配置层级

### 8.1 设置优先级

```
policySettings (最高 — 企业策略)
  ↓
flagSettings (功能标志)
  ↓
localSettings (.claude/settings.local.json)
  ↓
projectSettings (.claude/settings.json)
  ↓
userSettings (~/.claude/settings.json)
  ↓
默认值 (最低)
```

### 8.2 策略锁定

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L646-664

// 如果 policySettings 或 flagSettings 明确设置了沙箱选项
function areSandboxSettingsLockedByPolicy(): boolean {
  // → 本地通过 /sandbox 命令的修改被拒绝
  // → 用户只能在企业策略允许的范围内操作
}
```

### 8.3 动态配置更新

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L776-780

// 权限规则变化时，同步更新沙箱配置
refreshConfig(newConfig)
// → 避免 pending 请求使用过期配置的 race condition
```

---

## 9. SandboxSettingsSchema

```typescript
// src/entrypoints/sandboxTypes.ts:L91-144

type SandboxSettings = {
  enabled: boolean
  
  filesystem: {
    allowRead?: string[]    // 额外允许读取的路径
    allowWrite?: string[]   // 额外允许写入的路径
    denyRead?: string[]     // 阻止读取的路径
    denyWrite?: string[]    // 阻止写入的路径
  }
  
  network: {
    allowedDomains?: string[]  // 允许访问的域名
    deniedDomains?: string[]   // 阻止访问的域名
  }
  
  excludedCommands?: string[]  // 不沙箱化的命令
  
  autoAllowBashIfSandboxed?: boolean  // 沙箱启用时自动允许 Bash
}
```

---

## 10. 沙箱违规检测

### 10.1 违规追踪

```typescript
// SandboxViolationStore 追踪命令执行期间的违规

// 当沙箱阻止了操作时：
// 1. 记录违规到 SandboxViolationStore
// 2. 在 stderr 中追加违规信息
// 3. cleanupAfterCommand() 触发后续清理

getSandboxViolationStore()           // 获取违规历史
annotateStderrWithSandboxFailures()  // 在 stderr 末尾添加违规描述
```

### 10.2 不可用原因诊断

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L549-592

function getSandboxUnavailableReason(): string | null {
  // 精确诊断为什么沙箱无法运行：
  // - "WSL1 (not supported, need WSL2)"
  // - "Missing dependencies: bwrap, socat"
  // - "Platform not in enabledPlatforms list"
  // - "Unsupported platform (Windows native)"
}
```

### 10.3 Linux Glob 模式警告

```typescript
// src/utils/sandbox/sandbox-adapter.ts:L594-642

// bubblewrap 不支持 glob 模式的路径
// macOS seatbelt 支持 glob
// → 在 Linux/WSL 上，如果权限规则包含 *.ts 或 [abc] 等 glob
//   → 发出警告：这些模式在当前平台不生效
```

---

## 11. 命令执行流程中的沙箱

```
用户/Agent 发起 Bash 命令
        │
        ▼
  hasPermissionsToUseTool()
  ├─ 权限规则检查
  ├─ 工具 checkPermissions
  │   └─ shouldUseSandbox(input) → true
  │       └─ 权限检查放宽（沙箱会保护）
  ├─ AI 分类器（auto 模式）
  └─ 最终决策：allow
        │
        ▼
  Shell.ts: 准备执行命令
  ├─ shouldUseSandbox(input) → true
  ├─ wrapWithSandbox(command) ← 用沙箱包装命令
  └─ 执行沙箱化命令
        │
        ▼
  ┌─── 沙箱环境 ───┐
  │                  │
  │  命令执行       │
  │  ↓              │
  │  访问文件？     │
  │  ├─ CWD 内 ✅  │
  │  ├─ 配置允许 ✅ │
  │  └─ 其他 ❌    │  ← EPERM
  │                  │
  │  访问网络？     │
  │  ├─ 白名单 ✅  │
  │  └─ 其他 ❌    │  ← seccomp 阻止
  │                  │
  └──────────────────┘
        │
        ▼
  命令完成
  ├─ 检查 SandboxViolationStore
  ├─ scrubBareGitRepoFiles()  ← 清理可疑文件
  └─ 返回结果
```

---

## 12. 设计分析

### 12.1 为什么沙箱是可选的？

1. **兼容性**：不是所有平台都支持沙箱
2. **工作流多样性**：某些合法工作流需要广泛的文件/网络访问
3. **渐进式安全**：权限系统已经提供了基本保护
4. **开发者体验**：强制沙箱会增加配置负担

### 12.2 为什么使用外部包而非直接调用 OS API？

1. **跨平台抽象**：一套接口覆盖 seatbelt + bwrap + seccomp
2. **维护成本**：OS 沙箱 API 复杂且不稳定
3. **安全审计**：集中在一个包中审计比散布在整个代码库中更容易
4. **可升级性**：包更新不需要修改 Claude Code 本身

### 12.3 沙箱与权限系统的协同

最巧妙的设计是 **沙箱反向影响权限决策**：

```
正常流程：  权限检查 → 沙箱执行
协同流程：  权限检查 ← 沙箱状态
            "沙箱已启用？那我可以放宽权限检查"
```

这意味着：
- 沙箱启用时，用户体验更流畅（更少的权限弹窗）
- 沙箱禁用时，权限系统自动收紧（更多的确认提示）
- 两层安全机制**自适应**协作

---

## 13. 安全保护的完整画面

```
┌─────────────────────────────────────────────────────┐
│                   攻击面分析                          │
├──────────────┬──────────────────────────────────────┤
│ 攻击向量      │ 哪一层防护？                         │
├──────────────┼──────────────────────────────────────┤
│ 删除系统文件  │ L1:deny + L3:分类器 + L4:沙箱       │
│ 修改 .bashrc  │ L2:safetyCheck(bypass不可跳过)       │
│ 窃取凭据      │ L4:沙箱(网络+文件限制)               │
│ git hook注入  │ L4:bareGitRepo防护                   │
│ 设置逃逸      │ L4:settings.json denyWrite           │
│ prompt注入    │ L3:分类器(独立prompt,不看assistant)   │
│ 工作目录外操作│ L2:workingDir检查 + L4:沙箱          │
│ npm恶意脚本   │ L1:ask规则 + L3:分类器 + L4:沙箱     │
└──────────────┴──────────────────────────────────────┘
```

---

## 15. 思考题

1. **沙箱应该默认启用吗？** Codex 默认启用，Claude Code 默认不启用。这反映了两种不同的产品哲学：Codex 面向受控环境，Claude Code 面向开发者日常使用。

2. **如果沙箱和权限系统冲突怎么办？** 例如权限系统允许 `Edit(/etc/hosts)`，但沙箱阻止了。当前设计中沙箱**总是**赢——它是物理层的最终裁判。

3. **`dangerouslyDisableSandbox` 的风险**：用户可以对特定命令禁用沙箱。这打破了纵深防御，但某些工作流确实需要（如 Docker 操作）。通过命名（`dangerously`）和策略锁定来警示风险。

4. **分布式场景**：CCR（远程执行）场景中，沙箱尤其重要——用户代码在远程机器上执行，本地无法物理监控。这也是为什么配置转换需要考虑 `allowManagedDomainsOnly` 等企业策略。
