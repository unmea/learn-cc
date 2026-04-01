# 如何在终端实现多行编辑、Vim 模式、自动补全？

> **Q: 终端输入只有一个 stdin，如何实现堪比编辑器的输入体验？**

---

## 1. 终端输入的基本原理

### 1.1 Raw Mode 与 Cooked Mode

```
Cooked Mode（默认）:
├── 终端驱动程序处理行编辑
├── 用户按 Enter 后才把整行发给程序
├── 支持 Ctrl+C（中断）、Ctrl+D（EOF）
└── 你只能拿到"完整的一行"

Raw Mode（原始模式）:
├── 每次按键立即发给程序
├── 没有行编辑——你需要自己处理一切
├── ANSI 转义序列原样传递
└── 你拿到的是原始字节流
```

Claude Code 在 Raw Mode 下运行——这意味着**每一次按键都由程序自己处理**。

### 1.2 原始按键数据长什么样

```
普通字符:
  'a'          → 0x61 (单字节)
  '中'         → 0xE4 0xB8 0xAD (UTF-8 三字节)

控制字符:
  Ctrl+C       → 0x03
  Ctrl+D       → 0x04
  Enter        → 0x0D
  Escape       → 0x1B
  Tab          → 0x09

ANSI 转义序列:
  ↑            → \x1b[A     (ESC [ A)
  ↓            → \x1b[B
  ←            → \x1b[D
  →            → \x1b[C
  F1           → \x1b[OP
  Home         → \x1b[H
  Delete       → \x1b[3~

高级协议 (CSI u / Kitty Keyboard Protocol):
  Ctrl+Shift+K → \x1b[107;6u     (keycode;modifiers u)
  Alt+Enter    → \x1b[13;3u

xterm modifyOtherKeys:
  Ctrl+I (不同于 Tab) → \x1b[27;5;105~
```

---

## 2. 输入处理管线

### 2.1 完整流程图

```
process.stdin (raw bytes)
        │
        ▼
┌──────────────────────────────────────────┐
│  Tokenizer (termio/tokenize.js)          │
│  ├── 检测转义序列的边界                   │
│  └── 分割为独立的按键事件                 │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  parse-keypress.ts                        │
│  ├── 正则匹配转义序列类型                 │
│  │   ├── META_KEY_CODE_RE (Alt+key)      │
│  │   ├── FN_KEY_RE (F1-F12, arrows)      │
│  │   ├── CSI u (Kitty protocol)          │
│  │   ├── xterm modifyOtherKeys           │
│  │   └── SGR mouse events                │
│  └── 返回: ParsedKey                      │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  input-event.ts: parseKey()              │
│  ├── ParsedKey → Key (boolean flags)     │
│  ├── 提取 input 字符串                   │
│  └── 返回: InputEvent { key, input }     │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  useInput() Hook                          │
│  ├── 设置 raw mode                       │
│  ├── 监听 internal_eventEmitter          │
│  └── 调用 inputHandler(input, key, event)│
└──────────────────┬───────────────────────┘
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
   ┌─────────┐ ┌─────────┐ ┌─────────────┐
   │ Vim     │ │ Standard│ │ Keybinding  │
   │ Handler │ │ Handler │ │ Resolver    │
   └────┬────┘ └────┬────┘ └──────┬──────┘
        │           │              │
        └───────────┴──────────────┘
                    │
                    ▼
            State Update
         (input, cursor, mode)
```

### 2.2 ParsedKey 类型

```typescript
// src/ink/parse-keypress.ts:172-186
export type ParsedKey = {
  kind: 'key'
  fn: boolean                     // 是否为功能键（F1-F12, arrows）
  name: string | undefined        // 按键名：'up', 'escape', 'space', ...
  ctrl: boolean                   // Ctrl 修饰符
  meta: boolean                   // Alt/Option 修饰符
  shift: boolean                  // Shift 修饰符
  option: boolean                 // macOS Option 键
  super: boolean                  // Cmd/Win（仅 Kitty 协议支持）
  sequence: string | undefined    // 原始转义序列
  raw: string | undefined         // 原始字节
  code?: string                   // 字符编码
  isPasted: boolean               // 是否为粘贴内容
}
```

### 2.3 Key 类型（Ink 内部）

```typescript
// src/ink/events/input-event.ts:4-25
export type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  wheelUp: boolean
  wheelDown: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  fn: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  super: boolean
}
```

### 2.4 InputEvent

```typescript
// src/ink/events/input-event.ts:192-206
export class InputEvent extends Event {
  readonly keypress: ParsedKey    // 原始解析结果
  readonly key: Key               // Ink 的 boolean 标志
  readonly input: string          // 实际字符或键名
}
```

---

## 3. 多行编辑

### 3.1 光标管理

```
源码: src/components/PromptInput/PromptInput.tsx
```

多行编辑的核心是 `cursorOffset`——一个**全文偏移量**：

```typescript
// 状态
const [input, setInput] = useState('')
const [cursorOffset, setCursorOffset] = useState(0)

// 示例：多行文本中的光标位置
// input = "第一行\n第二行\n第三行"
// cursorOffset = 10  (指向"第二行"的"行"字之后)
//
// 第一行
// 第二行|    ← 光标在这里
// 第三行
```

### 3.2 行检测

```typescript
// 判断光标是否在首行
const firstNewline = input.indexOf('\n')
const isCursorOnFirstLine = firstNewline === -1 || cursorOffset <= firstNewline
// 用途：只在首行时，↑键才触发历史导航（否则在文本内上移）

// 判断光标是否在末行
const lastNewline = input.lastIndexOf('\n')
const isCursorOnLastLine = lastNewline === -1 || cursorOffset > lastNewline
// 用途：只在末行时，↓键才触发历史导航
```

### 3.3 文本操作

```typescript
// 插入文本（在光标位置）
function insert(text: string) {
  const before = input.slice(0, cursorOffset)
  const after = input.slice(cursorOffset)
  setInput(before + text + after)
  setCursorOffset(cursorOffset + text.length)
}

// 删除（退格）
function handleBackspace() {
  if (cursorOffset === 0) return
  const before = input.slice(0, cursorOffset - 1)
  const after = input.slice(cursorOffset)
  setInput(before + after)
  setCursorOffset(cursorOffset - 1)
}

// 删除（Delete 键）
function handleDelete() {
  if (cursorOffset === input.length) return
  const before = input.slice(0, cursorOffset)
  const after = input.slice(cursorOffset + 1)
  setInput(before + after)
  // 光标不动
}

// 换行
function handleNewline() {
  insert('\n')
}
```

### 3.4 行内导航

```
光标移动操作:
├── ← (左)   → cursorOffset - 1
├── → (右)   → cursorOffset + 1
├── ↑ (上)   → 移到上一行的相同列位置（或行尾）
├── ↓ (下)   → 移到下一行的相同列位置（或行尾）
├── Home     → 移到当前行首
├── End      → 移到当前行尾
├── Ctrl+A   → 移到全文开头 (cursorOffset = 0)
├── Ctrl+E   → 移到全文结尾 (cursorOffset = input.length)
├── Alt+←    → 移到前一个单词
└── Alt+→    → 移到后一个单词
```

### 3.5 换行渲染

```typescript
// TextInput 渲染多行文本
function TextInput({ value, cursorOffset }) {
  const lines = value.split('\n')
  let offset = 0

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const lineStart = offset
        const lineEnd = offset + line.length
        offset = lineEnd + 1  // +1 for \n

        // 光标是否在这一行？
        const hasCursor = cursorOffset >= lineStart && cursorOffset <= lineEnd
        const cursorCol = hasCursor ? cursorOffset - lineStart : -1

        return (
          <Text key={i}>
            {hasCursor ? (
              <>
                {line.slice(0, cursorCol)}
                <Text inverse>{line[cursorCol] || ' '}</Text>  {/* 光标 */}
                {line.slice(cursorCol + 1)}
              </>
            ) : (
              line
            )}
          </Text>
        )
      })}
    </Box>
  )
}
```

---

## 4. Vim 模式

### 4.1 架构概览

```
Vim 模式相关文件:
src/vim/
├── types.ts          — 核心类型定义 (200 行)
├── transitions.ts    — 状态转换逻辑 (490 行)
├── operators.ts      — 操作符执行 (delete/change/yank)
├── motions.ts        — 光标移动 (word/line/find)
└── textObjects.ts    — 文本对象 (iw/aw/i"/a")

src/hooks/
└── useVimInput.ts    — Vim Hook (250+ 行)

src/components/
├── VimTextInput.tsx  — Vim 模式文本输入组件
└── PromptInput/
    └── PromptInputModeIndicator.tsx — 模式指示器 (NORMAL/INSERT)
```

### 4.2 VimState 状态机

```typescript
// src/vim/types.ts:49-51
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }
```

**INSERT 模式**：
- 按键直接作为文本输入
- 记录 `insertedText`（用于 `.` 重复）
- 按 `Escape` 切换到 NORMAL 模式

**NORMAL 模式**：
- 按键被解释为 Vim 命令
- 有复杂的状态子机

### 4.3 NORMAL 模式的 CommandState

```typescript
// src/vim/types.ts:59-75
export type CommandState =
  | { type: 'idle' }                    // 等待输入
  | { type: 'count'; digits: string }   // 正在输入数字前缀 (5d)
  | { type: 'operator'; op: Operator; count: number }
  //   ↑ 输入了操作符，等待动作 (d→_)
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  //   ↑ 操作符后的数字 (d2→_)
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  //   ↑ 操作符 + find 命令 (df→_)
  | { type: 'operatorTextObj'; op: Operator; count: number; scope: TextObjScope }
  //   ↑ 操作符 + 文本对象 (di→_ 或 da→_)
  | { type: 'find'; find: FindType; count: number }
  //   ↑ 独立的 find 命令 (f→_)
  | { type: 'g'; count: number }
  //   ↑ g 前缀命令 (gg, gj, gk)
  | { type: 'operatorG'; op: Operator; count: number }
  //   ↑ 操作符 + g (dgg)
  | { type: 'replace'; count: number }
  //   ↑ r 替换命令 (r→_)
  | { type: 'indent'; dir: '>' | '<'; count: number }
  //   ↑ 缩进命令 (>> 或 <<)
```

### 4.4 状态转换示例

```
用户输入: d 2 w

Step 1: 'd' 在 idle 状态
  idle + 'd' → { type: 'operator', op: 'delete', count: 1 }
  "我要删除，但删什么？"

Step 2: '2' 在 operator 状态
  operator(delete) + '2' → { type: 'operatorCount', op: 'delete', count: 1, digits: '2' }
  "删除 2 个什么？"

Step 3: 'w' 在 operatorCount 状态
  operatorCount(delete, 2) + 'w' → 执行: delete 2 words
  → 回到 idle

用户输入: c i "

Step 1: 'c' → { type: 'operator', op: 'change', count: 1 }
Step 2: 'i' → { type: 'operatorTextObj', op: 'change', count: 1, scope: 'inner' }
Step 3: '"' → 执行: change inner quotes (删除引号内内容，进入 INSERT)
```

### 4.5 transitions.ts — 转换函数

```typescript
// src/vim/transitions.ts:59-88
export function transition(
  state: CommandState,
  input: string,
  ctx: TransitionContext
): TransitionResult {
  // TransitionResult = { next?: CommandState; execute?: () => void }
  switch (state.type) {
    case 'idle':           return fromIdle(input, ctx)
    case 'count':          return fromCount(state, input, ctx)
    case 'operator':       return fromOperator(state, input, ctx)
    case 'operatorCount':  return fromOperatorCount(state, input, ctx)
    case 'operatorFind':   return fromOperatorFind(state, input, ctx)
    case 'operatorTextObj':return fromOperatorTextObj(state, input, ctx)
    case 'find':           return fromFind(state, input, ctx)
    case 'g':              return fromG(state, input, ctx)
    case 'operatorG':      return fromOperatorG(state, input, ctx)
    case 'replace':        return fromReplace(state, input, ctx)
    case 'indent':         return fromIndent(state, input, ctx)
  }
}

// 从 idle 状态开始（line 248+）
function fromIdle(input: string, ctx: TransitionContext): TransitionResult {
  // 简单动作（不需要操作符）
  if (SIMPLE_MOTIONS.has(input)) {
    return { execute: () => ctx.executeMotion(input) }
  }

  // 操作符
  if (OPERATORS.has(input)) {
    return { next: { type: 'operator', op: OPERATORS.get(input)!, count: 1 } }
  }

  // 数字前缀
  if (input >= '1' && input <= '9') {
    return { next: { type: 'count', digits: input } }
  }

  // 模式切换
  if (input === 'i') return { execute: () => ctx.enterInsert('before') }
  if (input === 'a') return { execute: () => ctx.enterInsert('after') }
  if (input === 'o') return { execute: () => ctx.enterInsert('newlineBelow') }
  if (input === 'O') return { execute: () => ctx.enterInsert('newlineAbove') }

  // ... 更多命令
}

// 常量
const SIMPLE_MOTIONS = new Set(['h', 'j', 'k', 'l', 'w', 'b', 'e', '0', '$', '^', ...])
const OPERATORS = new Map([['d', 'delete'], ['c', 'change'], ['y', 'yank']])
const MAX_VIM_COUNT = 10000  // 防止 99999999 这种恶意输入
```

### 4.6 PersistentState — 跨命令持久化

```typescript
// src/vim/types.ts:81-86
export type PersistentState = {
  lastChange: RecordedChange | null    // 上次修改（用于 . 重复）
  lastFind: { type: FindType; char: string } | null  // 上次查找（用于 ; 和 ,）
  register: string                      // 剪贴板内容
  registerIsLinewise: boolean           // 剪贴板是否为行模式
}
```

### 4.7 useVimInput Hook

```typescript
// src/hooks/useVimInput.ts:34+
export function useVimInput(props: UseVimInputProps): VimInputState {
  const vimStateRef = useRef<VimState>({ mode: 'INSERT', insertedText: '' })
  const persistentRef = useRef<PersistentState>({
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  })
  const [mode, setMode] = useState<VimMode>('INSERT')

  function switchToNormalMode() {
    // 1. 记录 INSERT 模式中输入的文本（用于 . 重复）
    if (vimStateRef.current.mode === 'INSERT') {
      persistentRef.current.lastChange = {
        text: vimStateRef.current.insertedText,
        // ...
      }
    }
    // 2. 切换状态
    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } }
    setMode('NORMAL')
    // 3. Vim 行为：退出 INSERT 时光标左移一格
    moveCursorLeft()
  }

  function switchToInsertMode() {
    vimStateRef.current = { mode: 'INSERT', insertedText: '' }
    setMode('INSERT')
  }

  function handleInput(input: string, key: Key) {
    if (vimStateRef.current.mode === 'INSERT') {
      if (key.escape) {
        switchToNormalMode()
        return
      }
      // INSERT 模式：正常文本输入
      vimStateRef.current.insertedText += input
      props.onInput(input, key)
    } else {
      // NORMAL 模式：通过状态机处理
      const result = transition(
        vimStateRef.current.command,
        input,
        transitionContext,
      )
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next }
      }
      if (result.execute) {
        result.execute()
      }
    }
  }

  return { mode, setMode, handleInput, ... }
}
```

---

## 5. Vim 与标准快捷键的共存

### 5.1 共存架构

```
按键到达
    │
    ▼
Vim 模式启用？  ← isVimModeEnabled() 读取 config.editorMode
    │
    ├── 是 → VimTextInput 组件
    │        │
    │        ├── INSERT 模式
    │        │   ├── 按键作为文本输入
    │        │   └── Escape → NORMAL
    │        │
    │        └── NORMAL 模式
    │            ├── Vim 状态机处理
    │            └── 如果 Vim 不消费 → 传递给快捷键系统
    │
    └── 否 → TextInput 组件
             │
             └── 所有按键进入快捷键系统
    │
    ▼
KeybindingProviderSetup 快捷键系统
    │
    ├── resolver.ts: resolveKeyWithChordState()
    │   ├── 单键匹配
    │   └── 和弦检测（如 Ctrl+X Ctrl+E）
    │
    ├── match.ts: matchesBinding()
    │   ├── 修饰符匹配 (ctrl, shift, meta)
    │   └── 键名匹配
    │
    └── 执行绑定的 action
```

### 5.2 模式检测

```typescript
// src/components/PromptInput/utils.ts
export function isVimModeEnabled(): boolean {
  const config = getGlobalConfig()
  return config.editorMode === 'vim'
}
```

### 5.3 条件渲染

```tsx
// PromptInput.tsx 中
function PromptInput(props) {
  if (isVimModeEnabled()) {
    return <VimTextInput {...props} />
  }
  return <TextInput {...props} />
}
```

### 5.4 快捷键上下文系统

```typescript
// src/keybindings/schema.ts
// 17 个快捷键上下文
type KeybindingContextName =
  | 'Global'          // 全局快捷键
  | 'Chat'            // 聊天界面
  | 'Autocomplete'    // 自动补全弹出时
  | 'Confirmation'    // 确认对话框
  | 'Help'            // 帮助面板
  // ... 更多上下文
```

不同上下文有不同的快捷键绑定，解决了冲突问题：
- 在 `Autocomplete` 上下文中，`↑/↓` 是选择补全项
- 在 `Chat` 上下文中，`↑/↓` 是滚动/历史导航
- 在 Vim `NORMAL` 模式中，`j/k` 是上下移动

---

## 6. 快捷键系统

### 6.1 架构

```
src/keybindings/ 文件:
├── KeybindingContext.tsx         — React Context
├── KeybindingProviderSetup.tsx   — Provider + 和弦检测 (41 KB)
├── defaultBindings.ts           — 平台默认绑定
├── loadUserBindings.ts          — 加载用户自定义绑定
├── match.ts                     — 按键匹配逻辑 (3.8 KB)
├── parser.ts                    — 按键字符串解析 (5 KB)
├── resolver.ts                  — 解析器 + 和弦状态机 (7 KB)
├── schema.ts                    — Zod schema 验证 (6.3 KB)
├── shortcutFormat.ts            — 快捷键显示格式
├── template.ts                  — 绑定模板生成
├── useKeybinding.ts             — React Hook (6.8 KB)
├── useShortcutDisplay.ts        — 显示文本 Hook
├── validate.ts                  — 验证 + 冲突检测 (13.7 KB)
└── reservedShortcuts.ts         — 保留快捷键
```

### 6.2 绑定格式

```typescript
// src/keybindings/schema.ts
// 用户可以在 ~/.claude/keybindings.json 中自定义

// 绑定格式:
{
  "context": "Chat",
  "bindings": {
    "ctrl+shift+k": "chat:clearScreen",     // 绑定到动作
    "ctrl+x ctrl+e": "chat:externalEditor", // 和弦绑定
    "escape": null                            // 解绑
  }
}
```

### 6.3 和弦检测（Chord）

```typescript
// resolver.ts:32-175
// 和弦 = 两个连续的按键组合，如 Ctrl+X Ctrl+E

export type ChordResolveResult =
  | { type: 'match'; action: string }          // 完整匹配
  | { type: 'none' }                           // 无匹配
  | { type: 'unbound' }                        // 显式解绑
  | { type: 'chord_started'; pending: ParsedKeystroke[] }  // 和弦进行中
  | { type: 'chord_cancelled' }                // 和弦取消

// 使用示例:
// 1. 用户按 Ctrl+X → { type: 'chord_started', pending: [Ctrl+X] }
// 2. 等待下一个键...
// 3. 用户按 Ctrl+E → { type: 'match', action: 'chat:externalEditor' }
// 或者
// 3. 用户按其他键 → { type: 'chord_cancelled' }
```

### 6.4 按键匹配

```typescript
// src/keybindings/match.ts:29-120
export function matchesBinding(
  event: InputEvent,
  parsed: ParsedKeystroke
): boolean {
  // 1. 修饰符必须完全匹配
  if (event.key.ctrl !== parsed.ctrl) return false
  if (event.key.shift !== parsed.shift) return false
  if (event.key.meta !== parsed.alt) return false

  // 2. 键名匹配（标准化后比较）
  const eventKeyName = getKeyName(event)
  return eventKeyName === parsed.key
}
```

### 6.5 保留快捷键

```typescript
// src/keybindings/reservedShortcuts.ts
// 这些快捷键不能被用户覆盖
const RESERVED = [
  'ctrl+c',    // 中断
  'ctrl+d',    // EOF / 退出
  'ctrl+z',    // 挂起
]
```

---

## 7. 自动补全系统

### 7.1 补全来源

```typescript
// src/hooks/useTypeahead.tsx:81+
export function useTypeahead(props: Props): UseTypeaheadResult {
  // 5 种补全来源:
  // 1. 斜杠命令: /help, /clear, /config, ...
  // 2. 文件路径: @src/utils.ts, @package.json
  // 3. 目录路径: @src/components/
  // 4. Shell 历史
  // 5. Slack 频道 (如果集成了 Slack)
}
```

### 7.2 触发检测

```typescript
// src/hooks/useTypeahead.tsx
// 正则表达式检测触发模式

// @ 开头的路径引用
const AT_TOKEN_HEAD_RE = /^@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u
// 路径字符
const PATH_CHAR_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u
// 输入末尾的 token
const TOKEN_WITH_AT_RE = /(@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+)$/u
// @ 符号检测
const HAS_AT_SYMBOL_RE = /(^|\s)@([\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|"[^"]*"?)$/u

// 触发逻辑:
// 1. 输入以 '/' 开头 → 命令补全
// 2. 输入包含 '@' → 文件/目录补全
// 3. 输入以 '!' 开头 → Shell 历史补全
```

### 7.3 建议项类型

```typescript
// src/components/PromptInput/PromptInputFooterSuggestions.tsx:9-17
export type SuggestionItem = {
  id: string
  displayText: string           // 显示文本
  tag?: string                  // 标签（如 "MCP"）
  description?: string          // 描述文本
  metadata?: unknown            // 附加数据
  color?: keyof Theme           // 主题颜色
}

export type SuggestionType =
  | 'command'                   // /slash 命令
  | 'file'                      // 文件路径
  | 'directory'                 // 目录路径
  | 'agent'                     // 代理
  | 'shell'                     // Shell 历史
  | 'custom-title'              // 自定义标题
  | 'slack-channel'             // Slack 频道
  | 'none'                      // 无建议
```

### 7.4 补全 UI

```
补全浮层渲染:
┌─────────────────────────────────────────────┐
│  /he|                                       │  ← 用户正在输入
│  ┌─────────────────────────────────────┐    │
│  │ + /help         Show help           │    │  ← 选中项
│  │   /heapdump     Dump JS heap       │    │
│  │   /hooks        View hooks          │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘

图标含义:
  +  → 文件
  ◇  → MCP 命令
  *  → 代理

最大显示项数: OVERLAY_MAX_ITEMS = 5
```

### 7.5 补全选择与应用

```typescript
// Tab 或 ↓ 打开补全列表
// ↑/↓ 在列表中导航
// Tab/Enter 应用选中的补全项

function applyCommandSuggestion(suggestion: SuggestionItem) {
  // 1. 找到输入中的命令前缀
  // 2. 替换为完整命令名
  // 3. 添加尾部空格
  setInput('/' + suggestion.displayText + ' ')
  setCursorOffset(suggestion.displayText.length + 2)
}

function applyFileSuggestion(suggestion: SuggestionItem) {
  // 1. 找到输入中的 @ 前缀
  // 2. 替换为完整文件路径
  // 3. 如果路径有空格，用引号包裹
  const path = suggestion.metadata.path
  if (path.includes(' ')) {
    setInput(`@"${path}" `)
  } else {
    setInput(`@${path} `)
  }
}
```

---

## 8. 输入模式切换

### 8.1 三种输入模式

```typescript
// src/components/PromptInput/inputModes.ts

export type HistoryMode = 'prompt' | 'bash'

export function getModeFromInput(input: string): HistoryMode {
  if (input.startsWith('!')) return 'bash'
  return 'prompt'
}

export function getValueFromInput(input: string): string {
  const mode = getModeFromInput(input)
  if (mode === 'prompt') return input
  return input.slice(1)  // 去掉 '!' 前缀
}
```

```
模式检测:
├── 普通模式: "帮我写一个函数"     → prompt 模式
├── Bash 模式: "!ls -la src/"       → bash 模式（! 前缀）
├── 命令模式: "/help"               → 命令模式（/ 前缀）
└── Vim:       config.editorMode    → NORMAL/INSERT 切换
```

### 8.2 模式指示器 UI

```
状态栏显示:

普通模式:
  ▸ 输入你的问题...

Bash 模式:
  ! ls -la src/

Vim NORMAL 模式:
  [NORMAL] ▸ _

Vim INSERT 模式:
  [INSERT] ▸ 输入文本|
```

---

## 9. 关键设计决策

### 9.1 为什么用 cursorOffset 而不是 (row, col)？

```
选择 cursorOffset（全文偏移量）的原因:
├── 文本操作更简单: insert/delete 只需字符串 slice
├── 与 React 状态模型一致: 单一数据源
├── 避免 row/col 的同步问题: 文本变化时不需要重新计算
├── Vim 操作也基于偏移量: word/line/find 返回偏移量
└── 显示时再转换: offset → (row, col) 只在渲染时计算
```

### 9.2 为什么 Vim 模式用独立组件而不是条件逻辑？

```
VimTextInput vs TextInput:
├── 关注点分离: Vim 的复杂性不污染标准输入
├── Hook 不同: useVimInput vs useInput
├── 状态不同: VimState vs 普通 state
├── 测试独立: 可以单独测试 Vim 逻辑
└── 共享: 通过 props 共享回调和数据
```

### 9.3 为什么和弦检测在快捷键层而不是输入层？

```
Ctrl+X Ctrl+E (外部编辑器):
├── 第一个键 Ctrl+X 不应该输入到文本中
├── 需要等待第二个键来决定
├── 如果第二个键不匹配，需要"回退"第一个键
└── 这个逻辑在快捷键 resolver 中最自然
    → { type: 'chord_started' } → 等待 → { type: 'match' | 'chord_cancelled' }
```

---

## 10. 关键源码索引

| 功能 | 文件 | 行数 | 说明 |
|------|------|------|------|
| 按键解析 | `src/ink/parse-keypress.ts` | 800+ | raw stdin → ParsedKey |
| 输入事件 | `src/ink/events/input-event.ts` | 206 | ParsedKey → InputEvent |
| 输入 Hook | `src/ink/hooks/use-input.ts` | 92 | useInput() |
| 主输入组件 | `src/components/PromptInput/PromptInput.tsx` | ~2800 | 多行编辑 |
| Vim 类型 | `src/vim/types.ts` | 200 | VimState, CommandState |
| Vim 转换 | `src/vim/transitions.ts` | 490 | 状态机转换 |
| Vim Hook | `src/hooks/useVimInput.ts` | 250+ | useVimInput() |
| Vim 组件 | `src/components/VimTextInput.tsx` | — | Vim 模式 UI |
| 自动补全 | `src/hooks/useTypeahead.tsx` | 200+ | 补全引擎 |
| 补全 UI | `src/components/PromptInput/PromptInputFooterSuggestions.tsx` | 150+ | 补全浮层 |
| 快捷键解析 | `src/keybindings/resolver.ts` | 175 | 和弦状态机 |
| 快捷键匹配 | `src/keybindings/match.ts` | 120 | 修饰符+键名匹配 |
| 快捷键 Provider | `src/keybindings/KeybindingProviderSetup.tsx` | 41 KB | 全局 Provider |
| 绑定验证 | `src/keybindings/validate.ts` | 13.7 KB | 冲突检测 |
| 输入模式 | `src/components/PromptInput/inputModes.ts` | 34 | prompt/bash 模式 |

> **一句话总结**：Claude Code 的输入系统从 raw stdin 出发，经过转义序列解析、
> Vim 状态机、快捷键和弦检测、自动补全引擎，最终实现了一个媲美代码编辑器的
> 终端输入体验——在仅有字节流的 stdin 之上构建了完整的编辑语义。
