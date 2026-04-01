# 为什么不用 Redux？自定义 Store 的设计考量

> **核心问题**：一个包含 100+ 个字段的复杂状态树，为什么用 34 行代码的自定义 Store 而不是成熟的 Redux 或 Zustand？这个选择背后有什么深层考量？
>

---

## 1. 完整源码：34 行的极简 Store

```typescript
// src/state/store.ts — 完整源码，一行不少

type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return              // 引用相等 → 跳过
      state = next
      onChange?.({ newState: next, oldState: prev })  // 副作用回调
      for (const listener of listeners) listener()    // 通知订阅者
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)         // 返回取消订阅函数
    },
  }
}
```

就这么多。没有 actions，没有 reducers，没有 middleware，没有 devtools。

---

## 2. 逐行设计决策

### 2.1 接口：只有 3 个方法

```typescript
type Store<T> = {
  getState: () => T                              // 读
  setState: (updater: (prev: T) => T) => void    // 写
  subscribe: (listener: Listener) => () => void  // 监听
}
```

**为什么用 updater 函数而不是直接传新状态？**

```typescript
// ❌ 直接传状态的问题
store.setState({ ...store.getState(), count: 1 })
// 在异步场景中，getState() 可能已经过期

// ✅ updater 函数保证原子性
store.setState(prev => ({ ...prev, count: prev.count + 1 }))
// prev 始终是最新状态
```

### 2.2 变化检测：Object.is

```typescript
if (Object.is(next, prev)) return
```

**为什么用 `Object.is` 而不是深比较？**

1. **性能**：`Object.is` 是 O(1)，深比较是 O(n)
2. **语义正确**：强制调用者使用不可变更新（`{ ...prev, field }`）
3. **与 React 一致**：`useSyncExternalStore` 也用 `Object.is`

**后果**：如果 updater 返回同一个引用，所有订阅者都不会被通知。

```typescript
// ✅ 正确：返回新对象
store.setState(prev => ({ ...prev, count: 1 }))

// ⚠️ 无效：返回同一引用
store.setState(prev => {
  prev.count = 1  // 直接修改！
  return prev     // Object.is(prev, prev) === true → 跳过
})
```

### 2.3 副作用回调：onChange

```typescript
onChange?.({ newState: next, oldState: prev })
```

这是整个设计中**最关键的创新**：副作用不是通过 middleware 实现的，而是通过一个简单的回调。

**时机**：在 `state = next` 之后，在 `listener()` 通知之前。这意味着：
- onChange 看到的是**已经确定**的新状态
- onChange 的副作用在**React 重渲染之前**完成

### 2.4 订阅者存储：`Set<Listener>`>`

```typescript
const listeners = new Set<Listener>()
```

**为什么用 Set 而不是 Array？**

| 操作 | Array | Set |
|------|-------|-----|
| 添加 | O(1) push | O(1) add |
| 删除 | O(n) splice | O(1) delete |
| 去重 | 手动检查 | 自动 |
| 遍历 | for...of | for...of |

**关键**：Set 的 delete 是 O(1)，而 Array 的 splice 是 O(n)。在 React 组件频繁 mount/unmount 的场景中，这很重要。

---

## 3. 与 Redux / Zustand 的对比

### 3.1 代码量对比

```
createStore (Claude Code):  35 行
createStore (Redux):       ~500 行（含 middleware 系统）
create (Zustand):          ~300 行（含 React 绑定）
```

### 3.2 概念对比

| 概念 | Redux | Zustand | Claude Code Store |
|------|-------|---------|-------------------|
| **状态更新** | dispatch(action) → reducer | setState(partial) | setState(updater) |
| **副作用** | middleware (thunk/saga) | middleware / subscribe | onChange 回调 |
| **异步** | redux-thunk / redux-saga | 内建 | 不在 Store 中处理 |
| **选择器** | useSelector + reselect | useStore(selector) | useAppState(selector) |
| **React 绑定** | react-redux Provider | 内建 | useSyncExternalStore |
| **DevTools** | Redux DevTools | 内建 | 无 |
| **不可变性** | 约定（或 Immer） | 约定 | `DeepImmutable<T>`>` 类型强制 |
| **TypeScript** | 需要配置 | 良好 | 原生 |
| **依赖** | 3 个包 | 1 个包 | 0 个包 |

### 3.3 Redux 的概念负担

```typescript
// Redux 方式：更新一个计数器需要

// 1. 定义 action type
const INCREMENT = 'INCREMENT'

// 2. 定义 action creator
const increment = () => ({ type: INCREMENT })

// 3. 定义 reducer
function counterReducer(state = 0, action) {
  switch (action.type) {
    case INCREMENT: return state + 1
    default: return state
  }
}

// 4. dispatch action
dispatch(increment())
```

```typescript
// Claude Code Store 方式：一行

store.setState(prev => ({ ...prev, count: prev.count + 1 }))
```

### 3.4 Zustand 的相似性

Claude Code Store 和 Zustand 惊人地相似：

```typescript
// Zustand
const useStore = create((set) => ({
  count: 0,
  increment: () => set(state => ({ count: state.count + 1 }))
}))

// Claude Code
const store = createStore({ count: 0 })
store.setState(prev => ({ ...prev, count: prev.count + 1 }))
```

**主要区别**：
1. Zustand 内建了 React 绑定；Claude Code 用 `useSyncExternalStore` 自己实现
2. Zustand 支持 middleware；Claude Code 用 `onChange` 回调
3. Zustand 是外部依赖；Claude Code 是零依赖

---

## 4. React 集成：useSyncExternalStore

### 4.1 AppStateProvider

```typescript
// src/state/AppState.tsx:L37-110

export function AppStateProvider({ children, initialState, onChangeAppState }) {
  // 防止嵌套
  const hasAppStateContext = useContext(HasAppStateContext)
  if (hasAppStateContext) {
    throw new Error("AppStateProvider can not be nested")
  }

  // 创建 Store（只创建一次）
  const [store] = useState(() =>
    createStore(initialState ?? getDefaultAppState(), onChangeAppState)
  )

  // 监听外部设置变化
  const onSettingsChange = useEffectEvent(source =>
    applySettingsChange(source, store.setState)
  )
  useSettingsChange(onSettingsChange)

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>{children}</VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}
```

### 4.2 useAppState：选择器模式

```typescript
// src/state/AppState.tsx:L142-162

export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()

  const get = () => {
    const state = store.getState()
    return selector(state)
  }

  return useSyncExternalStore(store.subscribe, get, get)
}
```

**关键设计**：`useSyncExternalStore` 是 React 18 的官方外部状态订阅 API。它：
1. **防止 tearing**：确保所有组件在同一次渲染中看到相同的状态
2. **支持并发模式**：不会在 concurrent rendering 中产生不一致
3. **自动比较**：用 `Object.is` 比较 selector 返回值，只在变化时重渲染

### 4.3 使用示例

```typescript
// ✅ 好：选择独立字段 → 精细更新
const verbose = useAppState(s => s.verbose)
const model = useAppState(s => s.mainLoopModel)

// ✅ 好：选择已有的子对象引用
const suggestion = useAppState(s => s.promptSuggestion)

// ❌ 差：选择器返回新对象 → 每次都重渲染
const ctx = useAppState(s => ({ a: s.verbose, b: s.model }))
// 每次调用都创建新对象 → Object.is 始终 false → 无限重渲染
```

### 4.4 其他 React Hook

```typescript
// 只需要写状态，不订阅
export function useSetAppState() {
  return useAppStore().setState
}

// 获取原始 store 引用（传给非 React 代码）
export function useAppStateStore() {
  return useAppStore()
}

// 安全版：可能在 Provider 外使用
export function useAppStateMaybeOutsideOfProvider<T>(
  selector: (state: AppState) => T
): T | undefined {
  const store = useContext(AppStoreContext)
  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    () => store ? selector(store.getState()) : undefined
  )
}
```

---

## 5. onChange 回调：集中式副作用

### 5.1 onChangeAppState 的职责

```typescript
// src/state/onChangeAppState.ts（172 行）

function onChangeAppState({ newState, oldState }: {
  newState: AppState
  oldState: AppState
}) {
  // 1. 权限模式同步
  //    → 通知 CCR + SDK 权限模式变化
  if (oldState.toolPermissionContext.mode !== newState.toolPermissionContext.mode) {
    notifySessionMetadataChanged({ permission_mode: toExternal(newMode) })
    notifyPermissionModeChanged(newMode)
  }

  // 2. 模型持久化
  //    → 写入 settings.json + 更新 bootstrap
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // 3. 视图偏好持久化
  //    → 写入全局配置
  if (newState.expandedView !== oldState.expandedView) {
    saveGlobalConfig(current => ({
      ...current,
      showExpandedTodos: newState.expandedView === 'tasks',
      showSpinnerTree: newState.expandedView === 'teammates',
    }))
  }

  // 4. 认证缓存失效
  //    → 设置变化时清除所有凭据缓存
  if (newState.settings !== oldState.settings) {
    clearApiKeyHelperCache()
    clearAwsCredentialsCache()
    clearGcpCredentialsCache()
    if (newState.settings.env !== oldState.settings.env) {
      applyConfigEnvironmentVariables()
    }
  }
}
```

### 5.2 为什么不用 Middleware？

Redux 的 middleware 模式：

```typescript
// Redux middleware：每个副作用一个 middleware
const permissionSyncMiddleware = store => next => action => {
  const prevMode = store.getState().mode
  const result = next(action)
  const newMode = store.getState().mode
  if (prevMode !== newMode) syncPermissions(newMode)
  return result
}

const modelPersistMiddleware = store => next => action => { /* ... */ }
const viewPersistMiddleware = store => next => action => { /* ... */ }
```

Claude Code 的 onChange 模式：

```typescript
// onChange 回调：所有副作用在一个函数中
function onChange({ newState, oldState }) {
  if (modeChanged) syncPermissions()
  if (modelChanged) persistModel()
  if (viewChanged) persistView()
  if (settingsChanged) clearCaches()
}
```

**优势**：
1. **可发现性**：所有副作用在一个文件中，不需要搜索 middleware 链
2. **执行顺序明确**：从上到下执行，不依赖 middleware 注册顺序
3. **性能**：没有 middleware 管道的函数调用开销
4. **类型安全**：直接访问 AppState 类型，不需要 middleware 类型体操

---

## 6. AppState：100+ 字段的状态树

### 6.1 类型定义

```typescript
// src/state/AppStateStore.ts（~600 行）

export type AppState = DeepImmutable<{
  // === 设置与配置 ===
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  thinkingEnabled?: boolean
  effortValue: EffortValue
  fastMode: boolean

  // === UI 状态 ===
  spinnerTip: string
  footerSelection: FooterItem | null
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  activeOverlays: ReadonlySet<string>
  expandedView: 'none' | 'tasks' | 'teammates'
  statusLineText?: string

  // === 权限 ===
  toolPermissionContext: ToolPermissionContext
  denialTracking: DenialTrackingState

  // === MCP & 插件 ===
  mcp: { clients, tools, commands, resources, pluginReconnectKey }
  plugins: { enabled, disabled, errors, needsRefresh }

  // === 任务 & Agent ===
  tasks: { [taskId: string]: TaskState }
  agentNameRegistry: Map<string, AgentId>
  foregroundedTaskId: string

  // === 消息 & 历史 ===
  messages: Message[]
  userMessageAutoSave?: UserMessage
  attributionState: AttributionState

  // === 投机执行 ===
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  promptSuggestion: { text, promptId } | null

  // ... 100+ 字段总计
}>
```

### 6.2 DeepImmutable 类型守卫

```typescript
// 编译时强制不可变
type DeepImmutable<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepImmutable<T[P]> : T[P]
}

// ✅ 编译通过
store.setState(prev => ({
  ...prev,
  verbose: !prev.verbose
}))

// ❌ 编译错误
store.setState(prev => {
  prev.verbose = true  // Error: Cannot assign to 'verbose' because it is a read-only property
  return prev
})
```

---

## 7. 双模式运行：React + Headless

### 7.1 React 模式（REPL）

```typescript
// src/screens/REPL.tsx
<AppStateProvider initialState={...} onChangeAppState={onChangeAppState}>
  <REPLContent />
</AppStateProvider>
```

### 7.2 Headless 模式（CLI print / SDK）

```typescript
// src/main.tsx:L2653+

// 不使用 React，直接创建 store
const headlessStore = createStore(headlessInitialState, onChangeAppState)

// 直接调用 getState/setState
void verifyAutoModeGateAccess(
  toolPermissionContext,
  headlessStore.getState().fastMode
).then(({ approved }) => {
  headlessStore.setState(prev => ({ ...prev, /* ... */ }))
})

// 传递给非 React 代码
void runHeadless(
  inputPrompt,
  () => headlessStore.getState(),
  headlessStore.setState,
  tools,
)
```

**这是自定义 Store 的核心优势之一**：不依赖 React Provider，可以在任何 JavaScript 环境中使用。Redux 和 Zustand 也支持，但需要额外的配置。

---

## 8. 状态选择器

```typescript
// src/state/selectors.ts（77 行）

// 纯计算派生状态

// 获取当前查看的队友任务
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>
): InProcessTeammateTaskState | undefined {
  // ...
}

// 确定用户输入应该路由到哪个 agent
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

export function getActiveAgentForInput(appState: AppState): ActiveAgentForInput {
  // ...
}
```

---

## 9. 架构全景图

```
┌─────────────────────────────────────────────────────────────┐
│                     React 组件层                              │
│                                                               │
│  useAppState(s => s.verbose)    useSetAppState()             │
│  useAppState(s => s.model)      useAppStateStore()           │
│                                                               │
│  每个 useAppState 调用 = 一个独立的 useSyncExternalStore     │
│  → 只有 selector 返回值变化时才重渲染                        │
└───────────────────────┬───────────────────────────────────────┘
                        │ useSyncExternalStore
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                   AppStateProvider                            │
│                                                               │
│  useState(() => createStore(initialState, onChange))          │
│  → Store 只创建一次，不随重渲染变化                          │
└───────────────────────┬───────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                   Store<AppState>                             │
│                                                               │
│  state: AppState (DeepImmutable)                             │
│  listeners: Set<Listener>                                    │
│                                                               │
│  setState(updater):                                          │
│    1. prev = state                                           │
│    2. next = updater(prev)                                   │
│    3. Object.is(next, prev) ? return : continue              │
│    4. state = next                                           │
│    5. onChange({ newState, oldState })  ← 副作用             │
│    6. for (listener of listeners) listener()  ← React 更新  │
└───────────────────────┬───────────────────────────────────────┘
                        │ onChange
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                onChangeAppState()                             │
│                                                               │
│  • 权限模式 → CCR + SDK 同步                                │
│  • 模型设置 → settings.json 持久化                           │
│  • 视图偏好 → 全局配置持久化                                 │
│  • 设置变化 → 清除认证缓存                                   │
│  • 环境变量 → 重新应用                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. 为什么这种极简方案适合 Streaming Agent？

### 10.1 Agent 的状态更新模式

传统 Web 应用：
```
用户点击按钮 → dispatch(action) → reducer 更新状态 → 渲染
          (离散的、可预测的状态变化)
```

Streaming Agent：
```
API 流式响应 → token by token → 更新消息数组 → 渲染
工具调用 → 并发执行 → 更新多个状态字段 → 渲染
分类器 → 旁路查询 → 更新权限状态 → 渲染
              (连续的、高频的、多源的状态变化)
```

### 10.2 Redux 在这个场景中的问题

1. **Action 类型爆炸**：每种状态更新都需要定义 action type
   - `UPDATE_MESSAGE`、`ADD_TOOL_RESULT`、`SET_SPINNER_TIP`...
2. **Reducer 不必要的复杂性**：大部分 reducer 就是简单的字段更新
3. **Middleware 管道开销**：高频更新下的性能问题
4. **异步 action 的复杂性**：redux-thunk/saga 增加学习成本

### 10.3 自定义 Store 的完美适配

1. **直接更新**：`setState(prev => ({ ...prev, field: newValue }))` 无需 action
2. **原子性**：updater 函数保证读取最新状态
3. **批量更新**：一次 setState 可以更新多个字段
4. **零开销**：没有 action dispatch → middleware → reducer 管道
5. **类型安全**：TypeScript 直接推断 `prev` 的类型

---

## 11. 文件结构

```
src/state/ (约 1190 行)
├── store.ts              (35 行)   # createStore 实现
├── AppStateStore.ts      (600+ 行) # AppState 类型定义
├── AppState.tsx          (200 行)  # React Provider + Hooks
├── onChangeAppState.ts   (172 行)  # 副作用回调
├── selectors.ts          (77 行)   # 派生状态
└── teammateViewHelpers.ts(142 行)  # Agent 视图操作
```

---

## 12. 思考题

1. **如果状态树继续增长怎么办？** 当前 100+ 字段已经很多了。Claude Code 没有做状态分片（store splitting），因为所有状态都在一个 REPL 进程中。如果将来需要分片，可以创建多个 Store 实例——createStore 的泛型设计支持这一点。

2. **没有 DevTools 如何调试？** Claude Code 使用 `verbose` 模式和日志输出。对于一个 CLI 工具来说，Redux DevTools 的可视化界面并不实用。

3. **onChange 会不会成为性能瓶颈？** 每次 setState 都调用 onChange，但 onChange 中的条件检查（`if (field changed)`）是 O(1) 的引用比较。实际执行的副作用（写磁盘、API 调用）只在真正变化时触发。

4. **为什么不用 Zustand？** Zustand 的 API 非常接近 Claude Code Store。可能的原因：(1) 零依赖策略——开发者工具不应该依赖可能有漏洞的第三方包；(2) 34 行代码完全可控，不需要跟踪上游更新；(3) 可以精确定制行为（如 onChange 回调的时机）。
