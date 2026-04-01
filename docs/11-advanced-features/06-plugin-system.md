# Q: 如何设计一个插件系统让第三方扩展 Agent？

## 一句话回答

Claude Code 的插件系统采用声明式清单 (`plugin.json`) + 多扩展点架构，插件可以添加命令、技能、Agent、钩子、MCP 服务器和 LSP 服务器，通过多层级配置范围和策略管控实现安全的第三方扩展。

---

## 1. 插件系统架构

### 1.1 整体结构

```
┌──────────────────────────────────────────────────┐
│                 Plugin System                     │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ 内置插件  │  │ 市场插件  │  │ 会话临时插件  │  │
│  │ (builtin)│  │(marketplace│  │(--plugin-dir) │  │
│  └────┬─────┘  └────┬──────┘  └──────┬────────┘  │
│       │              │               │            │
│       └──────────────┼───────────────┘            │
│                      ▼                            │
│              ┌──────────────┐                     │
│              │  Plugin      │                     │
│              │  Loader      │                     │
│              │  (记忆化)    │                     │
│              └──────┬───────┘                     │
│                     │                             │
│       ┌─────────────┼──────────────┐              │
│       ▼             ▼              ▼              │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Commands │  │  Hooks   │  │MCP/LSP   │        │
│  │ Skills   │  │(59 events│  │Servers   │        │
│  │ Agents   │  │          │  │          │        │
│  └─────────┘  └──────────┘  └──────────┘        │
└──────────────────────────────────────────────────┘
```

## 2. 插件类型定义

### 2.1 BuiltinPluginDefinition — 内置插件

> 源码: `src/types/plugin.ts:18-35`

```typescript
type BuiltinPluginDefinition = {
  name: string                            // 插件标识符
  description: string                     // UI 显示文本
  version?: string                        // 语义版本
  skills?: BundledSkillDefinition[]       // 内置技能
  hooks?: HooksSettings                   // 生命周期钩子
  mcpServers?: Record<string, McpServerConfig>  // MCP 服务器
  isAvailable?: () => boolean             // 运行时可用性检查
  defaultEnabled?: boolean                // 默认启用（默认 true）
}
```

### 2.2 LoadedPlugin — 运行时表示

> 源码: `src/types/plugin.ts:48-70`

```typescript
type LoadedPlugin = {
  name: string
  manifest: PluginManifest               // 解析的 plugin.json
  path: string                           // 文件路径（或 'builtin' 标记）
  source: string                         // 格式: "{name}@{marketplace}"
  repository: string                     // 仓库标识符
  enabled?: boolean                      // 当前启用状态
  isBuiltin?: boolean                    // 是否内置
  sha?: string                           // Git commit SHA（版本锁定）

  // 扩展点路径
  commandsPath?: string                  // 斜杠命令目录
  commandsPaths?: string[]               // 额外命令路径
  agentsPath?: string                    // AI Agent 目录
  agentsPaths?: string[]                 // 额外 Agent 路径
  skillsPath?: string                    // 技能目录
  skillsPaths?: string[]                 // 额外技能路径
  outputStylesPath?: string              // 输出样式定义
  outputStylesPaths?: string[]           // 额外样式路径

  // 集成配置
  hooksConfig?: HooksSettings            // 钩子配置
  mcpServers?: Record<string, McpServerConfig>   // MCP 服务器
  lspServers?: Record<string, LspServerConfig>   // LSP 服务器
  settings?: Record<string, unknown>     // 插件设置
}
```

### 2.3 PluginManifest — 插件清单

> 源码: `src/utils/plugins/schemas.ts:1653`

```typescript
type PluginManifest = {
  // 核心元数据
  name: string                           // 必须; kebab-case
  version?: string                       // 语义版本
  description?: string                   // 用户描述
  author?: PluginAuthor                  // { name, email?, url? }
  homepage?: string                      // 文档 URL
  repository?: string                    // 源码 URL
  license?: string                       // SPDX 标识符
  keywords?: string[]                    // 发现标签

  // 扩展点
  commands?: string | string[] | Record<string, CommandMetadata>
  agents?: string | string[]
  skills?: string | string[]
  outputStyles?: string | string[]
  hooks?: HooksSettings | string | string[]

  // 服务器集成
  mcpServers?: Record<string, McpServerConfig> | string | string[]
  lspServers?: Record<string, LspServerConfig> | string | string[]
  channels?: PluginManifestChannel[]     // 消息通道

  // 运行时配置
  userConfig?: Record<string, UserConfigOption>  // 配置提示
  settings?: Record<string, unknown>     // 合并到设置

  // 依赖
  dependencies?: DependencyRef[]         // 必需的插件
}
```

---

## 3. 插件目录结构

### 3.1 标准布局

```
my-plugin/
├── plugin.json                 # 清单文件（可选，支持自动发现）
├── commands/                   # 斜杠命令 (*.md 文件)
│   ├── build.md
│   └── deploy.md
├── agents/                     # AI Agent (*.md 文件)
│   └── test-runner.md
├── skills/                     # 可复用技能 (含 SKILL.md 的目录)
│   └── my-skill/
│       └── SKILL.md
├── output-styles/              # 输出格式化
├── hooks/                      # 钩子配置
│   └── hooks.json
├── .mcp.json                   # MCP 服务器配置（可选）
├── .mcpb 或 .dxt               # 二进制 MCP 包
└── .lsp.json                   # LSP 服务器配置（可选）
```

---

## 4. 插件发现与加载

### 4.1 发现来源（优先级）

> 源码: `src/utils/plugins/pluginLoader.ts:10-25`

```
① 市场插件 — 从注册市场解析 (格式: {name}@{marketplace})
② 会话插件 — 通过 --plugin-dir CLI 标志或 SDK 选项
③ 内置插件 — 启动时通过 registerBuiltinPlugin() 注册
```

### 4.2 加载流程 (loadAllPlugins, 记忆化)

```
① 加载插件来源
   ├── 内置插件 (getBuiltinPlugins())
   ├── 市场安装 (installed_plugins_v2.json)
   └── 临时插件 (--plugin-dir)

② 对每个插件加载组件
   ├── 清单解析 + Zod 验证
   ├── 钩子配置 (hooks/hooks.json 或清单)
   ├── MCP 服务器 (合并: .mcp.json < manifest < .mcpb)
   ├── LSP 服务器
   └── 命令/Agent/技能发现

③ 启用/禁用过滤
   ├── 检查用户设置 (enabledPlugins 记录)
   ├── 检查策略黑名单
   └── 分为 enabled 和 disabled 数组

④ 错误收集
   └── 每个组件失败加入 PluginError[] 数组
```

### 4.3 缓存失效触发

- 插件安装/卸载
- 启用/禁用状态变更
- 设置更新
- 市场刷新
- LSP/MCP 配置变更

---

## 5. 插件生命周期

### 5.1 完整生命周期

```
发现 (DISCOVERY)
    │
    ├── 用户操作（安装/启用）
    ├── 市场解析
    └── 策略门控检查
    │
    ▼
安装 (INSTALLATION)
    │
    ├── 下载/克隆到版本化缓存:
    │   ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
    ├── 写入 installed_plugins_v2.json
    └── 清除记忆化缓存
    │
    ▼
加载 (LOADING) — loadAllPlugins()
    │
    ├── 解析 plugin.json 清单
    ├── 加载 MCP 服务器（命名空间隔离: plugin:{name}:{server}）
    ├── 从 hooks/hooks.json + 清单加载钩子
    ├── 注册钩子到 STATE.registeredHooks
    └── 加载命令/Agent/技能
    │
    ▼
执行 (EXECUTION)
    │
    ├── MCP 服务器在启用时自动连接
    ├── 钩子在相关生命周期事件时触发
    ├── 命令/Agent 在 AI 交互中可用
    └── 技能可作为工具定义访问
    │
    ▼
清理 (CLEANUP) — 禁用/卸载时
    │
    ├── 从 enabledPlugins 设置中移除
    ├── 从已注册钩子中注销
    ├── 断开 MCP 服务器
    ├── 从 installed_plugins_v2.json 删除（卸载时）
    └── 可选删除数据目录
```

---

## 6. 扩展点

### 6.1 七大扩展点

| 扩展点 | 来源 | 命名空间 |
|--------|------|----------|
| **Commands** | `commands/` + `manifest.commands` | `{marketplace}:{plugin}:{name}` |
| **Agents** | `agents/` + `manifest.agents` | `{marketplace}:{plugin}:{name}` |
| **Skills** | `skills/` + `manifest.skills` | `{marketplace}:{plugin}:{skill_dir}` |
| **Hooks** | `hooks/hooks.json` + `manifest.hooks` | HooksSettings 对象 |
| **Output Styles** | `output-styles/` + `manifest.outputStyles` | 插件范围内注册 |
| **MCP Servers** | `.mcp.json` + `manifest.mcpServers` + `.mcpb` | `plugin:{name}:{server}` |
| **LSP Servers** | `.lsp.json` + `manifest.lspServers` | `plugin:{name}:{server}` |

### 6.2 钩子事件（59 种）

> 源码: `src/utils/settings/types.ts` → `HooksSettings`

主要事件类别:

| 类别 | 事件示例 |
|------|----------|
| **工具生命周期** | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` |
| **Agent 生命周期** | `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd` |
| **权限** | `PermissionRequest`, `PermissionDenied` |
| **UI 事件** | `Stop`, `StopFailure`, `Notification` |
| **压缩** | `PreCompact`, `PostCompact` |
| **Agent 特定** | `Elicitation`, `ElicitationResult`, `ConfigChange` |
| **文件系统** | `WorktreeCreate`, `WorktreeRemove`, `FileChanged`, `CwdChanged` |

### 6.3 钩子定义格式

```json
{
  "PreToolUse": [
    {
      "matcher": { "toolName": "BashTool" },
      "hooks": [
        {
          "command": "/path/to/script.sh",
          "env": { "VAR": "value" },
          "allowedTools": ["FileReadTool"]
        }
      ]
    }
  ]
}
```

钩子执行特性:
- 在**子进程**中运行（非主进程）
- Stderr 被捕获（避免终端干扰）
- 每个钩子有超时处理
- 环境变量隔离

---

## 7. 配置机制

### 7.1 多范围配置

> 源码: `src/services/plugins/pluginOperations.ts:72-83`

```
优先级（高 → 低）:
  local  (个人项目覆盖, .claude/settings.local.json)
    ↓
  project (共享项目设置, .claude/settings.json)
    ↓
  user   (用户全局, ~/.claude/settings.json)
    ↓
  managed (企业策略 — 只读)
```

### 7.2 启用状态

```typescript
// ~/.claude/settings.json
enabledPlugins: {
  "analytics@official": true,           // 启用
  "linter@official": false,             // 禁用
  "logger@official": ["--verbose"],     // 启用（带参数）
  // undefined = 使用 defaultEnabled 或 true
}
```

### 7.3 插件选项

```typescript
// ~/.claude/settings.json
pluginConfigs: {
  "slack@official": {
    options: {
      api_token: "xoxb-...",  // 敏感 → 存入钥匙串
      workspace: "my-org"     // 普通 → 存入设置
    }
  }
}
```

### 7.4 用户配置提示

```typescript
// plugin.json 中的 userConfig
userConfig: {
  api_key: {
    type: "string",
    title: "API Key",
    description: "Your service API key",
    required: true,
    sensitive: true      // → 存入 macOS 钥匙串
  },
  port: {
    type: "number",
    title: "Port",
    default: 3000,
    min: 1024,
    max: 65535
  }
}
```

变量在服务器配置中可通过 `${user_config.api_key}` 引用。

---

## 8. 安全模型

### 8.1 安全层级

Claude Code 的插件系统**没有原生沙箱**——插件代码以完整 CLI 进程权限运行。安全依赖于多层防护：

```
┌─────────────────────────────────────┐
│ 第 1 层: 策略管控 (Policy)           │
│ 企业管理员可强制禁用特定插件         │
├─────────────────────────────────────┤
│ 第 2 层: 市场仿冒防护               │
│ 阻止冒名顶替官方插件                │
├─────────────────────────────────────┤
│ 第 3 层: 信任对话 (Trust Dialog)     │
│ 首次加载时用户确认                   │
├─────────────────────────────────────┤
│ 第 4 层: 工具级权限                  │
│ Bash/文件操作的权限弹窗              │
├─────────────────────────────────────┤
│ 第 5 层: 进程隔离                    │
│ MCP/LSP 服务器在独立进程中运行       │
└─────────────────────────────────────┘
```

### 8.2 策略管控

> 源码: `src/utils/plugins/pluginPolicy.ts`

```typescript
// 企业策略 — 在 managed 范围只读
policySettings.enabledPlugins[pluginId] === false  // 强制禁用
```

检查点:
- 安装入口
- 启用操作
- UI 过滤器

### 8.3 市场仿冒防护

> 源码: `src/utils/plugins/schemas.ts:71-100`

```typescript
// 阻止冒名顶替的名称模式:
BLOCKED_OFFICIAL_NAME_PATTERN =
  /(?:official[^a-z0-9]*(anthropic|claude)|...)/i

// + 非 ASCII 字符检测（同形攻击）
// + 保留名称白名单（仅限官方 Anthropic 仓库）
```

### 8.4 信任对话

首次加载项目时触发 (`TrustDialog.tsx`)：

```
列出:
  - 项目范围的 MCP 服务器
  - 钩子配置
  - Bash 权限
  - 危险环境变量

用户必须接受后插件才能运行。
```

### 8.5 市场来源验证

```typescript
validateOfficialNameSource(name, source): string | null
// 保留名称 (claude-code-marketplace 等)
// 必须来自官方 GitHub 组织 (anthropics/)
```

---

## 9. 错误处理 (22 种错误类型)

> 源码: `src/types/plugin.ts:101-283`

使用区分联合 (discriminated union) 提供上下文特定的错误数据：

```typescript
type PluginError =
  | { type: 'path-not-found', path, component }
  | { type: 'git-auth-failed', gitUrl, authType }
  | { type: 'git-timeout', operation: 'clone' | 'pull' }
  | { type: 'network-error', url, details? }
  | { type: 'manifest-parse-error', parseError }
  | { type: 'manifest-validation-error', validationErrors: string[] }
  | { type: 'plugin-not-found', pluginId, marketplace }
  | { type: 'marketplace-not-found', availableMarketplaces }
  | { type: 'marketplace-load-failed', reason }
  | { type: 'mcp-config-invalid', serverName, validationError }
  | { type: 'mcp-server-suppressed-duplicate', duplicateOf }
  | { type: 'lsp-config-invalid', serverName, validationError }
  | { type: 'lsp-server-start-failed', serverName, reason }
  | { type: 'lsp-server-crashed', serverName, exitCode }
  | { type: 'hook-load-failed', hookPath, reason }
  | { type: 'component-load-failed', component, path, reason }
  | { type: 'mcpb-download-failed', url, reason }
  | { type: 'mcpb-extract-failed', mcpbPath, reason }
  | { type: 'dependency-unsatisfied', dependency, reason }
  | { type: 'marketplace-blocked-by-policy', blockedByBlocklist? }
  | { type: 'plugin-cache-miss', installPath }
  | { type: 'generic-error', error: string }
```

辅助函数: `getPluginErrorMessage(error)` 用于显示。

---

## 10. 插件 vs MCP vs 直接代码修改

### 10.1 三种扩展方式对比

| 维度 | 插件系统 | MCP 协议 | 直接代码修改 |
|------|----------|----------|-------------|
| **范围** | 本地 CLI 扩展 | 外部工具集成 | 核心功能变更 |
| **发现** | 市场 + 本地目录 | 运行时配置 | N/A |
| **执行** | 进程内 + 子进程 | 仅独立进程 | 进程内 |
| **类型** | 多组件（命令、钩子、技能） | 仅工具 | 任意 |
| **安全** | 策略黑名单 + 信任对话 | 进程隔离 | 完全信任 |
| **版本控制** | Git SHA 锁定 | N/A | 源码版本 |
| **分发** | 市场 | 配置文件 | 源码 |

### 10.2 互补关系

**插件可以声明 MCP 服务器**:

```json
// plugin.json
{
  "mcpServers": {
    "slack": {
      "transport": "stdio",
      "command": "npx",
      "args": ["@anthropic-ai/mcp-server-slack"]
    }
  }
}
```

加载流程:
```
插件清单声明 MCP 服务器
    ↓
loadPluginMcpServers() 提取
    ↓
自动命名空间: plugin:{pluginName}:{serverName}
    ↓
启用时自动连接
```

### 10.3 选择指南

| 需求 | 推荐方式 |
|------|----------|
| 添加新的外部工具 | MCP 服务器 |
| 自定义工作流/命令 | 插件 (commands/skills) |
| 生命周期钩子 | 插件 (hooks) |
| 代码质量检查 | 插件 (LSP 服务器) |
| 核心行为变更 | 直接代码修改 |
| 输出格式定制 | 插件 (output styles) |

---

## 11. 设计分析

### 11.1 声明式清单 vs 命令式 API

选择 `plugin.json` 声明式清单而非命令式 API 的原因：

1. **静态分析**: 不执行代码即可了解插件能力
2. **安全审计**: 可以在加载前检查声明
3. **懒加载**: 只在需要时加载组件
4. **版本兼容**: 清单字段可以渐进式添加
5. **工具友好**: IDE 和市场可以解析 JSON

### 11.2 无沙箱的安全权衡

不做沙箱的原因：跨平台实现复杂度极高、性能开销大、功能受限。替代方案包括策略管控、信任对话、代码审计和 MCP 隔离。终端工具的用户通常是开发者，对安全有基本判断力。

### 11.3 命名空间与多范围配置

MCP 服务器命名 `plugin:{pluginName}:{serverName}` 避免名称冲突，便于追踪来源和批量管理。四层配置（managed/user/project/local）解决不同利益方需求冲突，managed 层保证企业安全策略不被绕过。
