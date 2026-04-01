# Q: 如何安全地并发执行多个工具？

> 本文深入分析 Claude Code 的工具并发执行策略，包括分区算法、并发控制、以及 Promise.race 模式。

---

## 1. 核心问题

Claude 模型在单次响应中可能返回多个 tool_use blocks。例如：

```json
[
  {"name": "Grep", "input": {"pattern": "TODO"}},
  {"name": "Grep", "input": {"pattern": "FIXME"}},
  {"name": "Read", "input": {"file_path": "README.md"}},
  {"name": "Edit", "input": {"file_path": "src/index.ts", ...}},
  {"name": "Read", "input": {"file_path": "package.json"}},
  {"name": "Bash", "input": {"command": "npm test"}}
]
```

问题：
1. 哪些可以并发？哪些必须串行？
2. 如何在保持正确性的同时最大化并行度？
3. 并发数如何控制？
4. 结果如何按完成顺序 yield？

---

## 2. 分区策略 — partitionToolCalls

### 2.1 核心算法

```typescript
// src/services/tools/toolOrchestration.ts:L91-L116
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)

    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // 解析异常（如 shell-quote 失败）→ 保守处理，当作不安全
            return false
          }
        })()
      : false

    // 关键：连续的并发安全工具合并为一个批次
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

### 2.2 批次类型

```typescript
// src/services/tools/toolOrchestration.ts:L84
type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }
```

### 2.3 分区示例

输入序列：`[Grep, Grep, Read, Edit, Read, Read, Bash("rm")]`

分区结果：
```
Batch 1: {concurrent: true,  blocks: [Grep, Grep, Read]}  ← 3 个并发
Batch 2: {concurrent: false, blocks: [Edit]}                ← 1 个串行
Batch 3: {concurrent: true,  blocks: [Read, Read]}         ← 2 个并发
Batch 4: {concurrent: false, blocks: [Bash("rm")]}          ← 1 个串行
```

执行时序：
```
时间 →
      ┌─ Grep ─────┐
Batch 1 ├─ Grep ─────┤  (并发)
      ├─ Read ──────┤
      └─────────────┘
                     ┌─ Edit ────────┐
Batch 2              └───────────────┘  (串行)
                                      ┌─ Read ─┐
Batch 3                               ├─ Read ─┤  (并发)
                                      └────────┘
                                                ┌─ Bash ──────┐
Batch 4                                         └─────────────┘  (串行)
```

### 2.4 为什么保持原始顺序？

分区算法**不重排**工具调用的顺序。考虑这个序列：

```
[Read("a.ts"), Edit("b.ts"), Read("b.ts")]
```

如果重排为 `[Read("a.ts"), Read("b.ts"), Edit("b.ts")]`，则第二个 Read 可能在 Edit 之前执行，读到旧内容。保持原始顺序确保因果关系：
- Read("a.ts") 先执行（或与 Edit 并发但不影响）
- Edit("b.ts") 修改文件
- Read("b.ts") 读到修改后的内容

---

## 3. 并发安全性判断

### 3.1 哪些工具始终并发安全？

并发安全意味着：**多个实例同时执行不会产生竞态条件或数据不一致**。

```typescript
// 典型的并发安全工具
GrepTool:  isConcurrencySafe() { return true }   // 纯读取
GlobTool:  isConcurrencySafe() { return true }   // 纯读取
FileReadTool: isConcurrencySafe() { return true } // 纯读取
WebFetchTool: isConcurrencySafe() { return true } // 无副作用
WebSearchTool: isConcurrencySafe() { return true } // 无副作用
```

### 3.2 哪些工具始终必须串行？

```typescript
// 必须串行的工具
FileEditTool: isConcurrencySafe() { return false }  // 修改文件
FileWriteTool: isConcurrencySafe() { return false }  // 创建/覆写文件
AgentTool: isConcurrencySafe() { return false }      // 创建子代理
```

### 3.3 有条件并发的工具

BashTool 是最复杂的例子：

```typescript
// src/tools/BashTool/BashTool.tsx:L434-L438
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
isReadOnly(input) {
  // 对 shell 命令做静态分析
  // 例如: "grep foo *.ts" → true（只读）
  //       "rm -rf /tmp/x"  → false（有写入）
  //       "cat file.txt"   → true
  //       "echo x > file"  → false
}
```

同理，PowerShellTool 使用 `isReadOnlyCommand()` 分析 PowerShell 命令。

ConfigTool 根据操作类型判断：
```typescript
// src/tools/ConfigTool/ConfigTool.ts:L87-L91
isConcurrencySafe() { return false },  // 保守策略
isReadOnly(input: Input) {
  return input.action === 'get'  // 只有 get 是只读的
}
```

### 3.4 异常保护

```typescript
// src/services/tools/toolOrchestration.ts:L99-L107
const isConcurrencySafe = parsedInput?.success
  ? (() => {
      try {
        return Boolean(tool?.isConcurrencySafe(parsedInput.data))
      } catch {
        // 如 shell-quote 解析失败 → 当作不安全
        return false
      }
    })()
  : false  // schema 解析失败 → 也当作不安全
```

两层保护：
1. Zod schema 解析失败 → `false`
2. `isConcurrencySafe()` 抛异常 → `false`

始终 fail-closed（失败时保守处理）。

---

## 4. 并发执行引擎

### 4.1 runToolsConcurrently

```typescript
// src/services/tools/toolOrchestration.ts:L152-L177
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      // 标记为进行中
      toolUseContext.setInProgressToolUseIDs(prev =>
        new Set(prev).add(toolUse.id),
      )
      // 执行单个工具
      yield* runToolUse(toolUse, ..., canUseTool, toolUseContext)
      // 标记完成
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),  // 并发上限
  )
}
```

关键：**每个工具调用被包装为一个 AsyncGenerator**，然后通过 `all()` 函数并发运行，受并发上限约束。

### 4.2 并发上限

```typescript
// src/services/tools/toolOrchestration.ts:L8-L11
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}
```

默认并发上限：**10**。可通过环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 配置。

为什么是 10？
- 太少：多个 Grep/Read 并发时，CPU/IO 利用率不足
- 太多：大量并发 shell 命令可能耗尽系统资源
- 10 是一个合理的平衡点

---

## 5. 核心并发原语 — all() 函数

```typescript
// src/utils/generators.ts:L32-L72
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done, value, generator, promise,
      }))
    return promise
  }

  const waiting = [...generators]
  const promises = new Set<Promise<QueuedGenerator<A>>>()

  // 步骤 1: 启动初始批次（不超过并发上限）
  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!
    promises.add(next(gen))
  }

  // 步骤 2: Promise.race 循环
  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises)
    promises.delete(promise)

    if (!done) {
      // 生成器还有值 → 继续推进这个生成器
      promises.add(next(generator))
      if (value !== undefined) {
        yield value  // 立即 yield 完成的值
      }
    } else if (waiting.length > 0) {
      // 一个生成器完成了 → 从等待队列拉一个新的启动
      const nextGen = waiting.shift()!
      promises.add(next(nextGen))
    }
  }
}
```

### 5.1 工作原理图解

假设 3 个生成器，并发上限 2：

```
初始:   waiting = [G3]    promises = {G1.next(), G2.next()}

Race #1: G1 产出值 v1
         promises = {G1.next(), G2.next()}  ← G1 继续推进
         yield v1

Race #2: G2 产出值 v2
         promises = {G1.next(), G2.next()}
         yield v2

Race #3: G1 完成 (done=true)
         promises = {G2.next(), G3.next()}  ← 从 waiting 拉 G3
         // G3 取代了 G1 的并发槽位

Race #4: G3 产出值 v3
         promises = {G2.next(), G3.next()}
         yield v3

Race #5: G2 完成
         promises = {G3.next()}

Race #6: G3 完成
         promises = {}  ← 循环结束
```

### 5.2 关键特性

1. **按完成顺序 yield**: 不是按启动顺序，而是哪个先完成先 yield——UI 立即显示
2. **背压控制**: 并发槽位固定，一个完成才能启动下一个——防止资源耗尽
3. **每步产出一个值**: 每次 `.next()` 调用只推进一步，确保进度事件能及时传递

### 5.3 QueuedGenerator 类型

```typescript
// src/utils/generators.ts:L24-L29
type QueuedGenerator<A> = {
  done: boolean | void           // 是否完成
  value: A | void                // 产出的值
  generator: AsyncGenerator<A, void>  // 源生成器引用
  promise: Promise<QueuedGenerator<A>> // 自引用（用于 Set 删除）
}
```

`promise` 字段存储了对自身 Promise 的引用——这是 `promises.delete(promise)` 能工作的关键，因为 Promise.race 返回的是"获胜"的 promise 的值，而我们需要从 Set 中删除那个特定的 promise。

---

## 6. 串行执行路径

```typescript
// src/services/tools/toolOrchestration.ts:L118-L150
async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    // 标记进行中
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )

    for await (const update of runToolUse(toolUse, ..., currentContext)) {
      if (update.contextModifier) {
        // 立即应用上下文修改（串行才安全）
        currentContext = update.contextModifier.modifyContext(currentContext)
      }
      yield { message: update.message, newContext: currentContext }
    }

    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}
```

串行路径的关键区别：**contextModifier 立即应用**，因为后续工具可能依赖修改后的上下文。

---

## 7. Context Modifier 的并发处理

### 7.1 问题

并发执行时，多个工具可能都想修改上下文。如果立即应用，会出现竞态条件。

### 7.2 解决方案 — 延迟应用

```typescript
// src/services/tools/toolOrchestration.ts:L30-L63
if (isConcurrencySafe) {
  const queuedContextModifiers: Record<
    string,
    ((context: ToolUseContext) => ToolUseContext)[]
  > = {}

  // 执行阶段：收集但不应用
  for await (const update of runToolsConcurrently(...)) {
    if (update.contextModifier) {
      const { toolUseID, modifyContext } = update.contextModifier
      if (!queuedContextModifiers[toolUseID]) {
        queuedContextModifiers[toolUseID] = []
      }
      queuedContextModifiers[toolUseID].push(modifyContext)
    }
    yield { message: update.message, newContext: currentContext }
  }

  // 完成后：按原始顺序应用所有 modifier
  for (const block of blocks) {
    const modifiers = queuedContextModifiers[block.id]
    if (!modifiers) continue
    for (const modifier of modifiers) {
      currentContext = modifier(currentContext)
    }
  }
  yield { newContext: currentContext }
}
```

**关键设计**: 
1. 并发执行阶段只收集 modifiers，不应用
2. 批次完成后，按**原始 tool_use 顺序**（不是完成顺序）逐个应用
3. 这保证了确定性——相同的输入总是产生相同的最终上下文

---

## 8. 为什么某些工具必须串行？

### 8.1 FileEditTool

```
Edit("a.ts", old="x", new="y")  并发  Edit("a.ts", old="y", new="z")
```

如果并发执行：
- 两个 Edit 同时读取文件
- 第一个替换 x→y 并写入
- 第二个仍然在旧内容中搜索 y（可能找不到！）
- 或者两个写入互相覆盖

### 8.2 BashTool（非只读命令）

```
Bash("cd /project && npm install")  并发  Bash("npm test")
```

如果并发：npm test 可能在 install 完成前就运行了。

### 8.3 AgentTool

子代理会读写文件、执行命令——它本身就是一个"超级工具"，内部包含大量副作用。

---

## 9. 性能影响

### 9.1 并发 vs 串行时间对比

假设 3 个 Grep 各需 200ms，1 个 Edit 需 500ms：

**全串行**: 200 + 200 + 200 + 500 = 1100ms
**优化后**: max(200, 200, 200) + 500 = 700ms ← 节省 36%

实际场景中，模型经常同时请求多个搜索操作（"在这些文件中搜索..."），并发执行可以显著减少延迟。

### 9.2 并发上限的影响

当并发上限为 N 时，如果有 M 个并发安全工具（M > N）：
- 前 N 个立即启动
- 后 M-N 个排队等待
- 总时间 ≈ ceil(M/N) × 单个工具平均时间

默认 N=10 对大多数场景足够——一次性请求 10+ 个搜索操作非常罕见。

---

## 10. 辅助工具函数

### 10.1 标记完成状态

```typescript
// src/services/tools/toolOrchestration.ts:L179-L188
function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
```

UI 使用 `inProgressToolUseIDs` 来显示进度指示器——哪些工具正在执行，哪些已完成。

### 10.2 generators.ts 其他工具

```typescript
// lastX: 获取 AsyncGenerator 的最后一个值
export async function lastX<A>(as: AsyncGenerator<A>): Promise<A>

// returnValue: 获取 AsyncGenerator 的 return value
export async function returnValue<A>(as: AsyncGenerator<unknown, A>): Promise<A>

// toArray: 将 AsyncGenerator 收集为数组
export async function toArray<A>(generator: AsyncGenerator<A, void>): Promise<A[]>

// fromArray: 将数组转为 AsyncGenerator
export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void>
```

这些是 AsyncGenerator 的基础操作库，在整个代码库中广泛使用。

---

## 11. 关键总结

```
┌────────────────────────────────────────────────────────────┐
│                     工具并发执行架构                          │
│                                                             │
│  ToolUseBlocks                                              │
│       │                                                     │
│       ▼                                                     │
│  partitionToolCalls()                                       │
│       │                                                     │
│       ├──→ Batch(concurrent=true) ──→ runToolsConcurrently  │
│       │         │                          │                │
│       │         │                    all() + Promise.race   │
│       │         │                          │                │
│       │         │                    ┌─────┴─────┐          │
│       │         │                    │ cap = 10  │          │
│       │         │                    └─────┬─────┘          │
│       │         │                          │                │
│       │         └── context modifiers ──→ 延迟应用           │
│       │                                                     │
│       └──→ Batch(concurrent=false) ──→ runToolsSerially     │
│                  │                          │                │
│                  └── context modifiers ──→ 立即应用           │
└────────────────────────────────────────────────────────────┘
```

| 设计决策 | 选择 | 原因 |
|----------|------|------|
| 分区策略 | 连续合并，不重排 | 保持因果顺序 |
| 并发判断 | 输入感知 | 同一工具不同输入可以有不同策略 |
| 并发上限 | 10（可配置） | 平衡并行度和资源消耗 |
| 结果顺序 | 完成顺序 yield | UI 实时响应 |
| Context 修改 | 并发延迟，串行立即 | 避免竞态条件 |
| 异常处理 | Fail-closed | 不确定时当作不安全 |
