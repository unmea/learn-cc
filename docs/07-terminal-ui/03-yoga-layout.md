# Flexbox 在终端里如何工作？

> **Q: 终端只有字符网格，Flexbox 布局引擎是怎么跑起来的？**

---

## 1. 为什么终端需要布局引擎

### 1.1 问题：字符网格中的复杂布局

终端是一个固定宽度的字符网格（通常 80-240 列，24-60 行）。
你需要在这个网格中排布：

```
┌────────────────────────── 120 cols ──────────────────────────┐
│  ◇ Claude Code v2.1.88          [tokens: 12K] [cost: $0.03] │  行 1
│                                                               │
│  > 用户: 帮我重构这个函数                                    │  行 3-4
│                                                               │
│  ◈ Claude:                                                   │  行 6
│  ┌─────────────────────────────────────────────────────────┐ │  行 7
│  │ ```typescript                                           │ │
│  │ function processData(input: string[]): Result[] {       │ │  代码块
│  │   return input.map(item => transform(item))             │ │  (宽度自适应)
│  │ }                                                       │ │
│  │ ```                                                     │ │
│  └─────────────────────────────────────────────────────────┘ │  行 12
│                                                               │
│  ── Reading: src/utils.ts ─────────────────────── 3.2KB ──── │  行 14
│  ├─ function transform(item: string)                         │  行 15
│  └─ function validate(result: Result)                        │  行 16
│                                                               │
│  ▸ 输入区域                                                  │  底部
│    /help  /clear  /config                                    │  建议栏
└───────────────────────────────────────────────────────────────┘
```

手动计算这些位置？不行：
- 终端宽度可变（用户随时调整窗口大小）
- 消息数量动态变化
- 文本内容有 CJK 字符（双宽）、emoji、ANSI 颜色序列
- 嵌套组件（消息内的代码块内的高亮行）

你需要一个**真正的布局引擎**。

### 1.2 Yoga：Facebook 的 Flexbox 实现

[Yoga](https://yogalayout.dev/) 是一个跨平台的 Flexbox 布局引擎：
- **原始实现**：C++ → 编译为 WASM
- **用途**：React Native 的布局引擎
- **特点**：实现了 CSS Flexbox 规范的子集

```
Yoga 在不同平台的使用:
├── React Native (iOS/Android) — 原生控件布局
├── Litho (Facebook Android) — 声明式 UI
├── ComponentKit (Facebook iOS) — 声明式 UI
└── Claude Code (Terminal) — 字符网格布局  ← 这是个非典型用法
```

---

## 2. Yoga 在 Claude Code 中的集成

### 2.1 架构分层

```
src/ink/layout/ 目录结构:
├── node.ts      — LayoutNode 抽象接口（平台无关）
├── engine.ts    — 工厂函数（选择具体实现）
├── yoga.ts      — Yoga WASM 适配器（实现 LayoutNode）
└── geometry.ts  — 几何计算工具（Rectangle、Point）
```

**为什么有抽象层？**

```typescript
// src/ink/layout/engine.ts — 简洁的工厂
import { createYogaLayoutNode } from './yoga.js'
export function createLayoutNode(): LayoutNode {
  return createYogaLayoutNode()
}
```

虽然目前只有 Yoga 一种实现，但抽象层让未来可以替换布局引擎
（例如用纯 JS 实现，避免 WASM 依赖）。

### 2.2 LayoutNode 接口

```typescript
// src/ink/layout/node.ts:93+
export type LayoutNode = {
  // ── 树操作 ──
  insertChild(child: LayoutNode, index: number): void
  removeChild(child: LayoutNode): void
  getChildCount(): number
  getParent(): LayoutNode | null

  // ── 布局计算 ──
  calculateLayout(width?: number, height?: number): void
  setMeasureFunc(fn: LayoutMeasureFunc): void
  unsetMeasureFunc(): void
  markDirty(): void

  // ── 读取布局结果（calculateLayout 之后）──
  getComputedLeft(): number     // 相对于父节点的 X 偏移
  getComputedTop(): number      // 相对于父节点的 Y 偏移
  getComputedWidth(): number    // 计算后的宽度
  getComputedHeight(): number   // 计算后的高度
  getComputedBorder(edge: LayoutEdge): number
  getComputedPadding(edge: LayoutEdge): number

  // ── 样式设置（calculateLayout 之前）──
  setWidth(value: number): void
  setWidthPercent(value: number): void
  setWidthAuto(): void
  setHeight(value: number): void
  setHeightPercent(value: number): void
  setHeightAuto(): void
  setMinWidth(value: number): void
  setMinHeight(value: number): void
  setMaxWidth(value: number): void
  setMaxHeight(value: number): void
  setFlexDirection(dir: LayoutFlexDirection): void
  setFlexGrow(value: number): void
  setFlexShrink(value: number): void
  setFlexBasis(value: number): void
  setFlexWrap(wrap: LayoutWrap): void
  setAlignItems(align: LayoutAlign): void
  setAlignSelf(align: LayoutAlign): void
  setJustifyContent(justify: LayoutJustify): void
  setDisplay(display: LayoutDisplay): void
  getDisplay(): LayoutDisplay
  setPositionType(type: LayoutPositionType): void
  setPosition(edge: LayoutEdge, value: number): void
  setOverflow(overflow: LayoutOverflow): void
  setMargin(edge: LayoutEdge, value: number): void
  setPadding(edge: LayoutEdge, value: number): void
  setBorder(edge: LayoutEdge, value: number): void
  setGap(gutter: LayoutGutter, value: number): void

  // ── 生命周期 ──
  free(): void           // 释放 WASM 内存
  freeRecursive(): void  // 递归释放整棵子树
}
```

### 2.3 YogaLayoutNode 适配器

```typescript
// src/ink/layout/yoga.ts
import Yoga, {
  Align, Direction, Display, Edge, FlexDirection,
  Gutter, Justify, MeasureMode, Overflow,
  PositionType, Wrap,
  type Node as YogaNode,
} from 'src/native-ts/yoga-layout/index.js'

export class YogaLayoutNode implements LayoutNode {
  readonly yoga: YogaNode

  constructor(yoga: YogaNode) {
    this.yoga = yoga
  }

  // ── 布局计算 ──
  calculateLayout(width?: number, _height?: number): void {
    // 终端布局只需要宽度约束，高度由内容决定
    this.yoga.calculateLayout(width, undefined, Direction.LTR)
  }

  // ── MeasureFunc 适配 ──
  setMeasureFunc(fn: LayoutMeasureFunc): void {
    this.yoga.setMeasureFunc((w, wMode) => {
      // 将 Yoga 的 MeasureMode 映射到平台无关的枚举
      const mode =
        wMode === MeasureMode.Exactly   ? LayoutMeasureMode.Exactly :
        wMode === MeasureMode.AtMost    ? LayoutMeasureMode.AtMost :
                                          LayoutMeasureMode.Undefined
      return fn(w, mode)
    })
  }

  // ── 样式设置（示例）──
  setFlexDirection(dir: LayoutFlexDirection): void {
    this.yoga.setFlexDirection(FLEX_DIR_MAP[dir]!)
  }

  setDisplay(display: LayoutDisplay): void {
    this.yoga.setDisplay(
      display === 'flex' ? Display.Flex : Display.None
    )
  }

  setMargin(edge: LayoutEdge, value: number): void {
    this.yoga.setMargin(EDGE_MAP[edge]!, value)
  }

  // ... 更多样式方法遵循相同模式
}

// 常量映射表
const EDGE_MAP: Record<LayoutEdge, Edge> = {
  all: Edge.All,
  horizontal: Edge.Horizontal,
  vertical: Edge.Vertical,
  left: Edge.Left,
  right: Edge.Right,
  top: Edge.Top,
  bottom: Edge.Bottom,
  start: Edge.Start,
  end: Edge.End,
}

const FLEX_DIR_MAP = {
  'row': FlexDirection.Row,
  'row-reverse': FlexDirection.RowReverse,
  'column': FlexDirection.Column,
  'column-reverse': FlexDirection.ColumnReverse,
}
```

---

## 3. 样式系统：从 React Props 到 Yoga 属性

### 3.1 Styles 类型定义

```typescript
// src/ink/styles.ts:55+
export type Styles = {
  // ── 文本换行 ──
  readonly textWrap?:
    | 'wrap' | 'wrap-trim' | 'end' | 'middle'
    | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start'

  // ── 定位 ──
  readonly position?: 'absolute' | 'relative'
  readonly top?: number | `${number}%`
  readonly bottom?: number | `${number}%`
  readonly left?: number | `${number}%`
  readonly right?: number | `${number}%`

  // ── 间距 ──
  readonly gap?: number
  readonly columnGap?: number
  readonly rowGap?: number

  // ── 外边距 ──
  readonly margin?: number
  readonly marginX?: number
  readonly marginY?: number
  readonly marginTop?: number
  readonly marginBottom?: number
  readonly marginLeft?: number
  readonly marginRight?: number

  // ── 内边距 ──
  readonly padding?: number
  readonly paddingX?: number
  readonly paddingY?: number
  readonly paddingTop?: number
  readonly paddingBottom?: number
  readonly paddingLeft?: number
  readonly paddingRight?: number

  // ── Flex 属性 ──
  readonly flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly flexBasis?: number | `${number}%`
  readonly flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  readonly alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch'
  readonly justifyContent?:
    | 'flex-start' | 'center' | 'flex-end'
    | 'space-between' | 'space-around' | 'space-evenly'

  // ── 尺寸 ──
  readonly width?: number | `${number}%` | string
  readonly height?: number | `${number}%` | string
  readonly minWidth?: number | `${number}%` | string
  readonly minHeight?: number | `${number}%` | string
  readonly maxWidth?: number | `${number}%` | string
  readonly maxHeight?: number | `${number}%` | string

  // ── 显示 ──
  readonly display?: 'flex' | 'none'
  readonly overflow?: 'visible' | 'hidden' | 'scroll'

  // ── 边框 ──
  readonly borderStyle?: BorderStyle
  readonly borderColor?: Color
  readonly borderDimColor?: boolean
  readonly borderTop?: boolean
  readonly borderBottom?: boolean
  readonly borderLeft?: boolean
  readonly borderRight?: boolean
}
```

### 3.2 applyStyles — 将 Styles 映射到 Yoga

```typescript
// src/ink/styles.ts:757-768
export default function applyStyles(
  node: LayoutNode,
  style: Styles = {},
  resolvedStyle?: Styles,
): void {
  applyPositionStyles(node, style)    // position, top/bottom/left/right
  applyOverflowStyles(node, style)    // overflow: hidden/scroll/visible
  applyMarginStyles(node, style)      // margin + shorthands
  applyPaddingStyles(node, style)     // padding + shorthands
  applyFlexStyles(node, style)        // flex-direction, grow, shrink, etc.
  applyDimensionStyles(node, style)   // width, height, min/max
  applyDisplayStyles(node, style)     // display: flex/none
  applyBorderStyles(node, style, resolvedStyle)  // border width
  applyGapStyles(node, style)         // gap, columnGap, rowGap
}
```

每个 `apply*` 函数的模式：

```typescript
// src/ink/styles.ts:454 — 以 Margin 为例
const applyMarginStyles = (node: LayoutNode, style: Styles): void => {
  // 首先处理 shorthand
  if (style.margin !== undefined) {
    node.setMargin('all', style.margin)
  }

  // 然后处理 X/Y shorthand
  if (style.marginX !== undefined) {
    node.setMargin('horizontal', style.marginX)
  }
  if (style.marginY !== undefined) {
    node.setMargin('vertical', style.marginY)
  }

  // 最后处理具体方向（优先级最高）
  if (style.marginTop !== undefined) {
    node.setMargin('top', style.marginTop)
  }
  if (style.marginBottom !== undefined) {
    node.setMargin('bottom', style.marginBottom)
  }
  if (style.marginLeft !== undefined) {
    node.setMargin('left', style.marginLeft)
  }
  if (style.marginRight !== undefined) {
    node.setMargin('right', style.marginRight)
  }
}
```

### 3.3 百分比支持

```typescript
// src/ink/styles.ts:630 — 尺寸样式
const applyDimensionStyles = (node: LayoutNode, style: Styles): void => {
  // 宽度
  if (style.width !== undefined) {
    if (typeof style.width === 'string' && style.width.endsWith('%')) {
      node.setWidthPercent(parseFloat(style.width))    // ← 百分比
    } else if (typeof style.width === 'number') {
      node.setWidth(style.width)                        // ← 绝对值（字符列数）
    }
  }

  // 高度
  if (style.height !== undefined) {
    if (typeof style.height === 'string' && style.height.endsWith('%')) {
      node.setHeightPercent(parseFloat(style.height))
    } else if (typeof style.height === 'number') {
      node.setHeight(style.height)
    }
  }

  // min/max 同理...
}
```

所以百分比**是**支持的——但仅限于尺寸属性（width/height/min/max）。

---

## 4. calculateLayout：完整的布局过程

### 4.1 触发时机

```typescript
// src/ink/renderer.ts 中
export default function createRenderer(node, stylePool) {
  return options => {
    const { terminalWidth, terminalRows } = options

    // ⭐ 在每帧渲染前执行完整布局计算
    node.yogaNode?.calculateLayout(terminalWidth, undefined)
    //                              ↑ 宽度约束     ↑ 高度不约束

    // 布局计算后，每个节点可以读取：
    // yogaNode.getComputedLeft()   — X 偏移（字符列）
    // yogaNode.getComputedTop()    — Y 偏移（字符行）
    // yogaNode.getComputedWidth()  — 宽度（字符列）
    // yogaNode.getComputedHeight() — 高度（字符行）
  }
}
```

**关键理解**：

1. **宽度约束 = 终端列数**：`calculateLayout(80)` 意味着所有内容必须
   在 80 列内布局
2. **高度不约束**：高度由内容决定，内容多就高，少就矮
3. **单位是字符**：不是像素！`width: 40` 表示 40 个字符宽

### 4.2 文本测量：MeasureFunc

这是终端布局最关键的部分——Yoga 怎么知道一段文本占多少行？

```typescript
// src/ink/dom.ts 中（创建文本节点时设置 measureFunc）

function createTextMeasureFunc(node: DOMElement) {
  return (maxWidth: number, widthMode: LayoutMeasureMode) => {
    // 1. 收集所有子文本节点的内容
    const text = squashTextNodes(node)

    // 2. 计算文本宽度
    //    stringWidth() 处理 CJK（双宽）、emoji、ANSI 序列
    const textWidth = stringWidth(text)

    // 3. 根据 widthMode 决定换行
    if (widthMode === LayoutMeasureMode.Exactly) {
      // 精确宽度：按此宽度换行
      const wrapped = wrapText(text, maxWidth)
      return {
        width: maxWidth,
        height: wrapped.split('\n').length
      }
    }

    if (widthMode === LayoutMeasureMode.AtMost) {
      // 最大宽度约束：不超过 maxWidth
      if (textWidth <= maxWidth) {
        return { width: textWidth, height: 1 }
      }
      const wrapped = wrapText(text, maxWidth)
      return {
        width: maxWidth,
        height: wrapped.split('\n').length
      }
    }

    // Undefined：无约束，文本自然宽度
    return { width: textWidth, height: 1 }
  }
}
```

**为什么需要 measureFunc**：

Yoga 是一个通用布局引擎，它不知道"文本"是什么。对于 `ink-box`，
Yoga 可以通过子节点的尺寸来推断自身大小。但对于叶节点（文本），
Yoga 需要一个回调来测量内容尺寸。

### 4.3 stringWidth — CJK 和 emoji 的正确宽度

```typescript
// src/ink/stringWidth.ts — 终端字符宽度计算

// 问题：终端中不同字符占不同宽度
// 'a'      → 1 列
// '中'     → 2 列（CJK 字符）
// '😀'    → 2 列（emoji）
// '\x1b[31m' → 0 列（ANSI 转义序列不占宽度）

export function stringWidth(str: string): number {
  // 1. 剥离 ANSI 转义序列
  // 2. 遍历 grapheme clusters（处理 emoji 组合）
  // 3. 查询 Unicode East Asian Width
  //    - W (Wide) / F (Fullwidth) → 2 列
  //    - Na (Narrow) / H (Halfwidth) / N (Neutral) → 1 列
  // 4. 返回总列数
}
```

### 4.4 wrapText — 按终端宽度换行

```typescript
// src/ink/wrap-text.ts

export default function wrapText(text: string, maxWidth: number): string {
  // 1. 按 '\n' 分割为行
  // 2. 每行按 maxWidth 折行
  //    - 考虑 CJK 字符占 2 列
  //    - 不在单词中间断行（如果可能）
  //    - ANSI 序列不计入宽度
  // 3. 返回折行后的文本
}
```

---

## 5. 坐标映射：Yoga 结果 → ANSI 光标

### 5.1 坐标系

```
Yoga 坐标系（相对于父节点）:
  ┌──────── parent (60 cols, 10 rows) ────────────┐
  │  left=2, top=1                                 │
  │  ┌─── child (40 cols, 3 rows) ──────────┐     │
  │  │                                       │     │
  │  │                                       │     │
  │  └───────────────────────────────────────┘     │
  └────────────────────────────────────────────────┘

绝对坐标计算（renderNodeToOutput 中）:
  absoluteX = parentOffsetX + yogaNode.getComputedLeft()
  absoluteY = parentOffsetY + yogaNode.getComputedTop()
```

```typescript
// src/ink/render-node-to-output.ts:436-440
// 在递归渲染中累积偏移
const x = offsetX + yogaNode.getComputedLeft()
const yogaTop = yogaNode.getComputedTop()
const width = yogaNode.getComputedWidth()
const height = yogaNode.getComputedHeight()
```

### 5.2 从坐标到 Cell 写入

```typescript
// render-node-to-output.ts 中的文本渲染

// 对于文本节点：
// 1. squashTextNodesToSegments() — 合并文本，保留样式信息
// 2. wrapText(text, width) — 按宽度换行
// 3. 逐行、逐字符写入 Cell

for (let row = 0; row < lines.length; row++) {
  for (let col = 0; col < lineWidth; col++) {
    // setCellAt(screen, absoluteX + col, absoluteY + row, char, style)
    output.write(absoluteX + col, absoluteY + row, char, styleId, hyperlink)
  }
}
```

### 5.3 ANSI 光标定位

最终的 `diff()` 函数生成 ANSI 序列时，使用 `\x1b[row;colH` 定位光标：

```
ANSI 光标移动:
  \x1b[5;10H    — 移动光标到第 5 行、第 10 列
  \x1b[A        — 上移 1 行
  \x1b[B        — 下移 1 行
  \x1b[C        — 右移 1 列
  \x1b[D        — 左移 1 列
```

但 `diff()` 做了优化——如果连续的 Cell 都需要更新，不会每个 Cell 都发光标
移动命令，而是利用"写入字符后光标自动右移"的特性。

---

## 6. 实际布局示例

### 6.1 消息列表布局

```tsx
// 简化的消息列表
<Box flexDirection="column" overflow="scroll">     {/* 垂直排列，可滚动 */}
  <Box marginBottom={1}>                            {/* 消息 1 + 底部间距 */}
    <Box width={2}>                                 {/* 头像区（2 列宽） */}
      <Text>◈</Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>       {/* 内容区（填充剩余） */}
      <Text bold>Claude</Text>
      <Text>这是一段很长的回复文本...</Text>
    </Box>
  </Box>

  <Box marginBottom={1}>                            {/* 消息 2 */}
    <Box width={2}><Text>></Text></Box>
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>You</Text>
      <Text>请帮我修改这个函数</Text>
    </Box>
  </Box>
</Box>
```

Yoga 计算结果（假设终端 80 列）：

```
                0         10        20        30        40
                |         |         |         |         |
                ┌──────────────── 80 cols ────────────────┐
Row 0:          │◈ Claude                                 │  header
                │  这是一段很长的回复文本，如果超过 78   │  content
                │  列就会自动换行到下一行...               │  (wrap)
                │                                         │  marginBottom=1
Row 4:          │> You                                    │
                │  请帮我修改这个函数                     │
                │                                         │
                └─────────────────────────────────────────┘

Yoga 节点树：
root (80×7)
├── message-1 (80×3, top=0)
│   ├── avatar (2×1, left=0)        → "◈"
│   └── content (78×2, left=2)      → flexGrow=1, 填充剩余
│       ├── name (78×1, top=0)      → "Claude"
│       └── text (78×2, top=1)      → 自动换行
│
└── message-2 (80×2, top=4)         → top=3(内容)+1(margin)=4
    ├── avatar (2×1, left=0)        → ">"
    └── content (78×1, left=2)
        ├── name (78×1, top=0)      → "You"
        └── text (78×1, top=1)
```

### 6.2 工具调用布局

```tsx
// 工具调用的折叠/展开布局
<Box flexDirection="column" borderStyle="single" borderColor="gray">
  <Box justifyContent="space-between">
    <Text>Reading: src/utils.ts</Text>
    <Text dimColor>3.2KB</Text>
  </Box>
  {expanded && (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>function transform(item: string)</Text>
      <Text>function validate(result: Result)</Text>
    </Box>
  )}
</Box>
```

```
展开状态:
┌─────────────────────────────────────────────────────────┐
│ Reading: src/utils.ts                           3.2KB   │
│   function transform(item: string)                      │
│   function validate(result: Result)                     │
└─────────────────────────────────────────────────────────┘

Yoga 计算:
outer-box (80×4)
  ├── header-row (78×1, left=1, top=1)     ← border 占 1 行/列
  │   ├── title (60×1)                      ← justifyContent: space-between
  │   └── size (18×1)                       ← 右对齐
  └── content (76×2, left=3, top=2)         ← paddingLeft=2 + border=1
      ├── line1 (76×1)
      └── line2 (76×1)
```

---

## 7. Yoga 的限制

### 7.1 不支持的 CSS 特性

```
不支持:
├── float           — 没有浮动布局
├── grid            — 没有 CSS Grid
├── inline/block    — 只有 flex/none
├── text-align      — 需要手动实现（用 justifyContent 近似）
├── z-index         — 终端没有层叠概念
├── transform       — 没有变换
├── animation       — 没有 CSS 动画
├── media query     — 需要在 JS 层处理终端宽度变化
└── calc()          — 没有计算表达式
```

### 7.2 终端特有的限制

```
终端限制:
├── 单位只有"字符" — 不是像素，宽度精度为 1 列
├── 高度受限 — 终端只有 24-60 行可见
├── 无子像素渲染 — 1 字符是最小单位
├── CJK 双宽 — 中文字符占 2 列，影响布局对齐
├── 无浮动元素 — 不能让文本环绕图片
└── 滚动需自实现 — overflow: scroll 由 Ink 自己处理
```

### 7.3 百分比的局限

```typescript
// 支持百分比的属性:
width: '50%'        // ✅ 相对于父容器宽度
height: '100%'      // ✅ 相对于父容器高度
flexBasis: '30%'    // ✅ flex 基准值
position + top/left // ✅ 百分比定位

// 不支持百分比的属性:
margin: '10%'       // ❌ Yoga 不支持
padding: '5%'       // ❌ Yoga 不支持
gap: '2%'           // ❌
fontSize            // ❌ 终端没有字号概念
```

---

## 8. 性能考量

### 8.1 布局计算成本

```
Yoga calculateLayout() 性能:
├── 200 节点 → ~1ms
├── 500 节点 → ~2ms
├── 1000 节点 → ~4ms
└── 瓶颈不在 Yoga，而在文本测量 (stringWidth)

优化策略:
├── 只在 dirty 节点触发重新布局
├── MeasureFunc 结果由 Yoga 内部缓存
├── squashTextNodes 减少节点数量
└── 虚拟滚动减少同时存在的节点数
```

### 8.2 WASM 内存管理

```
Yoga 节点生命周期:
├── 创建: reconciler.createInstance() → createLayoutNode() → Yoga.Node.create()
├── 使用: applyStyles() + calculateLayout() + getComputed*()
└── 释放: reconciler.removeChild() → cleanupYogaNode() → yogaNode.free()

⚠️ 必须手动 free()！
├── Yoga 节点在 WASM 堆上分配
├── JS 垃圾回收器不知道 WASM 内存
├── 不 free() = WASM 内存泄漏
└── free 后不能再访问（use-after-free）
```

### 8.3 虚拟滚动

对于 2800+ 消息的长会话，不可能为每条消息都创建 Yoga 节点：

```tsx
// src/components/VirtualMessageList.tsx
// 只为视口内的消息创建节点
// 视口外的消息不参与布局计算
function VirtualMessageList({ messages, scrollTop }) {
  const visible = getVisibleMessages(messages, scrollTop, viewportHeight)
  return visible.map(msg => <Message key={msg.id} message={msg} />)
}
```

---

## 9. 边框渲染

### 9.1 边框样式

```typescript
// src/ink/render-border.ts
// Yoga 的 border 只影响布局（留出空间），不渲染可见边框
// 可见边框由 render-border.ts 单独处理

// 支持的边框样式:
type BorderStyle =
  | 'single'        // ┌─┐│└─┘
  | 'double'        // ╔═╗║╚═╝
  | 'round'         // ╭─╮│╰─╯
  | 'bold'          // ┏━┓┃┗━┛
  | 'singleDouble'  // ╓─╖║╙─╜
  | 'doubleSingle'  // ╒═╕│╘═╛
  | 'classic'       // +-+|+-+
  | 'arrow'         // ↘↓↙→←↗↑↖
```

### 9.2 边框与布局的关系

```
Yoga 视角（border = 1 意味着内容区缩小 2 行 2 列）:

total: 80×5
border-top: 1
border-bottom: 1
border-left: 1
border-right: 1
content-area: 78×3

渲染视角:
┌──────────────────────────────── 80 cols ──────────────────┐  ← row 0
│  content content content content content content content  │  ← row 1
│  content content content content content content content  │  ← row 2
│  content content content content content content content  │  ← row 3
└──────────────────────────────────────────────────────────┘  ← row 4
```

---

## 10. 关键源码索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/ink/layout/node.ts` | 200+ | LayoutNode 抽象接口 |
| `src/ink/layout/yoga.ts` | 300+ | YogaLayoutNode 适配器实现 |
| `src/ink/layout/engine.ts` | 6 | 工厂函数 |
| `src/ink/layout/geometry.ts` | 100+ | Rectangle/Point 工具 |
| `src/ink/styles.ts` | 771 | Styles 类型 + applyStyles |
| `src/ink/dom.ts` | 500+ | DOM 节点创建 + measureFunc |
| `src/ink/render-node-to-output.ts` | 1462 | 坐标映射 + Cell 写入 |
| `src/ink/stringWidth.ts` | 222 | CJK/emoji 宽度计算 |
| `src/ink/wrap-text.ts` | 74 | 文本按宽度换行 |
| `src/ink/render-border.ts` | 200+ | 边框字符渲染 |
| `src/native-ts/yoga-layout/` | — | Yoga WASM 绑定 |

> **一句话总结**：Yoga 把 CSS Flexbox 的布局算法带到了终端，让 Claude Code 的
> 389 个组件可以像写 Web 页面一样用 `flexDirection`、`flexGrow`、`padding`、
> `margin` 来声明布局，Yoga 负责计算每个字符应该出现在哪一行哪一列。
