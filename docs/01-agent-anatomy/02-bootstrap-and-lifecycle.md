# Q: 一个 CLI Agent 如何启动？从进程创建到就绪，发生了什么？

> **一句话回答**：Claude Code 采用"快速分派 + 延迟加载"的两阶段启动模式——`cli.tsx` 在 0ms 内判断走哪条快速路径，只有需要完整 CLI 时才加载 `main.tsx` 的 700+ 行初始化序列。

---

## 为什么这个问题重要

启动速度直接影响用户体验。一个 CLI 工具如果启动需要 3 秒，用户就会感到痛苦。Claude Code 面对的挑战是：它的完整启动需要初始化 50+ 个选项、连接 MCP 服务器、加载权限、解析模型、创建会话、渲染 React UI……但用户可能只是想看 `--version`。

理解启动流程还能帮你理解**为什么代码被这样组织**——为什么 `cli.tsx` 和 `main.tsx` 是分开的，为什么到处都是 `await import()` 而非顶层 `import`，为什么有那么多 `profileCheckpoint` 调用。

---

## 深度解答

### 子问题 1：启动的两个阶段

Claude Code 的启动分为两个清晰的阶段：

```
阶段 1: Bootstrap（cli.tsx）         阶段 2: Full CLI（main.tsx）
┌─────────────────────────┐         ┌──────────────────────────────┐
│ • 零导入（仅 process.argv）│         │ • 135ms+ 的模块导入           │
│ • 快速路径分派             │   ──▶   │ • Commander.js 配置           │
│ • 最快 0 个额外模块        │         │ • 50+ 选项解析               │
│ • 仅在需要时才进入阶段 2    │         │ • 认证/初始化/设置            │
│                           │         │ • MCP/权限/模型解析            │
│ ~1ms (fast path)          │         │ • REPL 渲染                  │
│ ~5ms (before main import) │         │ ~500ms+ (full startup)       │
└─────────────────────────┘         └──────────────────────────────┘
```

### 子问题 2：cli.tsx 做了什么？

文件位置：`src/entrypoints/cli.tsx`（约 300 行）

#### 环境准备（顶层副作用）

```typescript
// src/entrypoints/cli.tsx:5
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// src/entrypoints/cli.tsx:9-14 — 远程环境堆内存设置
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192';
}

// src/entrypoints/cli.tsx:21-26 — A/B 实验基线消融
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', ...]) {
    process.env[k] ??= '1';
  }
}
```

这些在 `main()` 函数之前执行，确保环境变量在任何模块加载前就位。

#### Bootstrap 分派模式

`cli.tsx` 的核心是一个 `main()` 函数，包含一系列快速路径检查：

```typescript
// src/entrypoints/cli.tsx:33-34
async function main(): Promise<void> {
  const args = process.argv.slice(2);
```

每条快速路径遵循相同模式：**检查参数 → 动态导入最小依赖 → 执行 → return**。

#### 快速路径一览

| 优先级 | 条件 | 动态导入 | 说明 |
|-------|------|---------|------|
| 1 | `--version` / `-v` / `-V` | **零导入** | 直接打印 `MACRO.VERSION`，最快退出 |
| 2 | `--dump-system-prompt` | config, model, prompts | Ant-only，导出系统提示（feature 门控） |
| 3 | `--claude-in-chrome-mcp` | mcpServer | Chrome 集成 MCP 服务器 |
| 4 | `--chrome-native-host` | chromeNativeHost | Chrome 原生消息宿主 |
| 5 | `--computer-use-mcp` | computerUse/mcpServer | 计算机使用 MCP（feature 门控） |
| 6 | `--daemon-worker` | workerRegistry | 守护进程工作者（性能敏感） |
| 7 | `remote-control`/`rc`/`bridge` | bridgeEnabled, bridgeMain | 远程控制/桥接模式 |
| 8 | `daemon` | daemon/main | 守护进程主管 |
| 9 | `ps`/`logs`/`attach`/`kill`/`--bg` | cli/bg | 后台会话管理 |
| 10 | `new`/`list`/`reply` | cli/handlers/templateJobs | 模板作业命令 |
| 11 | `environment-runner` | environment-runner/main | BYOC 运行器 |
| 12 | `self-hosted-runner` | self-hosted-runner/main | 自托管运行器 |
| 13 | `--tmux --worktree` | worktree | tmux worktree 快速路径 |
| 14 | `--update`/`--upgrade` | *(重写 argv)* | 重定向到 update 子命令 |
| 15 | `--bare` | *(设置环境变量)* | 设置 `CLAUDE_CODE_SIMPLE=1` |

#### --version 快速路径（零导入典范）

```typescript
// src/entrypoints/cli.tsx:37-42
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
  console.log(`${MACRO.VERSION} (Claude Code)`);
  return;  // 结束。零模块加载。
}
```

`MACRO.VERSION` 是构建时内联的常量，不需要任何 import。这意味着 `claude --version` 的延迟可能只有几毫秒。

#### --daemon-worker 快速路径（性能敏感设计）

```typescript
// src/entrypoints/cli.tsx:100-106
if (feature('DAEMON') && args[0] === '--daemon-worker') {
  const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
  await runDaemonWorker(args[1]);
  return;
}
```

注意注释中的关键设计决策：

> Must come before the daemon subcommand check: spawned per-worker, so perf-sensitive.
> No enableConfigs(), no analytics sinks at this layer — workers are lean.

守护进程工作者是由主管进程频繁创建的，所以它跳过了配置加载和分析追踪——只做最少的事情。

#### bridge 快速路径（带认证检查）

```typescript
// src/entrypoints/cli.tsx:112-161
if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || ...)) {
  const { enableConfigs } = await import('../utils/config.js');
  enableConfigs();

  // 必须在 GrowthBook 门控检查之前进行认证——无认证时 GB 无用户上下文
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js');
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    exitWithError(BRIDGE_LOGIN_ERROR);
  }

  const disabledReason = await getBridgeDisabledReason();
  if (disabledReason) exitWithError(`Error: ${disabledReason}`);

  // 策略检查：企业可能禁止远程控制
  await waitForPolicyLimitsToLoad();
  if (!isPolicyAllowed('allow_remote_control')) {
    exitWithError("Remote Control is disabled by your organization's policy.");
  }

  await bridgeMain(args.slice(1));
  return;
}
```

这是一个"中等复杂度"的快速路径——需要认证和策略检查，但仍然不加载完整 CLI。

#### 进入完整 CLI

如果没有命中任何快速路径：

```typescript
// src/entrypoints/cli.tsx:288-299
// 开始捕获早期输入（用户可能在启动期间就开始打字）
const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
startCapturingEarlyInput();

profileCheckpoint('cli_before_main_import');
const { main: cliMain } = await import('../main.js');
profileCheckpoint('cli_after_main_import');

await cliMain();
profileCheckpoint('cli_after_main_complete');
```

注意 `startCapturingEarlyInput()` —— 这是一个用户体验优化。在 `main.tsx` 的 135ms+ 导入时间里，用户可能已经开始打字。这个函数缓存这些早期输入，后续注入到 REPL 中。

### 子问题 3：main.tsx 的启动序列

文件位置：`src/main.tsx`（约 4500 行）

`main.tsx` 是 Claude Code 最大的文件之一。它的复杂性来自需要处理的初始化步骤之多。

#### 模块级副作用（import 时执行）

```typescript
// src/main.tsx:1-20（简化）
import { profileCheckpoint } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');         // ① 标记入口

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();                           // ② 启动 MDM 子进程（并行读取）

import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();                     // ③ 预取钥匙串（macOS OAuth + API key）
```

这三步**必须在所有其他导入之前运行**，原因写在注释中：

1. `profileCheckpoint` 在重量级模块加载前打点，测量真实的导入耗时
2. `startMdmRawRead` 启动 `plutil`/`reg query` 子进程，与后续 ~135ms 的导入并行
3. `startKeychainPrefetch` 预取两个钥匙串条目，避免后续同步读取阻塞 ~65ms

```typescript
// src/main.tsx:209
profileCheckpoint('main_tsx_imports_loaded');  // ④ 所有导入完成
```

从 `main_tsx_entry` 到 `main_tsx_imports_loaded` 之间大约 135ms——这是模块加载的代价。

#### main() 函数

```typescript
// src/main.tsx:585-607
export async function main() {
  profileCheckpoint('main_function_start');

  // 安全：防止 Windows PATH 劫持
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // 初始化警告处理器
  initializeWarningHandler();

  // 注册退出/信号处理
  process.on('exit', () => resetCursor());
  process.on('SIGINT', () => {
    // print 模式有自己的 SIGINT 处理器
    if (process.argv.includes('-p') || process.argv.includes('--print')) return;
    process.exit(0);
  });

  profileCheckpoint('main_warning_handler_initialized');
  // ...调用 run()
}
```

#### run() 函数和 Commander.js 设置

```typescript
// src/main.tsx:884-903
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  const program = new CommanderCommand()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions();

  profileCheckpoint('run_commander_initialized');
```

#### preAction Hook —— 全局初始化

Commander.js 的 `preAction` hook 在任何命令执行前触发：

```typescript
// src/main.tsx:907-967
program.hook('preAction', async thisCommand => {
  profileCheckpoint('preAction_start');

  // ① 等待 MDM 和钥匙串预取完成
  await Promise.all([
    ensureMdmSettingsLoaded(),
    ensureKeychainPrefetchCompleted()
  ]);
  profileCheckpoint('preAction_after_mdm');

  // ② 核心初始化（配置、认证、环境变量）
  await init();
  profileCheckpoint('preAction_after_init');

  // ③ 设置进程标题
  process.title = 'claude';

  // ④ 初始化日志/分析 sinks
  const { initSinks } = await import('./utils/sinks.js');
  initSinks();
  profileCheckpoint('preAction_after_sinks');

  // ⑤ 处理 --plugin-dir 选项
  const pluginDir = thisCommand.getOptionValue('pluginDir');
  if (Array.isArray(pluginDir) && pluginDir.length > 0) {
    setInlinePlugins(pluginDir);
    clearPluginCache('preAction: --plugin-dir inline plugins');
  }

  // ⑥ 运行数据库迁移
  runMigrations();
  profileCheckpoint('preAction_after_migrations');

  // ⑦ 加载远程托管设置和策略限制（异步、非阻塞）
  void loadRemoteManagedSettings();
  void loadPolicyLimits();
  profileCheckpoint('preAction_after_remote_settings');

  // ⑧ 设置同步
  if (feature('UPLOAD_USER_SETTINGS')) {
    void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
  }
  profileCheckpoint('preAction_after_settings_sync');
});
```

注意 `void` 前缀——这些是 fire-and-forget 操作，不阻塞启动。

#### 50+ 全局选项

`main.tsx` 定义了大量 CLI 选项。以下是完整分类：

```typescript
// src/main.tsx:968-1006（大量链式 .option() 调用）
program
  .name('claude')
  .argument('[prompt]', 'Your prompt')
```

**调试/输出选项**：
- `-d, --debug [filter]` — 调试模式，可选类别过滤
- `--debug-to-stderr` — 调试输出到 stderr
- `--debug-file <path>` — 调试日志写入文件
- `--verbose` — 详细模式

**运行模式选项**：
- `-p, --print` — 非交互打印模式
- `--bare` — 最小模式（跳过 hooks/LSP/plugins 等）
- `--init` / `--init-only` / `--maintenance` — Setup hook 触发模式
- `--output-format <format>` — 输出格式（text/json/stream-json）
- `--input-format <format>` — 输入格式（text/stream-json）

**安全/权限选项**：
- `--dangerously-skip-permissions` — 跳过所有权限检查
- `--allow-dangerously-skip-permissions` — 允许跳过权限（不自动启用）
- `--permission-mode <mode>` — 权限模式
- `--permission-prompt-tool <tool>` — MCP 权限提示工具
- `--allowedTools <tools...>` — 允许的工具列表
- `--disallowedTools <tools...>` — 禁止的工具列表

**模型/推理选项**：
- `--model <model>` — 会话模型
- `--thinking <mode>` — 思考模式（enabled/adaptive/disabled）
- `--max-thinking-tokens <n>` — 最大思考 token 数
- `--effort <level>` — 努力级别（low/medium/high/max）
- `--fallback-model <model>` — 备用模型
- `--betas <betas...>` — API Beta 头

**会话管理选项**：
- `-c, --continue` — 继续最近对话
- `-r, --resume [value]` — 恢复指定会话
- `--fork-session` — Fork 会话而非复用
- `--session-id <uuid>` — 指定会话 ID
- `-n, --name <name>` — 会话名称
- `--no-session-persistence` — 禁用会话持久化
- `--from-pr [value]` — 从 PR 恢复会话

**预算/限制选项**：
- `--max-turns <n>` — 最大轮次
- `--max-budget-usd <amount>` — 最大 API 花费
- `--task-budget <tokens>` — API 任务预算

**扩展/集成选项**：
- `--mcp-config <configs...>` — MCP 服务器配置
- `--strict-mcp-config` — 仅使用指定的 MCP 配置
- `--system-prompt <prompt>` — 自定义系统提示
- `--append-system-prompt <prompt>` — 追加系统提示
- `--agents <json>` — 自定义 Agent 定义
- `--add-dir <dirs...>` — 额外工作目录
- `--plugin-dir <path>` — 插件目录
- `--settings <file>` — 额外设置文件
- `--ide` — 自动连接 IDE
- `--chrome` / `--no-chrome` — Chrome 集成
- `--tools <tools...>` — 指定可用工具集
- `--file <specs...>` — 启动时下载文件

#### action handler —— 核心启动序列

当用户运行默认命令（没有子命令）时，执行 `.action()` 回调。这是 Claude Code 最长的函数之一：

```typescript
// src/main.tsx:1006-3870（简化为关键步骤）
.action(async (prompt, options) => {
  profileCheckpoint('action_handler_start');
```

以下是完整的启动序列（按 profileCheckpoint 排列）：

```
action_handler_start
  │
  ├── 1. --bare 模式检查，设置 CLAUDE_CODE_SIMPLE
  ├── 2. 特殊 prompt 处理（"code" → undefined）
  ├── 3. Assistant/Kairos 模式初始化
  ├── 4. 解构所有选项（debug, model, tools, mcp...）
  │
  ├── 5. 输入提示处理（stdin 管道数据拼接）
  │      profileCheckpoint('action_after_input_prompt')
  │
  ├── 6. 加载工具集
  │      profileCheckpoint('action_tools_loaded')
  │
  ├── 7. 运行 setup()（认证、初始化、插件...）
  │      profileCheckpoint('action_before_setup')
  │      profileCheckpoint('action_after_setup')
  │
  ├── 8. 加载命令
  │      profileCheckpoint('action_commands_loaded')
  │
  ├── 9. MCP 配置加载和解析
  │      profileCheckpoint('action_mcp_configs_loaded')
  │
  ├── 10. 插件初始化
  │       profileCheckpoint('action_after_plugins_init')
  │
  ├── 11. 认证验证
  │       profileCheckpoint('before_validateForceLoginOrg')
  │
  ├── 12. MCP 服务器连接
  │       profileCheckpoint('before_connectMcp')
  │       profileCheckpoint('after_connectMcp')
  │
  ├── 13. Claude.ai MCP 配置获取
  │       profileCheckpoint('after_connectMcp_claudeai')
  │
  ├── 14. 权限初始化（mode、rules、auto mode...）
  │
  ├── 15. 模型解析和验证
  │
  ├── 16. 会话创建/恢复
  │
  ├── 17. Hook 处理（SessionStart 等）
  │       profileCheckpoint('action_after_hooks')
  │
  └── 18. REPL 渲染
          launchRepl(root, {...}, renderAndRun)
```

#### REPL 渲染——启动的终点

```typescript
// src/main.tsx:3176-3191（典型的交互式启动路径）
await launchRepl(root, {
  getFpsMetrics,
  stats,
  initialState
}, {
  debug: debug || debugToStderr,
  commands,
  initialTools: tools,
  initialMessages: resumeMessages,
  mcpClients: [],
  autoConnectIdeFlag: ide,
  mainThreadAgentDefinition,
  disableSlashCommands,
  thinkingConfig
}, renderAndRun);
```

`launchRepl` 启动 React/Ink 渲染循环。`REPL.tsx` 接管后，用户看到提示符，可以开始输入。

### 子问题 4：profileCheckpoint 测量了什么？

`profileCheckpoint` 是一个轻量级的性能打点工具。以下是从 cli.tsx 到 action handler 的完整检查点列表：

```
时间线：
─────────────────────────────────────────────────────────
cli_entry                          # cli.tsx 入口
cli_before_main_import             # main.tsx import 前
cli_after_main_import              # main.tsx import 后（~135ms gap）
main_tsx_entry                     # main.tsx 模块开始加载
main_tsx_imports_loaded            # main.tsx 所有导入完成
main_function_start                # main() 开始
main_warning_handler_initialized   # 警告处理器就绪
main_client_type_determined        # 客户端类型确定
main_before_run                    # run() 前
run_function_start                 # run() 开始
run_commander_initialized          # Commander 实例化
preAction_start                    # preAction hook 开始
preAction_after_mdm                # MDM 加载完成
preAction_after_init               # init() 完成
preAction_after_sinks              # 日志 sinks 就绪
preAction_after_migrations         # 迁移完成
preAction_after_remote_settings    # 远程设置加载
preAction_after_settings_sync      # 设置同步
run_main_options_built             # 所有选项定义完成
run_before_parse                   # 解析前
run_after_parse                    # 解析后
action_handler_start               # action handler 开始
action_after_input_prompt          # 输入处理完成
action_tools_loaded                # 工具加载完成
action_before_setup                # setup() 前
action_after_setup                 # setup() 后
action_commands_loaded             # 命令加载完成
action_mcp_configs_loaded          # MCP 配置完成
action_after_plugins_init          # 插件初始化完成
before_connectMcp                  # MCP 连接前
after_connectMcp                   # MCP 连接后
action_after_hooks                 # Hooks 处理完成
─────────────────────────────────────────────────────────
                                     REPL 就绪 ✓
```

---

## 源码对照

### 完整启动路径追踪

让我们跟踪一次典型的 `claude "hello"` 启动：

```
$ claude "hello"
    │
    ▼
[Node.js 加载 cli.tsx]
    │
    ▼ src/entrypoints/cli.tsx:33
async function main() {
  const args = ['hello']  // process.argv.slice(2)

  // --version? NO
  // --dump-system-prompt? NO
  // --chrome-mcp? NO
  // --daemon-worker? NO
  // bridge? NO
  // daemon? NO
  // ps/logs/attach/kill/--bg? NO
  // templates? NO
  // environment-runner? NO
  // self-hosted-runner? NO
  // --tmux --worktree? NO
  // --update/--upgrade? NO
  // --bare? NO

  // 没有快速路径命中 → 加载完整 CLI
    │
    ▼ src/entrypoints/cli.tsx:288-298
  startCapturingEarlyInput()
  const { main: cliMain } = await import('../main.js')
  await cliMain()
    │
    ▼ src/main.tsx:585
  main()
    │
    ▼ src/main.tsx:884
  run()
    │
    ▼ Commander.js 解析 → .action() 回调
    │
    ▼ src/main.tsx:1007
  action('hello', options)
    │ ... 3000+ 行初始化 ...
    ▼
  launchRepl(root, config, renderAndRun)
}
```

### 延迟导入的实际效果

`cli.tsx` 中每个快速路径都用 `await import()` 而非顶层 `import`：

```typescript
// 顶层 import（如果这样写）
import { bridgeMain } from '../bridge/bridgeMain.js'  // 始终加载
import { daemonMain } from '../daemon/main.js'         // 始终加载
import { bgHandler } from '../cli/bg.js'               // 始终加载
// = 启动时加载所有模块的依赖树 = 慢

// 实际的动态 import（cli.tsx 的做法）
if (args[0] === 'daemon') {
  const { daemonMain } = await import('../daemon/main.js')  // 只在需要时加载
  await daemonMain(args.slice(1))
  return
}
// = 只加载命中路径的依赖 = 快
```

### 迁移系统

```typescript
// src/main.tsx:325-348
const CURRENT_MIGRATION_VERSION = 11;

function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    // ...
    saveGlobalConfig(prev => ({
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    }));
  }
}
```

每次模型更新或配置格式变更，都需要添加迁移。版本号 `CURRENT_MIGRATION_VERSION = 11` 说明已经经历了 11 次迁移。注释 `@[MODEL LAUNCH]` 提示开发者在模型发布时检查是否需要新迁移。

---

## 设计动机分析

### 为什么分离 cli.tsx 和 main.tsx？

核心原因：**模块加载成本**。

`main.tsx` 导入了约 150 个模块，模块加载需要 ~135ms。如果 `--version` 也要经过这些导入，用户体验会很差。

分离后的效果：
- `claude --version` → 0 个额外模块 → ~1ms
- `claude --daemon-worker auth` → 1 个模块 → ~5ms
- `claude "hello"` → 150+ 个模块 → ~500ms+

这种"分层启动"模式在大型 CLI 工具中很常见（Rust 的 cargo、Go 的 go 命令也有类似设计），但 Claude Code 做得更彻底——连 profiler 都是按需加载的。

### 为什么 main.tsx 有模块级副作用？

```typescript
profileCheckpoint('main_tsx_entry');
startMdmRawRead();        // 副作用！
startKeychainPrefetch();  // 副作用！
```

这违反了"导入时不应有副作用"的最佳实践，但有充分理由：

1. **并行化**：MDM 读取和钥匙串预取是 I/O 操作，让它们在模块加载期间并行运行，可以隐藏 ~65ms 的延迟
2. **时机关键**：如果等到 `main()` 函数内再启动，就错过了与 135ms 导入并行的窗口
3. **注释充分**：代码中有详细注释解释为什么需要这些副作用

### 为什么 preAction 而非在 main() 中初始化？

Commander.js 的 `preAction` hook 只在**执行命令时**触发，不在**显示帮助时**触发。这意味着：

```bash
claude --help    # 不触发 preAction → 不执行 init() → 不连接认证 → 快速
claude "hello"   # 触发 preAction → 完整初始化 → 正常启动
```

这是另一个启动优化：帮助信息不需要认证、MCP 连接、迁移等。

### 为什么有那么多 `void` 调用？

```typescript
void loadRemoteManagedSettings();   // fire-and-forget
void loadPolicyLimits();            // fire-and-forget
```

`void` 前缀表示这些 Promise 被有意丢弃。它们在后台运行，通过热重载机制在就绪时生效。这允许 CLI 不等待网络请求就继续启动。

---

## 启发与超越

### 启发 1：启动优化是分形的

Claude Code 的启动优化层层嵌套：
- 进程级：cli.tsx vs main.tsx 分离
- 模块级：动态 import vs 静态 import
- 函数级：preAction hook vs main()
- I/O 级：并行预取（MDM、钥匙串）
- 异步级：fire-and-forget 后台加载

每一层都在回答同一个问题："这个操作必须在用户看到提示符之前完成吗？"

### 启发 2：profileCheckpoint 是调试基础设施

39 个检查点不是事后添加的——它们是设计过程的一部分。当启动变慢时，这些检查点能精确定位瓶颈在哪两个点之间。这是 **可观察性优先**的开发方法。

### 启发 3：CLI 分派是一种策略模式

`cli.tsx` 本质上是一个策略分派器。每个快速路径是一个"策略"，根据参数选择最轻量的执行路径。这种模式可以推广到任何多入口应用。

### 启发 4：迁移系统对于长生命周期产品是必需的

`CURRENT_MIGRATION_VERSION = 11` 说明即使在快速迭代的 AI 产品中，数据迁移也是不可避免的。特别是模型名称变更（sonnet1m → sonnet45 → sonnet46）频繁发生，需要自动迁移用户配置。

---

## 延伸阅读

- **Agent 定义**：`learn/01-agent-anatomy/01-what-is-coding-agent.md` — 什么是编码代理
- **主循环设计**：`learn/01-agent-anatomy/03-main-loop-design.md` — queryLoop 深度分析
- **源码文件**：
  - `src/entrypoints/cli.tsx` — Bootstrap 入口（~300 行）
  - `src/main.tsx` — 完整 CLI 初始化（~4500 行）
  - `src/entrypoints/init.ts` — 核心初始化函数
  - `src/setup.ts` — Setup 阶段（认证、环境）
  - `src/replLauncher.tsx` — REPL 启动器
  - `src/screens/REPL.tsx` — REPL 主屏幕（React 组件）
  - `src/utils/startupProfiler.ts` — 启动性能分析
  - `src/utils/earlyInput.ts` — 早期输入捕获
