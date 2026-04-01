# Q: Claude Code 最核心的 10 个架构决策是什么？

> **核心问题**：每个架构决策都是一次 trade-off。Claude Code 在 TypeScript 语言、AsyncGenerator 主循环、终端 React、接口驱动工具等 10 个关键节点上做了什么选择？为什么？有哪些替代方案？代价是什么？

---

## 决策 1：TypeScript over Rust/Go/Python

### 选择

用 TypeScript (Node.js) 作为唯一开发语言。

### 解决的问题

AI 编码代理需要同时处理：UI 渲染、异步 I/O、JSON 操作、动态工具注册。

### 替代方案分析

| 语言 | 优势 | 劣势 |
|------|------|------|
| **TypeScript** ✅ | 类型安全 + 动态性；npm 生态巨大；React 可用于终端 UI；JSON 原生支持 | 启动慢（Node.js 冷启动）；单线程；内存占用高 |
| **Rust** | 极致性能和内存安全；编译为单二进制；启动快 | 开发效率低；动态工具注册困难；UI 框架不成熟 |
| **Go** | 编译快；并发原生支持；单二进制分发 | 泛型弱；没有 React 级别的 UI 框架；JSON 操作啰嗦 |
| **Python** | AI/ML 生态最好；开发最快；库最多 | 性能差；类型系统弱；打包分发困难；GIL 并发限制 |

### Trade-off

```
选择 TypeScript 获得了:
✅ React-in-Terminal (Ink) — 唯一成熟方案
✅ npm 分发 — 一条命令安装
✅ 类型安全 — 大规模代码库可维护
✅ 异步 I/O — async/await + Stream 原生支持
✅ JSON 操作 — LLM API 的核心数据格式

付出的代价:
❌ 启动时间 ~1-3 秒 (Rust: ~50ms)
❌ 内存基线 ~150MB (Rust: ~20MB)
❌ 单线程限制 (Rust/Go: 真并行)
❌ 运行时依赖 Node.js ≥ 18
```

**结论**：对于**开发速度 > 运行时性能**的 CLI 工具，TypeScript 是最佳平衡点。Agent 的瓶颈在 LLM API 延迟（200-2000ms），不在本地计算。

---

## 决策 2：AsyncGenerator 作为主循环

### 选择

`query()` 函数返回 `AsyncGenerator`，通过 `yield*` 流式产出事件。

> **源码引用**：`src/query.ts:219-251`

```typescript
export async function* query(params: QueryParams): AsyncGenerator<
  StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
> {
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  return terminal
}
```

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **AsyncGenerator** ✅ | 原生背压；语义清晰；状态保持 | 调试困难；错误栈不直观 |
| **Callback** | 简单、直接 | 回调地狱；难以维护 |
| **EventEmitter** | Node.js 原生；解耦 | 无类型安全；无背压；事件顺序不确定 |
| **RxJS Observable** | 丰富的操作符；组合能力强 | 学习曲线高；bundle 大；概念重 |
| **Async Iterator (no generator)** | 接口更简单 | 无法暂停/恢复；无内部状态 |

### Trade-off

```
获得了:
✅ 流式中间结果 — 工具进度、部分响应即时产出
✅ 原生背压 — 消费者慢时自动暂停生产
✅ 跨迭代状态 — turnCount, messages, toolUseContext 自然保持
✅ 可组合 — yield* 委托到子 generator

付出了:
❌ 调试困难 — 错误栈中 generator 帧不直观
❌ 无法取消 — 需要额外的 AbortController 机制
❌ 认知成本 — 团队需理解 generator 协议
```

---

## 决策 3：React in Terminal（自定义 Ink Fork）

### 选择

Fork 了 Ink（React 终端渲染器），维护自定义版本（96 文件，19,842 行）。

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **自定义 Ink fork** ✅ | 完全控制；可加主题/点击/焦点 | 19K LOC 维护成本 |
| **原版 Ink** | 社区维护 | 不再活跃维护；缺少需要的特性 |
| **blessed / blessed-contrib** | 功能丰富 | 已废弃；API 过时 |
| **纯 ANSI 手写** | 零依赖；极致轻量 | 开发效率极低；难以维护复杂 UI |
| **Web UI (Electron)** | 完整的 Web 能力 | 安装大；启动慢；与终端工作流不兼容 |

### Trade-off

```
获得了:
✅ 组件化 UI — 144+ React 组件
✅ Flexbox 布局 — Yoga 引擎，复杂布局简单表达
✅ 主题系统 — 全局 ThemeProvider
✅ 自定义事件 — 点击、焦点、终端视口感知
✅ React 生态 — hooks、Suspense、ErrorBoundary

付出了:
❌ 19,842 行 fork 代码的维护负担
❌ 终端 I/O 解析器（9 文件）的领域复杂性
❌ 无法享受 Ink 上游更新
❌ 98KB 的 App.tsx (复杂度集中)
```

**结论**：对于需要丰富终端 UI 的应用，React 组件模型的开发效率远超手写 ANSI。Fork 的维护成本是为此付出的代价。

---

## 决策 4：接口驱动工具（不是类）

### 选择

工具系统基于 TypeScript 接口（structural typing），不使用类继承。

> **源码引用**：`src/Tool.ts`（792 行）

```typescript
export type Tool<Input, Output, P> = {
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  checkPermissions(input, context): Promise<PermissionResult>
  readonly name: string
  readonly inputSchema: Input
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  // ... 20+ 其他属性
}
```

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **Interface (structural)** ✅ | Tree-shaking 友好；MCP 动态创建；组合灵活 | 无继承复用 |
| **Abstract Class** | 共享逻辑；模板方法模式 | Tree-shaking 困难；构造函数耦合 |
| **Decorator Pattern** | 声明式配置 | TypeScript decorator 不稳定 |
| **Plugin Registry** | 运行时注册/注销 | 类型安全弱 |

### Trade-off

```
获得了:
✅ 编译时 tree-shaking — feature() 关闭的工具代码完全移除
✅ MCP 兼容 — 动态创建的 MCP 工具无需继承基类
✅ 灵活组合 — assembleToolPool() 简单合并不同来源的工具
✅ 延迟加载 — require() 条件加载不需要类构造器

付出了:
❌ 工具间无共享逻辑 — 相似的 checkPermissions 逻辑可能重复
❌ 接口膨胀 — Tool 类型有 20+ 属性，新工具实现成本高
❌ 运行时检查弱 — 接口在编译后消失，运行时无法验证
```

---

## 决策 5：7 层权限系统

### 选择

不用简单的 allow/deny，而是 7 层递进式权限检查。

### 层级

```
Layer 1: Deny Rules (工具黑名单 — 完全禁止)
Layer 2: Tool Permission Check (工具自检 — 破坏性判断)
Layer 3: Permission Mode (用户模式 — default/acceptEdits/bypass)
Layer 4: Settings Rules (配置文件规则 — .claude.toml)
Layer 5: YOLO Classifier (AI 分类器 — 自动判断安全性)
Layer 6: User Prompt (交互确认 — 终端弹窗)
Layer 7: Session Memory (会话记忆 — 记住已允许的操作)
```

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **7 层系统** ✅ | 精细控制；渐进式；安全默认 | 复杂；调试难 |
| **简单 allow/deny** | 简单明了 | 不够灵活；无法适配不同场景 |
| **RBAC** | 成熟的模型 | 对终端 CLI 过度设计 |
| **Sandbox** | 物理隔离 | 限制太多；影响工具能力 |

### Trade-off

```
获得了:
✅ 安全默认 — 新工具自动需要权限确认
✅ 渐进信任 — 用户可以逐步放松限制
✅ AI 辅助 — YOLO 分类器减少确认频率
✅ 可配置 — 团队级配置文件覆盖

付出了:
❌ 24+ 权限相关文件，复杂度高
❌ 权限判断路径难以调试
❌ 不同层之间可能产生意外交互
```

---

## 决策 6：JSONL over SQLite（持久化）

### 选择

会话消息和历史使用 JSONL（一行一 JSON）格式存储。

> **源码引用**：`src/history.ts`

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **JSONL** ✅ | Append-only；流式友好；单行容错 | 查询慢；无索引；无关系 |
| **SQLite** | 完整 SQL；并发安全；压缩 | 写放大；二进制格式；WAL 复杂 |
| **LevelDB** | 高写入性能；有序键 | 无 SQL；调试困难 |
| **内存 + 快照** | 极快；灵活 | 崩溃丢失数据 |

### Trade-off

```
获得了:
✅ Append-only 写入 — 无 read-modify-write，并发安全
✅ 流式处理 — 可从尾部读取最新消息
✅ 单行容错 — 一行损坏不影响其余数据
✅ 人类可读 — 直接 cat/grep 调试
✅ 零依赖 — 不需要 SQLite native 模块

付出了:
❌ 复杂查询需要全表扫描
❌ 无法高效更新已有记录
❌ 大型会话文件会变慢
❌ 大内容需要外部存储（paste store hash 策略）
```

**结论**：对于消息日志场景，JSONL 的简单性和容错性比 SQLite 的查询能力更重要。

---

## 决策 7：自定义 Store over Redux

### 选择

35 行代码实现自定义 Store，而非使用 Redux。

> **源码引用**：`src/state/store.ts`（35 行）

```typescript
export function createStore<T>(initialState: T, onChange?): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state)
      if (Object.is(next, state)) return
      state = next
      onChange?.({ newState: next, oldState: state })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **自定义 Store** ✅ | 35 行；零依赖；完全可控 | 无中间件；无 devtools |
| **Redux** | 成熟；时间旅行调试；大生态 | 样板代码多；action/reducer 模式重 |
| **Zustand** | 简洁 API；中间件支持 | 额外依赖 |
| **Jotai/Recoil** | 原子级状态；React 集成好 | 概念新；不适合非 React 场景 |

### Trade-off

```
获得了:
✅ 极简 — 35 行完整实现
✅ 零 bundle 影响
✅ 类型安全 — 泛型精确捕获状态类型
✅ 直接 — 无 action type、reducer、dispatch 概念
✅ DeepImmutable 类型限制 — 通过类型系统强制不可变

付出了:
❌ 无时间旅行调试
❌ 无中间件机制
❌ 无 Redux DevTools 集成
❌ 状态变更无结构化日志
```

**结论**：Agent 会话是瞬时的交互过程，不需要时间旅行调试。35 行 Store 的简单性远超 Redux 的功能性。

---

## 决策 8：MCP 作为扩展性基础

### 选择

采用 Model Context Protocol (MCP) 作为工具扩展的标准接口。

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **MCP** ✅ | 开放标准；8 种传输；跨平台 | 协议复杂；性能开销 |
| **自定义插件 API** | 完全适配需求 | 生态隔离；维护成本 |
| **gRPC** | 高性能；强类型 | 需要 protobuf 工具链 |
| **REST Webhook** | 简单；广泛理解 | 无法流式；无状态 |

### Trade-off

```
获得了:
✅ 标准化 — 其他 AI 工具可以复用同一个 MCP Server
✅ 8 种传输 — stdio, HTTP SSE, Streamable HTTP, WebSocket...
✅ 动态发现 — 运行时枚举可用工具和资源
✅ OAuth 认证 — 安全的第三方服务集成

付出了:
❌ 协议抽象增加延迟（序列化/反序列化）
❌ MCP Client 代码量大（3500+ 行）
❌ 调试比直接函数调用困难
❌ 版本兼容性维护
```

---

## 决策 9：编译时 Feature Flag

### 选择

使用 Bun 内建的 `feature()` 函数实现编译时 feature flag，86 个 flag 控制不同功能。

> 详见 [02-feature-flags.md](/12-infrastructure/02-feature-flags)

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **编译时 feature()** ✅ | DCE 移除未用代码；代码不泄漏 | 需重新构建才能切换 |
| **运行时 flag（LaunchDarkly）** | 即时切换；A/B 测试 | 代码在 bundle 中 |
| **环境变量** | 简单；运行时可改 | 无 DCE；代码可逆向 |
| **Git 分支** | 完全隔离 | 合并噩梦 |

### Trade-off

```
获得了:
✅ 代码安全 — 外部版本不包含内部功能代码
✅ Bundle 小 — DCE 可能减少 30-50% 代码
✅ 单代码库 — 内部/外部版本从同一源码构建
✅ 86 个功能独立控制

付出了:
❌ 切换 flag 需要重新构建
❌ 无法运行时 A/B 测试
❌ 86 个 flag 的组合爆炸风险
❌ 构建系统复杂度增加
```

---

## 决策 10：Coordinator Pattern（多 Agent 编排）

### 选择

使用专门的 Coordinator Agent 编排多个 Worker Agent，而非对等网络。

> **源码引用**：`src/coordinator/coordinatorMode.ts`

### 替代方案

| 方案 | 优势 | 劣势 |
|------|------|------|
| **Coordinator → Workers** ✅ | 集中控制；简单路由；易调试 | 单点瓶颈 |
| **对等网络 (P2P)** | 无单点故障；去中心化 | 共识难；调试难 |
| **消息队列 (MQ)** | 解耦；可靠交付 | 基础设施重 |
| **Actor Model** | 天然并发；容错 | 概念复杂；状态管理难 |

### Trade-off

```
获得了:
✅ 简单的任务分配 — Coordinator 知道所有 Worker 状态
✅ 上下文聚合 — 单点汇总所有 Worker 结果
✅ 可控通信 — Worker 只与 Coordinator 交互
✅ Git Worktree 隔离 — 每个 Worker 独立工作树

付出了:
❌ Coordinator 是瓶颈 — 所有通信经过它
❌ 扩展性受限 — Worker 数量受 Coordinator 上下文窗口限制
❌ 单点故障 — Coordinator 崩溃影响所有 Worker
```

**设计原则**（`coordinatorMode.ts:126`）：
> "Every message you send is to the user. Worker results are internal signals—never thank or acknowledge them."

---

## 综合分析：决策之间的相互影响

```
TypeScript (决策1)
  │
  ├─→ React in Terminal (决策3) — 唯一可能的语言
  ├─→ AsyncGenerator (决策2) — TS 原生支持
  ├─→ 接口驱动工具 (决策4) — structural typing 的优势
  └─→ 自定义 Store (决策7) — 泛型 + Set 实现简单

编译时 Feature Flag (决策9)
  │
  ├─→ 接口驱动工具 (决策4) — tree-shaking 友好
  └─→ 构建系统 — esbuild DCE 依赖

MCP (决策8)
  │
  ├─→ 接口驱动工具 (决策4) — 动态工具注册
  └─→ Coordinator (决策10) — Worker 可使用 MCP 工具

JSONL (决策6)
  │
  └─→ 会话恢复 — 容错的 append-only 日志
```

**最关键的决策**：TypeScript (决策1)。它决定了几乎所有其他选择——React Terminal、AsyncGenerator、接口驱动工具系统都依赖于 TypeScript/Node.js 生态。

---

## 启发：如何做你的架构决策

1. **识别约束**：Claude Code 的关键约束是"需要丰富终端 UI"→ 这直接导致选择 TypeScript + React
2. **从瓶颈出发**：Agent 的瓶颈在 API 延迟，不在本地计算 → 语言性能不是首要考虑
3. **简单性 > 功能性**：35 行 Store vs Redux；JSONL vs SQLite
4. **安全性是硬约束**：权限系统的复杂度是"不能妥协"的，即使增加维护成本
5. **预留扩展点**：MCP、feature flag、接口驱动工具都是为未来扩展预留的基础设施
