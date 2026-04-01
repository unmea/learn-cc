# 144 个组件是如何组织的？

> **Q: Claude Code 有 389 个组件文件、31 个子目录——这个庞大的组件体系是如何组织的？**

---

## 1. 组件目录全景

### 1.1 数字概览

```
src/components/ 统计:
├── 总文件数: 389 个 .ts/.tsx 文件
├── 子目录数: 31 个功能模块
├── 根级文件: 87 个核心组件
├── 最大文件: Messages.tsx (144 KB)
├── 最复杂: PromptInput.tsx (~2800 行)
└── 最小: EffortIndicator.ts (~20 行)
```

### 1.2 按功能分类

```
src/components/
│
├── 📨 消息系统 (48 文件)
│   ├── Message.tsx              — 消息分发器（type→component）
│   ├── Messages.tsx             — 消息列表容器（144 KB）
│   ├── MessageRow.tsx           — 单条消息行
│   ├── MessageResponse.tsx      — 消息响应渲染
│   ├── MessageModel.tsx         — 模型标识展示
│   ├── MessageTimestamp.tsx     — 时间戳
│   ├── MessageSelector.tsx      — 消息选择器
│   ├── messageActions.tsx       — 消息操作菜单
│   └── messages/                — 34 个专用消息组件
│       ├── AssistantMessage.tsx
│       ├── UserMessage.tsx
│       ├── SystemMessage.tsx
│       ├── ToolUseMessage.tsx
│       ├── AttachmentMessage.tsx
│       └── ...
│
├── ⌨️ 输入系统 (32 文件)
│   ├── PromptInput/             — 主输入系统 (21 文件)
│   │   ├── PromptInput.tsx      — 主组件 (~2800 行)
│   │   ├── PromptInputFooter.tsx
│   │   ├── PromptInputFooterSuggestions.tsx
│   │   ├── PromptInputModeIndicator.tsx
│   │   ├── inputModes.ts
│   │   └── utils.ts
│   ├── TextInput.tsx            — 基础文本输入
│   ├── BaseTextInput.tsx        — 文本输入基类
│   ├── VimTextInput.tsx         — Vim 模式文本输入
│   └── SearchBox.tsx            — 搜索框
│
├── 🎨 设计系统 (25+ 文件)
│   └── design-system/           — UI 基础组件
│       ├── Button.tsx
│       ├── Select.tsx
│       ├── Dialog.tsx
│       ├── Table.tsx
│       └── ...
│
├── 🪟 弹窗/对话框 (30+ 文件)
│   ├── QuickOpenDialog.tsx      — 快速打开（Ctrl+O）
│   ├── HistorySearchDialog.tsx  — 历史搜索
│   ├── GlobalSearchDialog.tsx   — 全局搜索
│   ├── ExportDialog.tsx         — 导出对话
│   ├── BridgeDialog.tsx         — Bridge 连接
│   ├── AutoModeOptInDialog.tsx  — 自动模式确认
│   ├── CostThresholdDialog.tsx  — 花费阈值提醒
│   ├── MCPServerApprovalDialog.tsx
│   └── ...
│
├── 🎭 Logo/品牌 (20 文件)
│   ├── LogoV2/                  — Logo 组件 (16 文件)
│   │   ├── LogoV2.tsx           — 主 Logo (80 KB)
│   │   ├── RecentActivity.tsx
│   │   ├── ReleaseNotes.tsx
│   │   └── OnboardingFlow.tsx
│   └── HelpV2/                  — 帮助面板 (3 文件)
│       ├── HelpV2.tsx
│       └── CommandList.tsx
│
├── 📋 任务/代理 (17 文件)
│   ├── tasks/                   — 后台任务 (12 文件)
│   │   ├── TaskListV2.tsx
│   │   └── TaskProgress.tsx
│   └── agents/                  — 代理状态 (5 文件)
│       ├── AgentProgressLine.tsx
│       └── CoordinatorAgentStatus.tsx
│
├── 🔧 工具结果展示 (15+ 文件)
│   ├── diff/                    — Diff 渲染 (6 文件)
│   ├── StructuredDiff.tsx       — 结构化 Diff
│   ├── StructuredDiffList.tsx
│   ├── FileEditToolDiff.tsx     — 文件编辑 Diff
│   ├── HighlightedCode/        — 代码高亮
│   └── HighlightedCode.tsx
│
├── 📊 可视化 (9 文件)
│   ├── ContextVisualization.tsx — 上下文使用可视化 (74 KB)
│   ├── Markdown.tsx             — Markdown 渲染
│   ├── MarkdownTable.tsx        — 表格渲染
│   └── Stats.tsx                — 统计信息
│
├── 🔒 权限 (8 文件)
│   └── permissions/
│       ├── PermissionDialog.tsx
│       └── TrustDialog/
│
├── ⚙️ 设置 (8 文件)
│   └── Settings/
│       ├── SettingsPanel.tsx
│       └── ...
│
├── 📱 布局/导航 (5 文件)
│   ├── App.tsx                  — 根组件
│   ├── FullscreenLayout.tsx     — 全屏布局
│   ├── VirtualMessageList.tsx   — 虚拟滚动消息列表
│   ├── ScrollKeybindingHandler.tsx — 滚动键绑定
│   └── StatusLine.tsx           — 状态栏
│
├── 🔄 Spinner (8 文件)
│   └── Spinner/
│       ├── Spinner.tsx          — 加载动画
│       └── variants/
│
├── 👥 团队 (6 文件)
│   └── teams/
│
├── 🔌 MCP (7 文件)
│   └── mcp/
│
├── 💾 Memory (4 文件)
│   └── memory/
│
├── 🏖️ Sandbox (4 文件)
│   └── sandbox/
│
├── 🖥️ Shell (5 文件)
│   └── shell/
│
├── 🎯 Skills (3 文件)
│   └── skills/
│
├── 🪝 Hooks (8 文件)
│   └── hooks/
│
└── 🧩 其他独立组件
    ├── Feedback.tsx
    ├── Onboarding.tsx
    ├── ThemePicker.tsx
    ├── ModelPicker.tsx
    ├── TokenWarning.tsx
    ├── ToolUseLoader.tsx
    └── ...
```

---

## 2. 核心组件深度剖析

### 2.1 Message.tsx — 类型分发中枢

```
源码: src/components/Message.tsx (77.3 KB)
```

Message 组件是一个**消息类型分发器**——根据消息类型路由到不同的专用组件：

```typescript
// 类型分发模式（核心逻辑）
function Message({ message, ...props }) {
  switch (message.type) {
    case 'attachment':
      return <AttachmentMessage attachment={message} />

    case 'assistant':
      // assistant 消息进一步分发内容块
      return (
        <Box flexDirection="column">
          {message.content.map(block => {
            switch (block.type) {
              case 'text':
                return <StreamingMarkdown>{block.text}</StreamingMarkdown>
              case 'tool_use':
                return <ToolUseBlock tool={block} />
              case 'thinking':
                return <ThinkingBlock thinking={block} />
            }
          })}
        </Box>
      )

    case 'user':
      return <UserMessage message={message} />

    case 'system':
      return <SystemTextMessage text={message.text} />

    case 'grouped_tool_use':
      return <GroupedToolUseContent tools={message.tools} />

    case 'collapsed_read_search':
      return <CollapsedReadSearchContent items={message.items} />
  }
}
```

**设计分析**：
- **TypeScript 判别联合** — `message.type` 确保类型安全，每个分支有精确的类型
- **层层分发** — Message → AssistantMessage → ContentBlock → 具体渲染组件
- **消息分组** — `grouped_tool_use` 和 `collapsed_read_search` 是对多个消息
  的聚合展示，减少视觉噪音

### 2.2 Messages.tsx — 消息列表容器

```
源码: src/components/Messages.tsx (144 KB — 项目中最大的组件)
```

Messages 是整个对话界面的核心容器，处理消息的**标准化、分组、重排序、虚拟化渲染**：

```typescript
// Messages.tsx 的核心管线

// 1. 标准化：将 API 消息转换为显示格式
const normalized = normalizeMessages(rawMessages)

// 2. 分组：将连续的工具调用合并
const grouped = applyGrouping(normalized)

// 3. 重排序：调整消息显示顺序（UI 优化）
const reordered = reorderMessagesInUI(grouped)

// 4. 虚拟化渲染
return (
  <VirtualMessageList
    messages={reordered}
    renderItem={(msg) => <MessageRow message={msg} />}
  />
)
```

**关键性能优化——级联重渲染防护**：

```tsx
// 问题：在 2800+ 消息的会话中，任何状态变化都会导致整个列表重渲染
// 每帧可能触发 150,000+ 次写入操作

// 解决方案：LogoHeader memo + OffscreenFreeze
const LogoHeader = React.memo(function LogoHeader(props) {
  return (
    <OffscreenFreeze>
      <LogoV2 />                           {/* 不会因消息变化而重渲染 */}
      <StatusNotices agentDefinitions={props.agentDefinitions} />
    </OffscreenFreeze>
  )
})
// 效果：防止 Logo 区域的 150K+ 写操作/帧
```

### 2.3 PromptInput — 输入系统

```
源码: src/components/PromptInput/PromptInput.tsx (~2800 行)
```

PromptInput 是项目中最复杂的单一组件，集成了：

```
PromptInput 功能清单:
├── 多行文本编辑
│   ├── 光标管理: cursorOffset 追踪
│   ├── 行检测: isCursorOnFirstLine / isCursorOnLastLine
│   ├── 文本插入: 在光标位置精确插入
│   └── 历史导航: 仅在首行/末行时触发
│
├── 输入模式
│   ├── 普通模式: 标准文本输入
│   ├── Bash 模式: 以 '!' 开头时激活
│   └── Vim 模式: NORMAL/INSERT 切换
│
├── 自动补全
│   ├── 斜杠命令: /help, /clear, ...
│   ├── 文件路径: @src/utils.ts
│   ├── Shell 历史
│   └── Slack 频道
│
├── 粘贴内容处理
│   ├── 图片粘贴: pastedContents: Record<number, PastedContent>
│   └── 多行文本粘贴
│
├── 外部输入检测
│   ├── STT (语音转文字) 注入检测
│   └── 光标自动移到末尾
│
└── UI 子组件
    ├── PromptInputFooter — 状态指示器
    ├── PromptInputFooterSuggestions — 补全建议列表
    └── PromptInputModeIndicator — Vim 模式指示器
```

**光标管理的关键逻辑**：

```typescript
// PromptInput.tsx 中
const insert = (text: string) => {
  // 1. 检查是否需要添加空格
  const needsSpace = cursorOffset === input.length &&
                    input.length > 0 && !/\s$/.test(input)

  // 2. 在光标位置插入文本
  const newValue = input.slice(0, cursorOffset) + text + input.slice(cursorOffset)

  // 3. 移动光标到插入文本之后
  setCursorOffset(cursorOffset + text.length)
}

// 行检测（用于历史导航判断）
const isCursorOnFirstLine = cursorOffset <= input.indexOf('\n')
const isCursorOnLastLine = cursorOffset > input.lastIndexOf('\n')
// 只在光标在首行时按↑才导航到上一条历史
// 只在光标在末行时按↓才导航到下一条历史
```

### 2.4 ContextVisualization.tsx — 上下文可视化

```
源码: src/components/ContextVisualization.tsx (74 KB)
```

当用户运行 `/context` 命令时，显示当前上下文的使用情况：

```typescript
// 核心函数: groupBySource()
function groupBySource(items: ContextItem[]): GroupedContext {
  // 按来源分组排序
  // Project > User > Managed > Plugin > Built-in
  // 每组内按 token 数降序排列

  return {
    project: items.filter(i => i.source === 'project'),
    user: items.filter(i => i.source === 'user'),
    managed: items.filter(i => i.source === 'managed'),
    plugin: items.filter(i => i.source === 'plugin'),
    builtin: items.filter(i => i.source === 'builtin'),
  }
}
```

```
/context 命令的输出示例:
┌─────────────────────────────────────────────────────┐
│  Context Usage: 12,400 / 200,000 tokens (6.2%)     │
│                                                     │
│  ■■■■■■░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│                                                     │
│  Project (4,200 tokens)                             │
│    AGENTS.md                          2,100 tokens  │
│    .claude/settings.json                800 tokens  │
│    tsconfig.json                        400 tokens  │
│                                                     │
│  Built-in (8,200 tokens)                            │
│    System prompt                      5,200 tokens  │
│    Tool definitions                   3,000 tokens  │
└─────────────────────────────────────────────────────┘
```

### 2.5 HelpV2 — 帮助面板

```
源码: src/components/HelpV2/HelpV2.tsx
```

```
HelpV2 结构:
├── 标签式界面: General | Commands | Custom
├── 命令筛选: 内置命令 vs 自定义命令
├── 快捷键展示: 显示可用快捷键
└── ESC 退出: useKeybinding('escape', dismiss)
```

### 2.6 LogoV2 — 品牌展示

```
源码: src/components/LogoV2/LogoV2.tsx (80 KB)
```

LogoV2 不只是一个 Logo——它是一个复合组件，包含：

```
LogoV2 子系统:
├── 动画 Clawd Logo — ASCII art 动画
├── 最近活动 Feed — 显示最近操作
├── Release Notes — 版本更新日志
├── 项目 Onboarding — 首次使用引导
├── Upsell 组件 — Guest Pass、超额提示
└── 状态通知 — 系统通知和提醒
```

---

## 3. 组件组合模式

### 3.1 模式一：React Compiler 自动优化

Claude Code 使用 React Compiler 编译所有组件：

```typescript
// 编译后的代码中可以看到：
const $ = Symbol.for("react.memo_cache_sentinel")

// React Compiler 自动生成 memoization
// 无需手动 useMemo / useCallback / React.memo
// 编译器分析依赖关系，自动缓存不变的部分
```

但某些组件**选择退出**编译器优化：

```typescript
// StreamingMarkdown 使用 'use no memo' 指令
export function StreamingMarkdown({ children }) {
  'use no memo'  // ← 告诉 React Compiler 不要自动 memo

  // 原因：StreamingMarkdown 的 children 每次都变（流式追加）
  // 自动 memo 反而浪费 — 总是需要重渲染
  // 但内部自己管理了更高效的增量渲染策略
}
```

### 3.2 模式二：类型判别联合分发

```typescript
// 贯穿整个消息系统的模式
type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_result'; output: string }

// 每种类型有专门的渲染组件
function ContentBlock({ block }: { block: MessageContent }) {
  switch (block.type) {
    case 'text':      return <TextBlock text={block.text} />
    case 'tool_use':  return <ToolUseBlock name={block.name} input={block.input} />
    case 'thinking':  return <ThinkingBlock thinking={block.thinking} />
    case 'tool_result': return <ToolResultBlock output={block.output} />
  }
}
```

**优势**：TypeScript 的类型收窄确保每个分支都能安全访问特定属性。
新增消息类型时，编译器会提示所有未处理的 case。

### 3.3 模式三：Context + External Store

```typescript
// 消息操作状态共享
const MessageActionsSelectedContext = React.createContext(null)

// Zustand-like 外部 Store 通过 useSyncExternalStore
function useMessageActions() {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  )
}
```

### 3.4 模式四：OffscreenFreeze 防止非可见区域渲染

```tsx
// 当组件不在视口内时，冻结渲染
<OffscreenFreeze>
  <ExpensiveComponent />
</OffscreenFreeze>

// OffscreenFreeze 的实现原理：
// 当组件不可见时，阻止 React 的 reconciliation
// 可见时恢复——不是销毁重建，而是冻结/解冻
```

### 3.5 模式五：渲染回调 (Render Props / Children as Function)

```tsx
// VirtualMessageList 的渲染委托
<VirtualMessageList
  messages={messages}
  renderItem={(message, index) => (
    <MessageRow
      key={message.id}
      message={message}
      isLast={index === messages.length - 1}
    />
  )}
/>
```

---

## 4. 流式内容的增量渲染

### 4.1 核心问题

AI 模型每秒产出 100+ token，每个 token 都触发一次消息更新。
如果每次都完整重新解析和渲染 Markdown，性能无法接受。

### 4.2 StreamingMarkdown 的解决方案

```typescript
// src/components/Markdown.tsx — StreamingMarkdown

export function StreamingMarkdown({ children }: StreamingProps) {
  'use no memo'  // 退出 React Compiler

  const stripped = stripPromptXMLTags(children)
  const stablePrefixRef = useRef('')

  // ── 关键算法：单调递增边界 ──

  // Step 1: 检测文本是否被替换（而非追加）
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''  // 重置边界
  }

  // Step 2: 只对新增文本做词法分析
  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))
  // 复杂度: O(新增文本长度)，不是 O(全文长度)

  // Step 3: 找到最后一个非空白 token（正在增长的块）
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]?.type === 'space') {
    lastContentIdx--
  }

  // Step 4: 推进边界
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]?.raw.length
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance)
  }

  // Step 5: 分离稳定部分和不稳定部分
  const stablePrefix = stablePrefixRef.current     // 已完成的块
  const unstableSuffix = stripped.substring(stablePrefix.length)  // 正在增长的块

  // Step 6: 渲染
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}     {/* 缓存 */}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}  {/* 实时 */}
    </Box>
  )
}
```

**为什么这样做有效**：

```
假设 AI 正在输出一段代码:

帧 1: "这是一段\n```typescript\nfunction hello() {\n"
       ^^^^^^^^^^^^^^^^^^^^^^^^^
       stablePrefix (完成的段落)
                                 ^^^^^^^^^^^^^^^^^^^^^^^^^
                                 unstableSuffix (代码块还在增长)

帧 2: "这是一段\n```typescript\nfunction hello() {\n  console.log("
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
       stablePrefix 推进了（代码块的前面部分固定了）
                                                        ^^^^^^^^^^^^^^
                                                        unstableSuffix

帧 3: "这是一段\n```typescript\nfunction hello() {\n  console.log('hi')\n}\n```"
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
       全部成为 stablePrefix（代码块完成了）
```

- `stablePrefix` 部分：Markdown 解析结果被 LRU 缓存（500 条），不重新解析
- `unstableSuffix` 部分：只有正在增长的最后一个块需要实时解析
- 每帧复杂度：O(新增 token 长度) 而非 O(全文长度)
- 实测：~3ms per delta

### 4.3 LRU Token 缓存

```typescript
// Markdown 内部使用 LRU 缓存
// 500 条缓存，基于文本内容的 hash 作为 key
// 相同的 Markdown 文本不会重复 lex

const tokenCache = new LRUCache<string, Token[]>(500)

function cachedLex(text: string): Token[] {
  const hash = hashText(text)
  if (tokenCache.has(hash)) return tokenCache.get(hash)!
  const tokens = marked.lexer(text)
  tokenCache.set(hash, tokens)
  return tokens
}
```

---

## 5. 虚拟滚动

### 5.1 问题

2800+ 消息的会话中，如果每条消息都创建 React 组件和 Yoga 节点：
- 组件数量：2800 × 平均 5 个子组件 = 14,000+ React 节点
- Yoga 节点：同量级
- 内存：每个 Yoga 节点 ~200 bytes WASM = ~2.8 MB WASM 内存
- 布局计算：14,000 节点的 calculateLayout 需要 ~28ms

### 5.2 VirtualMessageList 解决方案

```
源码: src/components/VirtualMessageList.tsx
```

```typescript
// 虚拟滚动：只渲染可见区域的消息
function VirtualMessageList({ messages, scrollTop, viewportHeight }) {
  // 1. 计算可见范围
  const { startIndex, endIndex } = getVisibleRange(
    messages, scrollTop, viewportHeight
  )

  // 2. 只渲染可见消息
  const visibleMessages = messages.slice(startIndex, endIndex + overscan)

  // 3. 用占位空间代替不可见消息
  return (
    <Box flexDirection="column">
      <Box height={startIndex * estimatedRowHeight} />  {/* 顶部占位 */}
      {visibleMessages.map(msg => (
        <MessageRow key={msg.id} message={msg} />
      ))}
      <Box height={(messages.length - endIndex) * estimatedRowHeight} />  {/* 底部占位 */}
    </Box>
  )
}
```

### 5.3 滚动裁剪

```typescript
// src/ink/render-node-to-output.ts 中
// overflow: 'scroll' 的处理
if (node.style?.overflow === 'scroll') {
  // 1. 计算 scrollTop
  const scrollTop = node.scrollTop ?? 0

  // 2. 视口裁剪：只渲染 [scrollTop, scrollTop + viewportHeight] 范围
  // 超出范围的子节点跳过渲染

  // 3. scrollClampMin / scrollClampMax
  // 虚拟滚动的边界钳制：防止滚到未挂载内容的区域
  if (node.scrollClampMin !== undefined && node.scrollClampMax !== undefined) {
    effectiveScrollTop = Math.max(node.scrollClampMin,
      Math.min(node.scrollClampMax, scrollTop))
  }

  // 4. stickyScroll：自动跟随底部
  if (node.stickyScroll) {
    node.scrollTop = contentHeight - viewportHeight
  }
}
```

---

## 6. 组件间通信模式

### 6.1 Props 向下传递（最常见）

```tsx
<REPL>
  <Messages messages={messages} />           {/* 消息数据 */}
    <MessageRow message={msg}>               {/* 单条消息 */}
      <Message message={msg}>                {/* 消息分发 */}
        <AssistantMessage content={content}>  {/* 助手消息 */}
          <StreamingMarkdown>                 {/* 流式渲染 */}
```

### 6.2 全局 Store（跨组件状态）

```typescript
// src/state/store.ts — 自定义 Store
// 类似 Zustand，但专为 Claude Code 定制
const store = createStore({
  messages: [],
  isStreaming: false,
  // ...
})

// 组件通过 Hook 订阅
function MessageList() {
  const messages = useStore(state => state.messages)
  return <Messages messages={messages} />
}
```

### 6.3 React Context（局部共享）

```tsx
// 消息操作上下文
<MessageActionsSelectedContext.Provider value={selectedAction}>
  <MessageList />
  <ActionBar />
</MessageActionsSelectedContext.Provider>
```

### 6.4 Ref 回调（命令式操作）

```tsx
// PromptInput 对外暴露的命令式接口
const insertTextRef = useRef<{
  insert: (text: string) => void
  setInputWithCursor: (text: string, cursor: number) => void
}>()

// 外部可以通过 ref 插入文本
insertTextRef.current?.insert('/help ')
```

---

## 7. 性能优化策略总结

```
组件级优化:
├── React Compiler — 自动 memoization，零手动干预
├── 'use no memo' — 频繁变化的组件退出自动 memo
├── React.memo — 手动 memo 关键昂贵组件（如 LogoHeader）
├── OffscreenFreeze — 冻结不可见组件的渲染
└── useSyncExternalStore — 精确订阅，只在相关数据变化时重渲染

渲染级优化:
├── StreamingMarkdown — O(增量) 而非 O(全文)
├── LRU Token 缓存 — 500 条 Markdown 解析缓存
├── 虚拟滚动 — 只渲染可见消息
├── 消息分组 — 减少渲染节点数
└── 级联防护 — 防止 150K+ 写操作/帧

布局级优化:
├── squashTextNodes — 合并相邻文本节点
├── dirty 标记 — 只重新布局变化的子树
└── 布局位移检测 — 稳态帧跳过全量 diff
```

---

## 8. 关键源码索引

| 组件 | 文件 | 大小 | 核心职责 |
|------|------|------|---------|
| App | `src/components/App.tsx` | — | 根组件，全局 Provider |
| Messages | `src/components/Messages.tsx` | 144 KB | 消息列表容器 |
| Message | `src/components/Message.tsx` | 77 KB | 消息类型分发 |
| PromptInput | `src/components/PromptInput/PromptInput.tsx` | ~2800 行 | 输入系统 |
| StreamingMarkdown | `src/components/Markdown.tsx` | — | 流式 Markdown |
| ContextVisualization | `src/components/ContextVisualization.tsx` | 74 KB | 上下文可视化 |
| VirtualMessageList | `src/components/VirtualMessageList.tsx` | — | 虚拟滚动 |
| LogoV2 | `src/components/LogoV2/LogoV2.tsx` | 80 KB | Logo + 通知 |
| HelpV2 | `src/components/HelpV2/HelpV2.tsx` | — | 帮助面板 |
| FullscreenLayout | `src/components/FullscreenLayout.tsx` | — | 全屏布局 |
| StatusLine | `src/components/StatusLine.tsx` | — | 底部状态栏 |
| VimTextInput | `src/components/VimTextInput.tsx` | — | Vim 模式输入 |

> **一句话总结**：Claude Code 的 389 个组件通过类型分发、React Compiler
> 自动优化、虚拟滚动、增量流式渲染等模式，在终端环境中实现了一个功能丰富、
> 性能优秀的 UI 系统。
