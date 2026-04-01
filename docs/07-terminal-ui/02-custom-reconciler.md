# 如何实现自己的 React Renderer？

> **Q: React 是怎么渲染到终端的？自定义 Reconciler 的每一步是什么？**

---

## 1. React Renderer 的本质

### 1.1 React 的三层架构

```
┌─────────────────────────────────────────────────────┐
│  React Core (react 包)                               │
│  ├── JSX 转换、组件模型、Hooks                        │
│  ├── Fiber 调度器 — 决定什么时候更新什么               │
│  └── Reconciliation — diff 新旧 Fiber 树             │
│       ↓ 通过 HostConfig 接口与渲染器通信              │
├─────────────────────────────────────────────────────┤
│  react-reconciler (适配器层)                          │
│  ├── 提供 createReconciler(hostConfig)                │
│  └── 调用 hostConfig 的方法来操作"宿主环境"            │
│       ↓                                              │
├─────────────────────────────────────────────────────┤
│  Host Config 实现 (渲染目标)                          │
│  ├── react-dom → 浏览器 DOM                          │
│  ├── react-native → iOS/Android 原生控件              │
│  └── src/ink/reconciler.ts → 终端 DOMElement 树      │
└─────────────────────────────────────────────────────┘
```

**关键洞察**：React 的 diff 算法和调度器不关心你渲染到哪里。
只要你实现了 `HostConfig` 接口，React 就能渲染到**任何**目标。

### 1.2 HostConfig 的职责

```typescript
// react-reconciler 要求实现的接口（核心方法）
type HostConfig = {
  // 创建与管理
  createInstance(type, props, ...)  → 创建元素节点
  createTextInstance(text, ...)     → 创建文本节点

  // 树操作
  appendChild(parent, child)        → 添加子节点
  removeChild(parent, child)        → 移除子节点
  insertBefore(parent, child, before) → 在指定位置插入

  // 更新
  commitUpdate(node, type, oldProps, newProps) → 应用属性变更
  commitTextUpdate(node, oldText, newText)     → 更新文本内容

  // 生命周期
  prepareForCommit()     → 提交前的准备
  resetAfterCommit()     → 提交后的清理（触发渲染）
  finalizeInitialChildren() → 初始化子节点后的钩子

  // 特性标志
  supportsMutation: boolean     → 是否支持变更操作
  supportsPersistence: boolean  → 是否支持持久化模式
  supportsHydration: boolean    → 是否支持 SSR hydration
}
```

---

## 2. Claude Code 的 Reconciler 实现

### 2.1 文件位置与结构

```
源码: src/ink/reconciler.ts (512 行)

依赖关系:
reconciler.ts
  ├── import createReconciler from 'react-reconciler'
  ├── import { createNode, createTextNode, ... } from './dom.js'
  ├── import { LayoutDisplay } from './layout/node.js'
  ├── import applyStyles from './styles.js'
  ├── import { Dispatcher } from './events/dispatcher.js'
  └── import { getFocusManager, getRootNode } from './focus.js'
```

### 2.2 createInstance — 创建元素节点

```typescript
// src/ink/reconciler.ts:331
createInstance(
  originalType: ElementNames,   // 'ink-box' | 'ink-text' | 'ink-link' | ...
  newProps: AnyObject,
  rootNode: DOMElement,
  _hostContext: unknown,
  _internalHandle: OpaqueHandle,
): DOMElement {
  // 1. 创建 DOM 节点（带 Yoga 布局节点）
  const node = createNode(originalType)

  // 2. 分离事件处理器和普通属性
  for (const [key, value] of Object.entries(newProps)) {
    if (key === 'children') continue
    if (key === 'style') continue    // 样式单独处理
    if (key === 'internal_transform') continue

    if (EVENT_HANDLER_PROPS.has(key)) {
      // 事件处理器存储在 _eventHandlers 中
      // 不标记 dirty —— 避免处理器身份变更触发重绘
      node._eventHandlers ??= {}
      node._eventHandlers[key] = value
    } else {
      setAttribute(node, key, value as DOMNodeAttribute)
    }
  }

  // 3. 应用样式到 Yoga 节点
  if (newProps['style']) {
    applyStyles(node.yogaNode!, newProps['style'] as Styles)
    node.style = newProps['style'] as Styles
  }

  // 4. 调试信息：捕获组件栈（仅在 DEBUG 模式）
  if (debugRepaints) {
    node.debugOwnerChain = captureOwnerChain(_internalHandle)
  }

  return node
}
```

**设计要点**：
- 每个 React 元素对应一个 `DOMElement` + 一个 Yoga `LayoutNode`
- 事件处理器**不**标记 dirty——这是个关键优化，避免 handler identity 变化
  导致不必要的重绘
- 样式通过 `applyStyles()` 映射到 Yoga 的 Flexbox 属性

### 2.3 createTextInstance — 创建文本节点

```typescript
// src/ink/reconciler.ts:380 附近
createTextInstance(
  text: string,
  _rootNode: DOMElement,
  _hostContext: unknown,
  _internalHandle: OpaqueHandle,
): TextNode {
  return createTextNode(text)
}
```

文本节点比元素节点简单得多——只存储文本值，没有 Yoga 布局节点。
文本节点的尺寸由父级 `ink-text` 节点的 `measureFunc` 计算。

### 2.4 树操作：appendChild / removeChild

```typescript
// src/ink/reconciler.ts:391-464

appendInitialChild: appendChildNode,   // 初始构建时添加子节点
appendChild: appendChildNode,          // 更新时添加子节点
appendChildToContainer: appendChildNode,

removeChild(node, removeNode) {
  removeChildNode(node, removeNode)    // 从 DOM 树和 Yoga 树同时移除
  cleanupYogaNode(removeNode)          // 释放 Yoga WASM 内存
},

removeChildFromContainer(node, removeNode) {
  removeChildNode(node, removeNode)
  cleanupYogaNode(removeNode)
},

insertBefore(node, child, beforeChild) {
  insertBeforeNode(node, child, beforeChild)
},
```

`appendChildNode` 和 `removeChildNode` 的实现在 `dom.ts` 中，它们同时维护
两棵树：
1. **DOMElement 树** — `childNodes` 数组
2. **Yoga 节点树** — `yogaNode.insertChild()` / `yogaNode.removeChild()`

### 2.5 commitUpdate — 应用属性变更

```typescript
// src/ink/reconciler.ts:426-461
// React 19 的 commitUpdate 直接接收新旧 props（不再需要 prepareUpdate payload）
commitUpdate(
  node: DOMElement,
  _type: string,
  _oldProps: AnyObject,
  newProps: AnyObject,
): void {
  // 1. 遍历所有新属性
  for (const [key, value] of Object.entries(newProps)) {
    if (key === 'children') continue
    if (key === 'style') {
      // 样式更新：重新应用到 Yoga 节点
      const style = value as Styles
      applyStyles(node.yogaNode!, style)
      node.style = style
      continue
    }
    if (EVENT_HANDLER_PROPS.has(key)) {
      // 事件处理器更新：不标记 dirty
      node._eventHandlers ??= {}
      node._eventHandlers[key] = value
      continue
    }
    setAttribute(node, key, value as DOMNodeAttribute)
  }

  // 2. 检查被删除的属性
  // ...（检查 oldProps 中有但 newProps 中没有的属性）
}
```

**React 19 变更**：旧版 Ink 使用 `prepareUpdate()` 返回 updatePayload，
然后在 `commitUpdate()` 中应用。React 19 简化了这一步，直接传递新旧 props。

### 2.6 commitTextUpdate — 更新文本

```typescript
// src/ink/reconciler.ts 中
commitTextUpdate(node: TextNode, _oldText: string, newText: string): void {
  setTextNodeValue(node, newText)
}
```

### 2.7 hideInstance / unhideInstance — Suspense 支持

```typescript
// src/ink/reconciler.ts:381-390
hideInstance(node: DOMElement): void {
  node.isHidden = true
  node.yogaNode?.setDisplay(LayoutDisplay.None)
},

unhideInstance(node: DOMElement): void {
  node.isHidden = false
  // 恢复 display — 如果 style 里指定了 display，用它；否则默认 Flex
  node.yogaNode?.setDisplay(node.style?.display === 'none'
    ? LayoutDisplay.None
    : LayoutDisplay.Flex)
},
```

这些方法被 React Suspense 使用——当组件 suspend 时隐藏，ready 后恢复。
直接设置 Yoga 的 `Display.None` 让节点不参与布局计算。

### 2.8 生命周期钩子

```typescript
// src/ink/reconciler.ts:241-260

prepareForCommit(): null {
  // 提交前准备。返回 null 表示不需要保存任何恢复点
  return null
},

resetAfterCommit(rootNode: DOMElement): void {
  // ⭐ 提交后——这里触发实际的终端渲染！
  // rootNode 上挂载了 onRender 回调，由 ink.tsx 设置
  if (rootNode.onRender) {
    rootNode.onRender()
  }
  // 立即渲染回调（不经过帧调度）
  if (rootNode.onImmediateRender) {
    rootNode.onImmediateRender()
  }
},

finalizeInitialChildren(
  _node: DOMElement,
  _type: string,
  _props: AnyObject,
): boolean {
  // 返回 true 表示需要 commitMount
  return true
},

commitMount(node: DOMElement): void {
  // 节点首次挂载后执行
  // 调用 onComputeLayout 回调（如果有）
  node.onComputeLayout?.()
},
```

**核心机制**：`resetAfterCommit` 是触发渲染的关键——每次 React 完成一批
更新后调用，通知 `ink.tsx` 执行渲染管线。

### 2.9 特性标志

```typescript
// src/ink/reconciler.ts:404-410
isPrimaryRenderer: true,      // 这是主渲染器
supportsMutation: true,       // 使用变更模式（vs 持久化模式）
supportsPersistence: false,   // 不使用不可变树模式
supportsHydration: false,     // 不支持 SSR hydration
scheduleTimeout: setTimeout,
cancelTimeout: clearTimeout,
noTimeout: -1,
```

---

## 3. DOMElement 树：终端的虚拟 DOM

### 3.1 节点类型

```typescript
// src/ink/dom.ts

export type ElementNames =
  | 'ink-root'          // 根节点
  | 'ink-box'           // 容器（类似 <div>）
  | 'ink-text'          // 文本容器（类似 <span>）
  | 'ink-virtual-text'  // 虚拟文本（不创建 Yoga 节点）
  | 'ink-link'          // 超链接
  | 'ink-progress'      // 进度条
  | 'ink-raw-ansi'      // 原始 ANSI 字符串

export type TextName = '#text'  // 文本叶节点
```

### 3.2 DOMElement 结构

```typescript
// src/ink/dom.ts — 简化版
export type DOMElement = {
  // 基本属性
  nodeName: ElementNames
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  textStyles?: TextStyles

  // 布局
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode              // Yoga 布局节点
  style: Styles                       // Flexbox 样式

  // 渲染控制
  dirty: boolean                      // 需要重绘标记
  isHidden?: boolean                  // Suspense 隐藏

  // 事件处理
  _eventHandlers?: Record<string, unknown>

  // 滚动状态
  scrollTop?: number                  // 滚动偏移
  pendingScrollDelta?: number         // 待处理的滚动增量
  scrollHeight?: number               // 内容总高度
  scrollViewportHeight?: number       // 视口高度
  stickyScroll?: boolean              // 自动跟随底部
  scrollAnchor?: { el: DOMElement; offset: number }  // 锚点滚动

  // 生命周期回调
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void

  // 调试
  debugOwnerChain?: string[]          // React 组件栈
}
```

### 3.3 与浏览器 DOM 的关键区别

```
浏览器 DOM                          终端 DOMElement
─────────                          ────────────
节点类型多样                        只有 7 种元素 + 1 种文本
├─ div, span, p, a, ...            ├─ ink-box, ink-text, ink-link, ...
│                                  │
有事件委托                          无事件委托
├─ 事件冒泡 + 捕获                  ├─ 自定义 Dispatcher
├─ addEventListener()               ├─ _eventHandlers 直接存储
│                                  │
异步渲染                            同步提交
├─ 浏览器异步合成/绘制              ├─ resetAfterCommit → 立即渲染
│                                  │
CSS 引擎                            Yoga Flexbox Only
├─ Cascade, 选择器, Grid, Float     ├─ 只有 Flexbox 子集
├─ 百万级 CSS 属性                  ├─ ~30 个样式属性
│                                  │
文本布局                            手动文本测量
├─ 浏览器内置文本整形               ├─ stringWidth() 计算
├─ 自动换行                         ├─ wrapText() 手动换行
│                                  │
输出缓冲                            Cell 级双缓冲
├─ 浏览器合成器                     ├─ Screen → diff → ANSI
```

---

## 4. 渲染循环：从 React 树到终端输出

### 4.1 完整渲染管线

```
React Reconciler 完成一次 commit
         │
         ▼
resetAfterCommit()                    ← reconciler.ts:247
  │  rootNode.onRender()
  ▼
ink.tsx: throttledRender()            ← 帧调度（限制渲染频率）
  │
  ▼
renderer.ts: createRenderer()        ← 创建渲染函数
  │
  ├── 1. Yoga calculateLayout()      ← 计算所有节点的位置和尺寸
  │     rootNode.yogaNode.calculateLayout(terminalWidth, undefined)
  │
  ├── 2. renderNodeToOutput()        ← 遍历 DOM 树，写入 Cell
  │     ├── 递归遍历 DOMElement 树
  │     ├── 读取 yogaNode.getComputedLeft/Top/Width/Height()
  │     ├── 文本节点：squashTextNodes → wrapText → setCellAt()
  │     ├── Box 节点：递归子节点 + 边框渲染
  │     └── 滚动节点：计算 scrollTop、视口裁剪
  │
  ├── 3. Output.get()                ← 应用所有操作到 Screen 缓冲
  │     ├── 重置 backScreen
  │     ├── 执行 write/blit/clear/clip 操作
  │     └── 返回填充好的 Screen
  │
  ├── 4. diff(prevScreen, nextScreen) ← Cell 级差异比较
  │     ├── 逐行、逐列比较 Cell
  │     ├── 跳过相同的 Cell
  │     ├── 生成最小 ANSI 移动/写入序列
  │     └── 返回 ANSI 字符串
  │
  └── 5. process.stdout.write(ansi)   ← 输出到终端
```

### 4.2 Screen 的双缓冲机制

```typescript
// src/ink/renderer.ts — 双缓冲
export default function createRenderer(node, stylePool) {
  return options => {
    const { frontFrame, backFrame } = options
    const prevScreen = frontFrame.screen    // 当前显示的帧
    const backScreen = backFrame.screen     // 正在构建的帧

    // 1. 计算布局
    node.yogaNode.calculateLayout(terminalWidth, undefined)

    // 2. 渲染到后缓冲
    output = new Output({ width, height, stylePool, screen: backScreen })
    renderNodeToOutput(node, output, ...)

    // 3. 差异比较
    const ansi = diff(prevScreen, backScreen)

    // 4. 交换缓冲 — 后缓冲变成前缓冲
    return { screen: backScreen, output: ansi }
  }
}
```

双缓冲的好处：
- **无闪烁**：用户永远看到完整的帧，不会看到半渲染状态
- **最小更新**：只输出两帧之间的差异
- **池化**：`CharPool`、`HyperlinkPool`、`StylePool` 跨帧复用

### 4.3 renderNodeToOutput 详细流程

```typescript
// src/ink/render-node-to-output.ts:387
function renderNodeToOutput(
  node: DOMElement,
  output: Output,
  options: {
    offsetX: number
    offsetY: number
    // ... clip bounds, parent scroll state
  }
): void {
  const yogaNode = node.yogaNode!

  // 1. 读取 Yoga 计算结果
  const x = options.offsetX + yogaNode.getComputedLeft()
  const y = options.offsetY + yogaNode.getComputedTop()
  const width = yogaNode.getComputedWidth()
  const height = yogaNode.getComputedHeight()

  // 2. 跳过隐藏节点
  if (node.isHidden || yogaNode.getDisplay() === LayoutDisplay.None) return

  // 3. 检查是否在裁剪区域内
  // ...

  // 4. 根据节点类型渲染
  if (node.nodeName === 'ink-text') {
    // 文本节点：
    // a. squashTextNodesToSegments() — 合并相邻文本
    // b. wrapText() — 按宽度换行
    // c. 逐行写入 Cell
    const segments = squashTextNodesToSegments(node)
    const text = segments.map(s => s.text).join('')
    const wrapped = wrapText(text, width)
    // 写入 output...

  } else if (node.nodeName === 'ink-box') {
    // Box 节点：
    // a. 渲染背景色
    // b. 渲染边框
    // c. 递归渲染子节点
    renderBorder(node, x, y, width, height, output)
    for (const child of node.childNodes) {
      renderNodeToOutput(child, output, { offsetX: x, offsetY: y, ... })
    }

  } else if (node.nodeName === 'ink-raw-ansi') {
    // 原始 ANSI：直接写入
  }

  // 5. 滚动处理
  if (node.style?.overflow === 'scroll') {
    // 计算 scrollTop、视口裁剪
    // 硬件滚动提示（ScrollHint）
  }
}
```

---

## 5. 与 ReactDOM 的关键差异

### 5.1 差异对比表

| 方面 | ReactDOM | Ink Reconciler |
|------|----------|---------------|
| **createInstance** | document.createElement() | createNode() + Yoga node |
| **事件处理** | addEventListener + 委托 | _eventHandlers 直接存储 |
| **commit 模式** | 异步（浏览器合成器调度） | 同步（resetAfterCommit 立即渲染）|
| **输出目标** | 浏览器 DOM → 像素 | DOMElement → Cell → ANSI |
| **布局引擎** | CSS 引擎 | Yoga Flexbox |
| **文本测量** | 浏览器内置 | stringWidth() + measureText() |
| **输出缓冲** | 浏览器双缓冲 | 自定义 Screen 双缓冲 |
| **更新粒度** | DOM 属性级 | Cell 级 diff |
| **Hydration** | 支持 SSR hydration | 不支持 |
| **Persistence** | 不需要 | 不需要 |
| **Suspense** | display:none 或 内容隐藏 | yogaNode.setDisplay(None) |

### 5.2 同步 vs 异步提交

ReactDOM 的提交是"交给浏览器"——浏览器自己决定什么时候合成和绘制。

Ink 的提交是"自己控制"——`resetAfterCommit` 触发整个渲染管线，
从 Yoga 布局到 ANSI 输出都在一个同步调用中完成。

```typescript
// ReactDOM: commit 后浏览器异步绘制
// Ink: commit 后立即同步渲染

resetAfterCommit(rootNode) {
  // 这个回调最终触发:
  // Yoga 布局 → renderNodeToOutput → diff → stdout.write
  // 全部在一个事件循环 tick 内完成
  rootNode.onRender?.()
}
```

但 `ink.tsx` 会做**帧节流**：如果 React 在一帧内多次 commit，
只执行最后一次渲染。

### 5.3 无事件委托

浏览器 DOM 有复杂的事件传播机制（捕获 → 目标 → 冒泡）。
Ink 使用自定义的 `Dispatcher`，但没有事件委托：

```typescript
// 事件处理器直接存储在节点上
node._eventHandlers = {
  onClick: handler,
  onWheel: handler,
  // ...
}

// Dispatcher 处理事件分发
// 但没有 DOM 的冒泡/捕获机制
```

### 5.4 固定的输出缓冲

ReactDOM 可以渲染任意大小的页面（浏览器处理滚动）。
Ink 的输出缓冲大小固定为终端尺寸：

```typescript
// 输出被限制在 terminalWidth × terminalRows
const computedWidth = node.yogaNode?.getComputedWidth()
const computedHeight = node.yogaNode?.getComputedHeight()

// 超出终端尺寸的内容需要自己实现滚动
// → overflow: 'scroll' + scrollTop 状态
```

---

## 6. Yoga 节点与 DOM 节点的对应关系

```
React JSX 树:
<Box flexDirection="column">          ← 创建 ink-box + YogaNode
  <Text bold>Hello</Text>             ← 创建 ink-text + YogaNode(带 measureFunc)
  <Box flexDirection="row">           ← 创建 ink-box + YogaNode
    <Text>World</Text>                ← 创建 ink-text + YogaNode(带 measureFunc)
  </Box>
</Box>

DOMElement 树 (dom.ts):               Yoga 树 (layout/yoga.ts):
ink-box {                              YogaNode {
  style: { flexDirection: 'column' }     flexDirection: Column
  childNodes: [                          children: [
    ink-text {                             YogaNode {
      childNodes: [                          measureFunc: (w) => {
        #text { nodeValue: 'Hello' }           // 计算 "Hello" 的宽度和高度
      ]                                      }
    },                                     },
    ink-box {                              YogaNode {
      style: { flexDirection: 'row' }        flexDirection: Row
      childNodes: [                          children: [
        ink-text {                             YogaNode {
          childNodes: [                          measureFunc: (w) => { ... }
            #text { nodeValue: 'World' }       }
          ]                                  ]
        }                                  }
      ]                                  ]
    }                                  }
  ]
}

calculateLayout(80)  →  每个 YogaNode 获得:
                        getComputedLeft()  = x 偏移
                        getComputedTop()   = y 偏移
                        getComputedWidth() = 计算宽度
                        getComputedHeight()= 计算高度
```

---

## 7. 脏标记与渲染调度

### 7.1 markDirty 机制

```typescript
// src/ink/dom.ts
export function markDirty(node: DOMElement): void {
  node.dirty = true
  // 向上冒泡：确保祖先节点也知道需要重绘
  if (node.parentNode) {
    markDirty(node.parentNode)
  }
}
```

当以下情况发生时，节点被标记为 dirty：
1. `setAttribute()` — 属性变更
2. `setStyle()` — 样式变更
3. `appendChildNode()` — 添加子节点
4. `removeChildNode()` — 移除子节点
5. `setTextNodeValue()` — 文本变更

### 7.2 渲染调度

```typescript
// src/ink/ink.tsx 中的帧调度（简化）
class Ink {
  private scheduleRender() {
    // 节流：合并多次 commit 为一次渲染
    if (this.renderScheduled) return
    this.renderScheduled = true

    queueMicrotask(() => {
      this.renderScheduled = false
      this.render()
    })
  }

  private render() {
    // 1. Yoga 布局
    // 2. DOM → Cell 渲染
    // 3. 差异输出
  }
}
```

---

## 8. cleanupYogaNode — WASM 内存管理

```typescript
// src/ink/reconciler.ts:95-116
const cleanupYogaNode = (node: DOMElement | TextNode): void => {
  const yogaNode = node.yogaNode
  if (yogaNode) {
    yogaNode.unsetMeasureFunc()
    // ⭐ 清除所有引用 *在* free 之前
    // 防止其他代码在并发操作中访问已释放的 WASM 内存
    clearYogaNodeReferences(node)
    yogaNode.free()
  }

  // 递归清理子节点
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      cleanupYogaNode(child)
    }
  }
}
```

**为什么需要特别处理**：Yoga 运行在 WASM 中，其内存不受 JS 垃圾回收管理。
如果不手动 `free()`，会导致 WASM 内存泄漏。清除引用顺序很关键——
必须在 `free()` 之前清除所有 JS 引用，防止 use-after-free。

---

## 9. 调试支持

```typescript
// src/ink/reconciler.ts 中
// 环境变量: CLAUDE_CODE_DEBUG_REPAINTS

if (debugRepaints) {
  // createInstance 时捕获 React 组件栈
  node.debugOwnerChain = captureOwnerChain(_internalHandle)
  // 例如: ['ToolUseLoader', 'Messages', 'REPL']
}

// 这个调试信息用于:
// - findOwnerChainAtRow(): 定位哪个组件导致了全量重绘
// - 性能分析：识别不必要的重绘来源
```

```typescript
// Yoga 计数器（开发模式）
import { getYogaCounters } from 'src/native-ts/yoga-layout/index.js'
// 跟踪 Yoga 节点创建/释放数量，检测内存泄漏
```

---

## 10. 总结：自定义 Reconciler 的核心要素

实现一个 React 渲染器需要理解的关键概念：

```
必须实现:
├── createInstance()     — 你的"元素"长什么样？
├── createTextInstance() — 你的"文本节点"长什么样？
├── appendChild()        — 如何建立父子关系？
├── removeChild()        — 如何解除父子关系？
├── commitUpdate()       — 如何更新属性？
├── resetAfterCommit()   — 如何触发实际渲染？
└── supportsMutation     — 设为 true（最常用的模式）

Claude Code 的独特之处:
├── DOMElement + Yoga LayoutNode 的双树结构
├── Cell 级双缓冲差异渲染
├── 事件处理器不触发 dirty 标记
├── WASM 内存的手动生命周期管理
├── 布局位移检测优化
└── 同步渲染 + 帧节流
```

> **关键文件**：
> - `src/ink/reconciler.ts` — HostConfig 实现 (512 行)
> - `src/ink/dom.ts` — DOMElement 树 (500+ 行)
> - `src/ink/renderer.ts` — 渲染器工厂 (60+ 行)
> - `src/ink/render-node-to-output.ts` — DOM→Cell 渲染 (1462 行)
> - `src/ink/screen.ts` — Cell 级屏幕缓冲 (1486 行)
