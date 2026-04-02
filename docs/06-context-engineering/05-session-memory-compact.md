# Q: SessionMemory 系统如何实现"零感知压缩"？

> **一句话回答**：通过在对话过程中持续用后台 LLM 提取关键信息写入磁盘，在触发压缩时直接读文件重组消息，彻底跳过 15~30 秒的在线摘要等待。

---

## 为什么这个问题重要

传统的 `compactConversation` 有一个痛点：用户在某次消息后突然等待 30 秒，完全打断心流。对于高频使用编码 Agent 的开发者，这种强制停顿是显著的体验伤害。

SessionMemory 提出了一种完全不同的成本模型：**把 LLM 费用从压缩时刻分摊到整个对话过程**，让压缩变得几乎不可感知。

---

## 深度解答

### Q1：SM 压缩时真的不调用 LLM 吗？

**是的**。`trySessionMemoryCompaction()` 全程零 API 调用：

```typescript
export async function trySessionMemoryCompaction(
  messages: Message[],
  autoCompactThreshold: number,
): Promise<CompactionResult | null> {
  // Step 1: 等待后台提取完成（最多 15s，通常已完成）
  await waitForSessionMemoryExtraction()

  // Step 2: 读取磁盘文件（~/.claude/.../session-memory.md）
  const sessionMemory = await getSessionMemoryContent()
  if (!sessionMemory || isSessionMemoryEmpty(sessionMemory)) return null

  // Step 3: 找到边界指针
  const lastSummarizedId = getLastSummarizedMessageId()
  const lastSummarizedIndex = messages.findIndex(m => m.uuid === lastSummarizedId)
  if (lastSummarizedIndex === -1) return null

  // Step 4: 计算保留多少条最近消息（10K~40K tokens）
  const keepFromIndex = calculateMessagesToKeepIndex(
    messages,
    lastSummarizedIndex,
    { minTokens: 10_000, maxTokens: 40_000 }
  )

  // Step 5: 组合摘要 + 最近消息，构建 CompactionResult
  return createCompactionResultFromSessionMemory(
    sessionMemory,
    messages.slice(keepFromIndex)
  )
  // 全程 < 50ms，无网络请求
}
```

### Q2：LLM 到底在哪里被调用？

在**后台**，每隔几轮对话就有一次异步 LLM 调用：

```
[主线程] Turn 3 响应完成
         │
         ├── [用户看到答案，开始阅读]
         │
         └── [后台, void] extractSessionMemory()
               ├── buildSessionMemoryUpdatePrompt(currentMemo, messages)
               │     ↓ 包含：当前 .md 内容 + 最近若干轮对话
               └── runForkedAgent(...)
                     ↓ 子 agent 读完整对话上下文
                     ↓ LLM 调用（花费 2~5 秒）
                     ↓ file_edit: 更新 session-memory.md
                     ↓ 完成，主线程已经在处理 Turn 4 了
```

### Q3：子 agent 做了什么？为什么安全？

子 agent 通过 `runForkedAgent` 启动，具有严格的权限沙箱：

```typescript
const canUseTool: CanUseToolFn = async (tool, input) => {
  // 只允许对 session-memory.md 使用 file_edit
  if (tool.name === FILE_EDIT_TOOL_NAME &&
      input.file_path === memoryPath) {
    return { behavior: 'allow', updatedInput: input }
  }
  return {
    behavior: 'deny',
    message: `Session memory agent can only edit ${memoryPath}`
  }
}
```

子 agent **不能读写任何其他文件**，不能执行命令，不能访问网络。它只有一个技能：更新 `.md` 文件中的 10 个章节。

子 agent 使用 `createCacheSafeParams(context)` 共享主线程的 prompt cache，大幅减少实际 token 消耗。

### Q4：触发阈值是什么？

双重阈值，token 增长是必要条件：

```typescript
const DEFAULT_SESSION_MEMORY_CONFIG = {
  minimumMessageTokensToInit: 10_000,  // 首次提取的最低 token 数
  minimumTokensBetweenUpdate: 5_000,   // 两次提取间的最小 token 增长
  toolCallsBetweenUpdates: 3,          // 两次提取间的最小工具调用次数
}
```

**触发逻辑**：token 增长 ≥ 5000 AND (工具调用 ≥ 3 OR 当前轮无工具调用)

### Q5：session 重启后 SM 还能用吗？

**部分可用**。磁盘文件 `.md` 在 session 间持久化，但 `lastSummarizedMessageId` 是**纯内存状态**，重启后为 `undefined`：

```typescript
let lastSummarizedMessageId: string | undefined  // 模块级变量，重启丢失
```

结果：新 session 中无法找到边界，`sessionMemoryCompact` 返回 null，fallback 到 `compactConversation`。但 `.md` 文件中的历史摘要仍然有价值——下次 SM hook 运行时会在此基础上更新，不会从零开始。

### Q6：SessionMemory 会替代 compactConversation 吗？

**短期不会，长期不确定**。原因：

1. `sessionMemoryCompact` 明确标注为实验性功能
2. 需要两个 feature flag 同时开启才激活
3. `.md` 文件丢失/损坏时必须 fallback 到 LLM 摘要
4. 还存在一个更根本的竞争方案 `ContextCollapse`（90%/95% 双阈值完全不同范式）

更可能的演进路径：SM 作为"压缩加速器"长期与 `compactConversation` 共存，而非替代。

---

## 压缩方式 Before/After 对比

以下是统一场景：用户在修复 TypeScript 类型错误，对话共 8 轮，约 12 万 token。

### 场景设置

```typescript
// 原始消息数组（简化）
messages = [
  { role: 'user',      content: '帮我修复 auth.ts 里的类型错误' },
  { role: 'assistant', content: '我来看看...', tool_calls: [read_file] },
  { role: 'user',      content: [tool_result: auth.ts 全文 8000 tokens] },
  { role: 'assistant', content: '发现了3个错误...', tool_calls: [edit_file] },
  { role: 'user',      content: [tool_result: 修改成功] },
  // ... 更多轮次，累计 12万 token
  { role: 'user',      content: '现在运行测试' },
  { role: 'assistant', content: '好的', tool_calls: [bash] },
  { role: 'user',      content: [tool_result: 测试结果 6000 tokens] },
  { role: 'assistant', content: '所有测试通过！' },  // lastSummarizedMessageId 指向这里
  { role: 'user',      content: '现在提交代码' },
  { role: 'assistant', content: '我来帮你写 commit message' },
]
```

---

### 方式一：microCompact（≈ 0ms，不触发全量压缩）

**触发条件**：工具调用结果时间戳超过 60 分钟，或 cache 可编辑

**Before**：
```
M3: tool_result: auth.ts 全文 → 8,000 tokens
M5: tool_result: 修改成功    → 200 tokens  
M9: tool_result: 测试结果    → 6,000 tokens（刚5分钟，不清理）
M11: assistant content       → 300 tokens
```

**After**（清理超时的工具结果）：
```
M3: tool_result: "[Old tool result content cleared]"  → 10 tokens  ↓ -7990
M5: tool_result: "[Old tool result content cleared]"  → 10 tokens  ↓ -190
M9: tool_result: 测试结果    → 6,000 tokens  (保留，在 keepRecent 范围)
M11: assistant content       → 300 tokens    (不变)
```

**消息数**：不变（8条）  
**释放 tokens**：~8,180  
**信息损失**：旧工具输出（可以重新运行工具再生）

---

### 方式二：sessionMemoryCompact（< 50ms，读磁盘）

**触发条件**：token 超限 + `.md` 文件存在 + lastSummarizedMessageId 有效

**~/.claude/.../session-memory.md 内容**（由后台 SM hook 预先写好）：
```markdown
# Session Title
修复 auth.ts TypeScript 类型错误

# Current State
已完成3个类型错误修复，测试通过（27/27），准备提交代码。

# Files and Functions
- `src/auth.ts`: JWT 验证模块，修复了 UserRole 枚举不兼容问题
- `src/types.ts`: 新增 AuthToken 类型定义

# Errors & Corrections
- JwtPayload.role 需要显式转换为 UserRole，直接赋值报错 TS2322
- 测试需要 mock JWT_SECRET 环境变量，否则 undefined 崩溃

# Key results
所有27个测试通过，3处类型修复：auth.ts:45, auth.ts:102, types.ts:18
```

**Before**（120,000 tokens）：
```
[M1~M11: 原始 8 轮对话，120,000 tokens]
```

**After**（重组后，约 18,000 tokens）：
```
M_new1: user: "[Boundary: 对话已使用 Session Memory 压缩]"    → 50 tokens
M_new2: assistant: "[摘要: .md 文件内容]"                       → 2,000 tokens
M10:    user: "现在提交代码"                                    → 15 tokens
M11:    assistant: "我来帮你写 commit message"                  → 300 tokens
        ↑ 保留最近消息（lastSummarizedIndex+1 之后的内容）
```

**消息数**：8条 → 4条  
**释放 tokens**：120,000 → ~2,365（压缩率 98%）  
**信息保留**：关键文件路径、错误详情、测试结果通过 .md 文件保留

---

### 方式三：compactConversation（15~30 秒，LLM 生成摘要）

**触发条件**：token 超限 + SM 不可用（SM compact 返回 null 时 fallback）

**子 agent prompt**：把全部 120,000 tokens 发给 LLM，要求生成 9 节结构化摘要。

**LLM 返回**（`<analysis>` + `<summary>` 格式）：
```xml
<analysis>
对话主要完成了3个 TypeScript 类型修复...
</analysis>

<summary>
# 1. Primary Request and Intent
用户要求修复 src/auth.ts 中的 TypeScript 类型错误...

# 2. Key Technical Concepts
- JWT 类型安全，UserRole 枚举转换...

# 3. Files and Code Sections  
- src/auth.ts: L45, L102 — UserRole 类型修复
- src/types.ts: L18 — AuthToken 接口定义

# 4. Errors and Failures
- TS2322: JwtPayload.role 不能直接赋值给 UserRole...

# 5-9. [更多章节...]
</summary>
```

**After**（`formatCompactSummary()` 处理后）：
```
M_new1: user: "[Boundary: 对话已通过 auto-compact 压缩]"     → 30 tokens
M_new2: assistant: "# 1. Primary Request and Intent\n..."    → 3,800 tokens
```

**消息数**：8条 → 2条  
**释放 tokens**：120,000 → ~3,830（压缩率 96.8%）  
**信息保留**：LLM 理解后的高质量摘要，但经过 LLM 再解释，可能丢失细节

---

## 设计动机分析

### 为什么用 10 个固定章节，而不是自由格式？

1. **结构化约束提升 LLM 输出质量**：章节标题明确语义，减少 LLM"写流水账"的倾向
2. **diff 更新友好**：固定章节让 LLM 只更新变化的部分，而非重写全文
3. **容量控制精确**：每节 ≤ 2000 tokens，全文 ≤ 12K tokens，上限可预测

### 为什么 lastSummarizedMessageId 只取无工具调用的 assistant 消息？

防止 `tool_use` / `tool_result` 对被拆开：

```
错误场景：
  lastSummarizedMessageId → M_N (tool_use: read_file)

Compact 后：
  [摘要消息]  [M_N+1: tool_result for M_N]  ← 孤立！
                          └─ API 会报错：引用了不存在的 tool_use_id
```

这个细节保证了 API 调用不会因消息引用完整性问题而失败。

### 为什么需要 sequential() 包装？

防止并发 SM 提取导致 `.md` 文件写冲突，以及 `lastSummarizedMessageId` 竞争更新：

```typescript
const extractSessionMemory = sequential(async (context) => {
  // 同时只跑 1 个
})
```

---

## 启发与超越

### 1. 分期付款模型的通用性

SM 的核心思路可以迁移到任何"高成本操作可以预先分摊"的场景：

- 代码索引重建（用户输入时后台更新，搜索时直接查）
- 测试报告摘要（每个测试完成时异步汇总）
- 文档自动更新（代码变更时后台生成变更摘要）

### 2. 可改进点：跨 session 恢复

当前 `lastSummarizedMessageId` 重启即失效。改进方案：将消息 UUID 持久化到 `.md` 文件头部：

```markdown
<!-- lastSummarizedMessageId: uuid-xxx -->
# Session Title
...
```

重启后读取此 UUID，对消息列表做匹配，恢复压缩能力。

### 3. 多文件 SM：项目级记忆

当前一个 session 对应一个 `.md` 文件。可以扩展为：

- `project-memory.md`（跨 session，大颗粒知识）
- `session-memory.md`（当前 session，细节状态）

在压缩时优先使用 session 级（精确），降级时使用 project 级（泛化）。

---

## 延伸阅读

- [对话压缩策略详解](/06-context-engineering/03-compaction-strategies) — microCompact、compactConversation 的完整分析
