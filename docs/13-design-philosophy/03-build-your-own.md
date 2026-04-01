# Q: 从零开始构建一个 AI 编码代理，推荐的技术栈和路线图是什么？

> **核心问题**：学习了 Claude Code 的全部架构后，如果你要从零构建自己的 AI 编码代理，应该选择什么技术栈？按什么顺序实现？每个组件的复杂度如何？常见陷阱是什么？

---

## 1. 推荐技术栈

### 1.1 核心技术选择

| 组件 | 推荐 | 替代方案 | Claude Code 用的 |
|------|------|---------|-----------------|
| **语言** | TypeScript | Go, Rust | TypeScript |
| **运行时** | Node.js ≥ 20 | Bun, Deno | Bun (内部) / Node (开源) |
| **UI 框架** | Ink 5 | blessed, 纯 ANSI | 自定义 Ink fork |
| **构建** | esbuild | tsup, Bun bundler | esbuild / Bun bundler |
| **状态管理** | Zustand 或自定义 Store | Redux, Jotai | 自定义 35 行 Store |
| **Schema 验证** | Zod | TypeBox, io-ts | Zod |
| **LLM SDK** | @anthropic-ai/sdk | openai, langchain | @anthropic-ai/sdk |
| **持久化** | SQLite (better-sqlite3) | JSONL | JSONL |
| **包管理** | pnpm | npm, yarn | npm |
| **测试** | Vitest | Jest | (无) |

### 1.2 为什么推荐这个组合？

```
TypeScript + Node.js:
├─ React 终端 UI 的唯一成熟选择
├─ async/await 完美适配 LLM 流式 API
├─ JSON 原生操作（LLM API 核心格式）
└─ npm 生态——所有 LLM SDK 都有 TS 版本

Ink 5 (不 fork):
├─ 除非你需要 Claude Code 级别的 UI 复杂度
├─ 原版 Ink 足够应付大多数场景
└─ fork 的维护成本远超你的预期 (19K+ LOC)

Zod:
├─ 工具输入验证（直接生成 JSON Schema 给 LLM）
├─ 运行时类型检查
└─ 与 TypeScript 类型系统深度集成

SQLite over JSONL:
├─ 如果你不需要 Claude Code 的极致 append-only 语义
├─ better-sqlite3 是同步 API，使用简单
└─ 自带索引和查询能力
```

---

## 2. 最小可行 Agent (MVA)

### 2.1 MVA 包含什么？

```
必须有 (V1):
├─ CLI 入口 — 接受用户输入
├─ LLM API 调用 — 流式请求/响应
├─ 主循环 — 用户→LLM→工具→LLM→... 循环
├─ 3 个基础工具 — 文件读/写 + Shell 执行
├─ 基础权限 — 文件写入和 Shell 执行需确认
└─ 流式输出 — 实时显示 LLM 响应

不需要 (V1 跳过):
├─ 丰富 UI — 纯文本即可
├─ 会话持久化 — 内存中保持
├─ 多模型支持 — 固定一个模型
├─ 上下文压缩 — 短对话不需要
├─ MCP — 后期扩展
└─ 多 Agent — 进阶功能
```

### 2.2 MVA 架构图

```
┌─────────────────────────────────────┐
│            CLI Entry                │
│  process.argv → readline interface  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│          Main Loop                  │
│  while (true) {                     │
│    userInput = await readline()     │
│    response = await* query(input)   │
│    if (response.hasToolUse)         │
│      result = await executeTool()   │
│      continue // 将结果发回 LLM     │
│  }                                  │
└──────────────┬──────────────────────┘
               │
      ┌────────┼────────┐
      ▼        ▼        ▼
┌──────┐  ┌──────┐  ┌──────┐
│ Read │  │ Write│  │ Shell│
│ File │  │ File │  │ Exec │
└──────┘  └──────┘  └──────┘
```

### 2.3 MVA 代码量估算

```
文件               预估行数    说明
──────────────────────────────────────
index.ts           50         CLI 入口
mainLoop.ts        150        主循环 (AsyncGenerator)
apiClient.ts       100        LLM API 包装
tools/index.ts     30         工具注册
tools/readFile.ts  60         文件读取
tools/writeFile.ts 80         文件写入 + 确认
tools/shell.ts     100        Shell 执行 + 确认
permissions.ts     50         简单 Y/N 确认
stream.ts          80         流式输出
──────────────────────────────────────
总计               ~700 行     一天可完成
```

---

## 3. 实现路线图

### Phase 1：核心循环 (1-2 天)

**目标**：用户输入 → LLM 回复 → 显示

```typescript
// 最简主循环
async function* query(messages: Message[]): AsyncGenerator<StreamChunk> {
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    messages,
    max_tokens: 4096,
  })
  
  for await (const chunk of stream) {
    yield chunk
  }
}

// REPL
const rl = readline.createInterface({ input: stdin, output: stdout })
const messages: Message[] = []

while (true) {
  const input = await rl.question('> ')
  messages.push({ role: 'user', content: input })
  
  let response = ''
  for await (const chunk of query(messages)) {
    process.stdout.write(chunk.text)
    response += chunk.text
  }
  
  messages.push({ role: 'assistant', content: response })
}
```

> 📖 **参考**: [01-Agent 解剖/03-主循环设计](/01-agent-anatomy/03-main-loop-design)

**关键学习**：
- AsyncGenerator 天然支持流式输出和背压
- 消息数组是最简单的"记忆"——每次把全部历史发给 API

### Phase 2：工具系统 (2-3 天)

**目标**：LLM 可以调用工具读写文件和执行命令

```typescript
// 工具接口（简化版）
type Tool = {
  name: string
  description: string
  inputSchema: z.ZodType
  call(input: unknown): Promise<string>
}

// 注册工具
const tools: Tool[] = [readFileTool, writeFileTool, shellTool]

// 在 API 调用中传递工具
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  messages,
  tools: tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.inputSchema),
  })),
})

// 处理 tool_use
if (response.stop_reason === 'tool_use') {
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const tool = tools.find(t => t.name === block.name)
      const result = await tool.call(block.input)
      // 将结果发回 LLM...
    }
  }
}
```

> 📖 **参考**: [03-工具系统/01-工具抽象](/03-tool-system/01-tool-abstraction), [03-工具系统/03-执行管线](/03-tool-system/03-tool-execution-pipeline)

**关键学习**：
- 用 Zod Schema 同时做验证和生成 JSON Schema
- 工具错误不终止对话——返回错误文本给 LLM
- LLM 会自动学习调整工具调用参数

### Phase 3：权限系统 (1-2 天)

**目标**：文件写入和 Shell 执行前需要用户确认

```typescript
// 最简权限检查
async function checkPermission(tool: Tool, input: unknown): Promise<boolean> {
  if (tool.isReadOnly) return true  // 读取不需要确认
  
  console.log(`\n⚠️  ${tool.name} wants to:`)
  console.log(`   ${tool.describe(input)}`)
  
  const answer = await question('Allow? [y/N] ')
  return answer.toLowerCase() === 'y'
}
```

> 📖 **参考**: [04-权限与安全/01-权限架构](/04-permission-and-safety/01-permission-architecture)

**关键学习**：
- 开始简单（Y/N 确认），之后再增加复杂度
- 读取操作默认允许，写入操作默认拒绝
- 记录已允许的操作模式，避免反复询问

### Phase 4：终端 UI (3-5 天)

**目标**：从 readline 升级到 React 终端 UI

```typescript
// 使用 Ink
import { render, Box, Text } from 'ink'

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  
  return (
    <Box flexDirection="column">
      {messages.map(m => <MessageView key={m.id} message={m} />)}
      <InputBox value={input} onChange={setInput} onSubmit={handleSubmit} />
    </Box>
  )
}

render(<App />)
```

> 📖 **参考**: [07-终端 UI/01-为什么用 React](/07-terminal-ui/01-why-react-in-terminal), [07-终端 UI/04-组件设计](/07-terminal-ui/04-component-design-system)

**关键学习**：
- Ink 的 `useInput` hook 处理键盘输入
- Flexbox 布局在终端中工作得很好
- 先做功能，UI 美化可以后期迭代

### Phase 5：上下文管理 (2-3 天)

**目标**：系统提示词 + 上下文压缩

```typescript
// 系统提示词
const systemPrompt = `You are a coding assistant.
Current directory: ${process.cwd()}
Git branch: ${await getGitBranch()}
Available tools: ${tools.map(t => t.name).join(', ')}
`

// 简单的压缩策略
function compactMessages(messages: Message[]): Message[] {
  if (estimateTokens(messages) < MAX_TOKENS * 0.8) return messages
  
  // 策略 1: 截断旧消息
  // 策略 2: 摘要旧对话
  // 策略 3: 移除工具结果详情
}
```

> 📖 **参考**: [06-上下文工程/01-系统提示词](/06-context-engineering/01-system-prompt-design), [06-上下文工程/03-压缩策略](/06-context-engineering/03-compaction-strategies)

**关键学习**：
- 系统提示词应包含环境上下文（cwd、git 状态）
- Token 预算管理是必须的——对话会增长到超过上下文窗口
- Prompt Cache 友好的设计：保持 system prompt 稳定

### Phase 6：会话持久化 (1-2 天)

**目标**：对话可保存和恢复

> 📖 **参考**: [05-状态管理/02-会话持久化](/05-state-management/02-session-persistence)

### Phase 7：多模型支持 (1-2 天)

**目标**：支持切换模型、模型降级

> 📖 **参考**: [02-LLM 集成/04-模型选择](/02-llm-integration/04-model-selection)

### Phase 8：MCP 集成 (3-5 天)

**目标**：支持外部 MCP 工具服务器

> 📖 **参考**: [10-MCP 协议/01-基础](/10-mcp-protocol/01-mcp-fundamentals)

### Phase 9：多 Agent (5-7 天)

**目标**：Coordinator + Worker 模式

> 📖 **参考**: [09-多 Agent/02-协调器模式](/09-multi-agent/02-coordinator-pattern), [09-多 Agent/04-Worktree 隔离](/09-multi-agent/04-worktree-isolation)

---

## 4. 各组件复杂度估算

```
组件                    复杂度    Claude Code 代码量    MVA 估计
────────────────────────────────────────────────────────────────
CLI 入口                ★☆☆☆☆    ~200 行              ~50 行
主循环 (AsyncGenerator)  ★★★☆☆    ~1,700 行 (query.ts)  ~200 行
LLM API 客户端          ★★☆☆☆    ~500 行              ~100 行
流式处理                ★★☆☆☆    ~800 行              ~100 行
工具接口                ★★☆☆☆    ~800 行 (Tool.ts)     ~100 行
工具实现 (3个)          ★★☆☆☆    ~3,000 行            ~250 行
权限系统                ★★★★☆    ~5,000 行            ~100 行
终端 UI                 ★★★★★    ~20,000 行 (ink/)     ~500 行
上下文压缩              ★★★★☆    ~2,000 行            ~300 行
会话持久化              ★★☆☆☆    ~1,500 行            ~200 行
多模型支持              ★★★☆☆    ~1,000 行            ~200 行
MCP 集成                ★★★★☆    ~3,500 行            ~500 行
多 Agent                ★★★★★    ~2,500 行            ~800 行
成本追踪                ★★☆☆☆    ~500 行              ~100 行
Git 集成                ★★★☆☆    ~3,000 行            ~200 行
────────────────────────────────────────────────────────────────
总计                               ~45,000 行           ~3,700 行
```

---

## 5. 常见陷阱与规避策略

### 陷阱 1：忽视 Token 预算管理

```
❌ 错误做法:
   每次把所有历史消息发给 API
   → 对话长了超过上下文窗口
   → API 报错 "prompt too long"

✅ 正确做法:
   1. 估算每条消息的 token 数 (字符数 ÷ 4 粗略估计)
   2. 在发送前检查总 token 数
   3. 超预算时触发压缩 (截断/摘要/移除工具详情)
   4. 预留 ~20% 空间给 LLM 回复
```

### 陷阱 2：工具错误终止对话

```
❌ 错误做法:
   工具抛异常 → catch → 显示错误 → 结束对话

✅ 正确做法:
   工具抛异常 → catch → 将错误文本作为 tool_result 返回给 LLM
   → LLM 会尝试修复参数或换用其他工具
```

### 陷阱 3：没有背压的流式输出

```
❌ 错误做法:
   for await (chunk of stream) {
     process.stdout.write(chunk)  // 如果终端慢呢？
   }

✅ 正确做法:
   使用 AsyncGenerator yield，让消费者控制速度
   或者用 Node.js Stream 的 pipe + 背压机制
```

### 陷阱 4：权限系统太晚设计

```
❌ 错误做法:
   先实现全部功能，最后加权限
   → 发现权限需要改每个工具的接口
   → 大规模重构

✅ 正确做法:
   在 Phase 2 (工具系统) 时就设计权限接口
   即使 V1 只是简单的 Y/N 确认
```

### 陷阱 5：Prompt Cache 频繁失效

```
❌ 错误做法:
   system prompt 包含时间戳、随机 ID 等动态内容
   → 每次请求 system prompt 都不同
   → Prompt Cache 永远无法命中

✅ 正确做法:
   system prompt 保持稳定不变
   动态信息放在 user message 中
   工具列表排序稳定
```

### 陷阱 6：未处理的进程退出

```
❌ 错误做法:
   用户 Ctrl+C → 进程立即退出
   → 未保存的会话丢失
   → 终端模式未恢复 (鼠标追踪、光标隐藏等)

✅ 正确做法:
   process.on('SIGINT', async () => {
     await saveSession()
     restoreTerminal()
     process.exit(0)
   })
```

### 陷阱 7：低估终端 UI 复杂度

```
❌ 错误做法:
   "终端 UI 很简单，我用 console.log 就行"
   → 多行输出交错
   → 进度条闪烁
   → 窗口调整崩溃

✅ 正确做法:
   从第一天就用 Ink 或类似框架
   组件化思维处理终端 UI
   或者 V1 用纯文本，V2 再上 React
```

---

## 6. 一周 MVP 计划

如果你只有一周时间：

```
Day 1: 搭建项目 + 主循环
├─ TypeScript + esbuild 项目初始化
├─ 实现 readline REPL
└─ 接入 Claude API，流式输出

Day 2: 工具系统
├─ 实现 Tool 接口 (简化版)
├─ 实现 readFile, writeFile, shell 三个工具
└─ 处理 tool_use → tool_result 循环

Day 3: 权限 + 错误处理
├─ Y/N 确认机制
├─ 工具错误返回给 LLM (不终止对话)
└─ 信号处理 (SIGINT graceful shutdown)

Day 4: 上下文管理
├─ 系统提示词 (cwd, git 信息, 工具列表)
├─ 简单 token 估算
└─ 基础压缩 (截断旧消息)

Day 5: 会话与 UI
├─ JSONL 会话保存/恢复
├─ 升级到 Ink UI (可选)
└─ 成本追踪 (token 计数 + 定价)

Day 6-7: 打磨与扩展
├─ 更多工具: grep, glob, 文件编辑
├─ 改进错误处理和重试
└─ 打包发布 (npm publish)
```

---

## 7. 从 Claude Code 学到的设计原则

### 原则 1：Agent 的瓶颈是 LLM，不是本地

```
LLM API 延迟: 200-2000ms
本地代码执行: 1-50ms
→ 优化本地代码带来的收益有限
→ 重点优化：减少 API 调用次数、提高 Cache 命中率
```

### 原则 2：Fail-Open 优于 Fail-Closed

```
工具失败 → 返回错误给 LLM → LLM 自动尝试修复
UI 组件崩溃 → 渲染为空 → 对话继续
API 超时 → 自动重试 → 用户无感知
```

### 原则 3：简单性 > 功能性

```
35 行 Store > Redux
JSONL > SQLite (对于日志场景)
接口 > 类 (对于树摇场景)
```

### 原则 4：安全是硬约束

```
权限 Fail-Closed (不像工具 Fail-Open)
文件写入必须确认
Shell 执行必须确认
永远不自动执行用户未授权的操作
```

### 原则 5：为扩展留出接口

```
MCP 让第三方可以添加工具
Feature Flag 让功能可以按需启用
接口驱动让工具注册不需要修改核心代码
```

---

## 8. 最终建议

如果你要构建 AI 编码代理：

1. **不要从零造轮子**——Claude Code 的架构提供了完美的参考蓝本
2. **先做最简版本** (700 行)，验证核心循环可行
3. **权限从第一天设计**，即使实现很简单
4. **Token 管理不可忽视**——它会在用户最不期望的时候出问题
5. **工具错误是 LLM 的输入**，不是你的应用的异常
6. **终端 UI 用框架**——手写 ANSI 是一条不归路
7. **从 Claude Code 的 learn/ 系列中学习每个子系统的设计决策**

祝你构建出优秀的 AI 编码代理！🚀
