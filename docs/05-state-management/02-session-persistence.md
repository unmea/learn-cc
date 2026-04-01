# JSONL vs SQLite——会话持久化的架构抉择

> **核心问题**：一个 AI Agent 的会话可能持续数小时、包含数千条消息和工具调用。如何持久化这些数据，使得会话可以随时恢复？Claude Code 选择了 JSONL——这是一个看似简单但充满巧思的选择。
>

---

## 1. 为什么是 JSONL？

**JSONL**（JSON Lines）：每行一个 JSON 对象，追加写入。

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"message":{...}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{...}}
{"type":"file-history-snapshot","messageId":"a1","snapshot":{...}}
```

**为什么不是 SQLite？**

| 维度 | JSONL | SQLite |
|------|-------|--------|
| **写入模式** | append-only（最佳性能） | INSERT（需要索引维护） |
| **并发安全** | 天然安全（只追加） | 需要 WAL 模式 |
| **人类可读** | ✅ 直接 cat/grep | ❌ 需要工具查询 |
| **崩溃恢复** | 天然鲁棒（最后一行可能损坏） | 需要 journal 回放 |
| **查询能力** | ❌ 只能全文扫描 | ✅ SQL 查询 |
| **ACID** | ❌ 无事务保证 | ✅ 完整 ACID |
| **空间效率** | ❌ 文本格式 + 重复 key | ✅ 二进制 + 压缩 |
| **分支/重写** | 天然支持（追加新分支） | 需要复杂 schema |
| **依赖** | 零（纯 fs.appendFile） | 需要 better-sqlite3 |

**Claude Code 的关键洞察**：会话数据的写入模式是**追加为主**（新消息、新工具结果），读取模式是**全量恢复**（加载整个会话）。这与 JSONL 的特性完美匹配。

---

## 2. 目录结构

```
~/.claude/
├── projects/
│   └── <sanitized-cwd>/           # 每个项目一个目录
│       ├── <sessionId>.jsonl       # 会话 transcript
│       └── <sessionId>/
│           └── subagents/
│               └── agent-<agentId>.jsonl  # 子 agent 的 transcript
├── sessions/                       # 会话 PID 注册（并发检测）
└── settings.json
```

### 路径计算

```typescript
// src/utils/sessionStorage.ts:L202-205

function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}
```

### 路径净化

```typescript
// src/utils/sessionStoragePortable.ts:L311-319

function sanitizePath(path: string): string {
  // 1. 替换非字母数字字符为连字符
  // 2. 长路径截断到 200 字符 + hash 后缀
  return sanitized.slice(0, 200) + '-' + hash(path)
}
```

---

## 3. JSONL Entry 类型体系

### 3.1 所有 Entry 类型

```typescript
// src/types/logs.ts:L297-317

type Entry =
  | TranscriptMessage          // 用户/助手/附件/系统消息
  | SummaryMessage             // 压缩摘要
  | CustomTitleMessage         // 用户设置的标题
  | AiTitleMessage             // AI 生成的标题
  | LastPromptMessage          // 最近的用户提示
  | TaskSummaryMessage         // 中途进度（每 5 步或 2 分钟）
  | TagMessage                 // 会话标签
  | AgentNameMessage           // Agent 名称
  | AgentColorMessage          // Agent 颜色
  | AgentSettingMessage        // Agent 定义
  | PRLinkMessage              // GitHub PR 链接
  | FileHistorySnapshotMessage // 文件变更历史快照
  | AttributionSnapshotMessage // 提交归属快照
  | QueueOperationMessage      // 队列操作
  | SpeculationAcceptMessage   // 投机执行接受
  | ModeEntry                  // coordinator/normal 模式
  | WorktreeStateEntry         // Worktree 状态
  | ContentReplacementEntry    // 内容哈希替换
  | ContextCollapseCommitEntry // 上下文折叠提交
  | ContextCollapseSnapshotEntry // 上下文折叠快照
```

### 3.2 TranscriptMessage 序列化

```typescript
// src/types/logs.ts:L8-17

type SerializedMessage = Message & {
  cwd: string           // 当前工作目录
  userType: string      // 用户类型
  entrypoint?: string   // 入口点 ('cli' / 'sdk-ts' / 'sdk-py')
  sessionId: string     // 会话 ID
  timestamp: string     // ISO 时间戳
  version: string       // 版本号
  gitBranch?: string    // Git 分支
  slug?: string         // 会话 slug
}
```

### 3.3 判断消息类型

```typescript
// src/utils/sessionStorage.ts:L139-146

function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}
```

---

## 4. parentUuid 链：消息排序的核心

### 4.1 链式结构

每条消息通过 `parentUuid` 链接到上一条消息：

```
null ← u1 ← a1 ← u2 ← a2 ← u3 ← a3
       │              │
       │              └── 分支 B: u2b ← a2b
       │
       └── 分支 A（已废弃）
```

### 4.2 为什么用链而不是序号？

1. **支持分支**：用户可以从任意消息"重来"（rewind），创建新分支
2. **追加兼容**：旧分支的消息仍在文件中，新分支的消息追加在后
3. **无需删除**：JSONL 只追加，永不删除或修改
4. **恢复时选择**：从最后一条消息沿链回溯，自动忽略废弃分支

### 4.3 示例

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"Hello"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":"Hi"}}
{"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":"旧问题"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","content":"旧回答"}}
{"type":"user","uuid":"u2b","parentUuid":"a1","message":{"role":"user","content":"新问题（rewind 后）"}}
{"type":"assistant","uuid":"a2b","parentUuid":"u2b","message":{"role":"assistant","content":"新回答"}}
```

恢复时从 `a2b` 回溯：`a2b → u2b → a1 → u1`。旧分支 `a2, u2` 被自动忽略。

---

## 5. 写入流程

### 5.1 写入管道

```
消息产生
    ↓
recordTranscript()  [sessionStorage.ts:L1408-L1449]
    ├─ UUID 去重（messageSet 缓存）
    ├─ 追踪 parentUuid 前缀
    └─ 调用 insertMessageChain()
         ↓
insertMessageChain()  [Project 类]
    ├─ materializeSessionFile()  ← 第一条 user/assistant 消息时创建文件
    └─ appendEntry() → enqueueWrite()
         ↓
enqueueWrite()  [sessionStorage.ts:L606-616]
    ├─ 加入写入队列（per-file）
    └─ 调度 drain 定时器
         ↓
drainWriteQueue()  [sessionStorage.ts:L645-686]
    ├─ 批量序列化：jsonStringify(entry) + '\n'
    ├─ 块大小限制：MAX_CHUNK_BYTES = 100MB
    └─ fs.appendFile()  ← 原子追加
```

### 5.2 写入缓冲

```typescript
// sessionStorage.ts:L606-616

// 写入不是即时的，而是缓冲的
// 本地模式：100ms 缓冲窗口
// CCR 远程模式：10ms 缓冲窗口（更快响应）

function enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  // 1. 加入队列
  writeQueue.get(filePath)?.push({ entry, resolve })
  
  // 2. 调度定时器（如果未调度）
  if (!drainTimer.has(filePath)) {
    drainTimer.set(filePath, setTimeout(() => drainWriteQueue(filePath), FLUSH_DELAY))
  }
}
```

### 5.3 序列化

```typescript
// sessionStorage.ts:L656

for (const { entry, resolve } of batch) {
  const line = jsonStringify(entry) + '\n'  // 自定义 JSON 序列化器
  content += line
  resolvers.push(resolve)
}
await this.appendToFile(filePath, content)
```

---

## 6. 读取与恢复流程

### 6.1 恢复管道

```
用户运行 claude --resume <sessionId>
    ↓
loadTranscriptFile()  [sessionStorage.ts:L3472-L3700+]
    │
    ├─ 1. 条件性跳过预压缩字节（文件 > 5MB）
    │     readTranscriptForLoad() → 跳过已过期的预压缩数据
    │
    ├─ 2. 字节级链回溯（文件 > 5MB 时启用）
    │     walkChainBeforeParse()
    │     ├─ 扫描 {"parentUuid": 前缀定位消息
    │     ├─ 从最后一个叶子节点沿 parentUuid 回溯
    │     └─ 剔除死亡分支（节省 80-93% 内存）
    │
    ├─ 3. 解析 JSONL
    │     parseJSONL<Entry>() → 逐行 jsonParse
    │
    ├─ 4. 遗留进度条桥接
    │     progressBridge Map 重新链接跨进度条间隙的消息
    │
    └─ 5. 构建会话链
          buildConversationChain()
          从 leafUuid 沿 parentUuid 反向回溯
          返回有序 Message[]
```

### 6.2 优化读取

```typescript
// src/utils/sessionStoragePortable.ts:L717-793

export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number   // 压缩边界起点
  postBoundaryBuf: Buffer       // 边界后的数据
  hasPreservedSegment: boolean  // 是否有保留段
}> {
  // 1MB 块读取
  // 跳过 attribution-snapshot 行（不读入内存）
  // 压缩边界处截断累加器
  // 峰值内存 = 输出大小，而非文件大小
  
  // 实测：151MB 会话（84% 过期数据）→ 32MB 峰值（vs 159MB 旧方式）
}
```

### 6.3 walkChainBeforeParse：字节级优化

```typescript
// sessionStorage.ts:L3306-L3466

// 问题：大型会话文件可能包含大量死亡分支
// 解析所有 JSON 再过滤 → 浪费内存

// 解决方案：在 JSON.parse 之前，用字节扫描定位活跃链
function walkChainBeforeParse(buffer: Buffer): Buffer {
  // 1. 从文件末尾找到最后一条消息
  // 2. 提取其 parentUuid
  // 3. 在文件中搜索父消息（匹配 {"parentUuid":"<uuid>"}）
  // 4. 重复直到根
  // 5. 只保留活跃链的字节范围
  // → 节省 80-93% 内存
}
```

---

## 7. 会话恢复：processResumedConversation

```typescript
// src/utils/sessionRestore.ts:L409-551

async function processResumedConversation(
  result: ResumeLoadResult,
  opts: { forkSession: boolean; sessionIdOverride?: string },
  context: { modeApi, mainThreadAgentDefinition, agentDefinitions },
): Promise<ProcessedResume> {
  
  // 1. 模式匹配
  matchSessionMode()  // coordinator/normal 模式

  // 2. 会话 ID 复用（除非 --fork-session）
  switchSession()
  // → 重命名 asciicast 录制
  // → 重置文件指针
  // → 恢复费用追踪

  // 3. 元数据恢复
  restoreSessionMetadata()

  // 4. Worktree 恢复
  restoreWorktreeForResume()
  // → 尝试 process.chdir() 到上次的 worktree 路径
  // → 如果路径已删除，写 null 覆盖缓存

  // 5. 文件认领
  adoptResumedSessionFile()
  // → 指向恢复的 transcript 文件
  // → 在会话退出前重新追加元数据

  // 6. 状态恢复
  restoreSessionStateFromLog()
}
```

### 状态恢复详情

```typescript
// src/utils/sessionRestore.ts:L99-150

function restoreSessionStateFromLog(result, setAppState) {
  // 1. 文件历史快照
  if (result.fileHistorySnapshots?.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
      setAppState(prev => ({ ...prev, fileHistory: newState }))
    })
  }

  // 2. 提交归属
  if (result.attributionSnapshots?.length > 0) {
    attributionRestoreStateFromLog(result.attributionSnapshots, newState => {
      setAppState(prev => ({ ...prev, attribution: newState }))
    })
  }

  // 3. 上下文折叠
  if (feature('CONTEXT_COLLAPSE')) {
    restoreFromEntries(result.contextCollapseCommits, result.contextCollapseSnapshot)
  }

  // 4. Todos
  if (!isTodoV2Enabled() && result.messages?.length > 0) {
    const todos = extractTodosFromTranscript(result.messages)
    setAppState(prev => ({ ...prev, todos: { ...prev.todos, [agentId]: todos } }))
  }
}
```

---

## 8. 元数据尾部重追加

### 8.1 问题

JSONL 是追加的，但某些元数据（标题、标签、最近提示）需要被快速读取（例如 `/resume --list` 显示会话列表）。如果元数据深埋在文件中间，需要读取整个文件才能找到。

### 8.2 解决方案

```typescript
// src/utils/sessionStorage.ts:L721-839

function reAppendSessionMetadata() {
  // 在会话退出或压缩时：
  // 将关键元数据重新追加到文件末尾
  // → /resume --list 只需读取文件尾部 64KB
  
  // 重追加的字段：
  // - custom-title
  // - tag
  // - agent-name / agent-color / agent-setting
  // - mode
  // - worktree-state
  // - pr-link
  // - last-prompt
}
```

### 8.3 轻量元数据读取

```typescript
// LITE_READ_BUF_SIZE = 65536 (64KB)

// 快速读取会话元数据：
// 1. 只读文件头部 64KB + 尾部 64KB
// 2. 从尾部提取元数据条目
// 3. 无需加载整个文件
```

---

## 9. 远程持久化

```typescript
// src/utils/sessionStorage.ts:L1302-1343

// 两条远程同步路径：

// 1. CCR v2 内部事件
internalEventWriter.write(entry)

// 2. v1 会话接入
sessionIngress.appendSessionLog(entry)

// 两者都原子追加 JSONL 条目到远程服务器
```

---

## 10. 完整 JSONL 示例

```jsonl
{"type":"mode","mode":"normal","sessionId":"abc-123"}
{"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":"请解释这段代码"},"sessionId":"abc-123","version":"2.1.88","cwd":"/project","userType":"external","timestamp":"2025-01-15T10:30:00Z"}
{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"这段代码的功能是..."}]},"sessionId":"abc-123"}
{"type":"file-history-snapshot","messageId":"a1","snapshot":{"src/main.ts":{"originalContent":"..."}}}
{"type":"user","uuid":"u2","parentUuid":"a1","message":{"role":"user","content":"帮我修改 src/main.ts"},"sessionId":"abc-123"}
{"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"src/main.ts","content":"..."}}]},"sessionId":"abc-123"}
{"type":"user","uuid":"u3","parentUuid":"a2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"OK"}]},"sessionId":"abc-123"}
{"type":"assistant","uuid":"a3","parentUuid":"u3","message":{"role":"assistant","content":[{"type":"text","text":"修改完成。"}]},"sessionId":"abc-123"}
{"type":"content-replacement","sessionId":"abc-123","replacements":[{"tool_use_id":"tu1","hash":"sha256:abc123"}]}
{"type":"last-prompt","lastPrompt":"运行测试","sessionId":"abc-123"}
{"type":"custom-title","customTitle":"修改 main.ts 并测试","sessionId":"abc-123"}
```

**关键观察**：
- 消息通过 `parentUuid → uuid` 形成有序依赖图
- 快照通过 `messageId` 关联到触发它的 assistant 消息
- 元数据条目（last-prompt、custom-title）追加在末尾的 64KB 窗口内
- content-replacement 记录哪些工具输出被替换为哈希

---

## 11. 性能优化总结

| 优化 | 技术 | 效果 |
|------|------|------|
| **写入缓冲** | 100ms 批次（本地）/ 10ms（CCR） | 减少 I/O 系统调用 |
| **延迟创建** | 第一条 user/assistant 消息时才创建文件 | 避免空会话文件 |
| **链回溯** | walkChainBeforeParse 字节级扫描 | 80-93% 内存节省 |
| **流式跳过** | fd 级别跳过 attribution-snapshot | 不进入内存 |
| **自定义 JSON** | jsonStringify/jsonParse | 优化 log 场景 |
| **轻量读取** | 头部 + 尾部各 64KB | /resume --list 秒级响应 |
| **死分支剪裁** | walkChainBeforeParse | 大型会话的内存控制 |

---

## 12. 与 Codex 的 SQLite 方案对比

### 12.1 Codex 的方案

Codex 使用 SQLite 存储会话：
- 结构化表：messages, tool_calls, file_changes
- SQL 查询：快速检索特定消息
- ACID 保证：事务安全

### 12.2 对比分析

| 场景 | JSONL (Claude Code) | SQLite (Codex) |
|------|---------------------|----------------|
| **追加写入** | ✅ 最优（fd.appendFile） | ⚠️ 需要 INSERT + 索引 |
| **全量恢复** | ✅ 顺序读取 | ✅ SELECT * |
| **分支管理** | ✅ 天然支持（追加新链） | ⚠️ 需要版本表 |
| **部分查询** | ❌ 需要全文扫描 | ✅ WHERE + 索引 |
| **并发写入** | ✅ 追加安全 | ⚠️ 需要 WAL |
| **崩溃恢复** | ✅ 最后一行可能损坏 | ✅ 事务回滚 |
| **调试** | ✅ cat/grep/jq | ❌ 需要 sqlite3 |
| **空间效率** | ❌ 文本冗余 | ✅ 二进制紧凑 |
| **迁移** | ✅ 无 schema | ⚠️ 需要 migration |
| **依赖** | 零 | better-sqlite3 (native) |

### 12.3 权衡分析

**JSONL 更适合 Claude Code 的原因**：

1. **写入模式匹配**：会话数据是追加为主的。JSONL 的 append-only 与之完美契合。
2. **分支是一等公民**：用户频繁 rewind → 新分支。JSONL 只需追加新消息，SQLite 需要复杂的版本管理。
3. **零依赖**：`fs.appendFile` 是 Node.js 内建。SQLite 需要 native 模块编译。
4. **人类可读**：`cat session.jsonl | jq` 就能调试。SQLite 需要专门工具。
5. **崩溃鲁棒**：JSONL 最坏情况是最后一行损坏（可丢弃）。SQLite 理论上更安全，但实际上 WAL 在断电时也可能出问题。

**SQLite 更适合 Codex 的原因**：

1. **查询需求**：Codex 需要快速检索特定 tool_call 的结果。
2. **多表关联**：file_changes 表需要与 messages 表关联。
3. **压缩需求**：频繁的二进制数据（diff patches）。

---

## 14. 思考题

1. **文件会无限增长吗？** 是的，JSONL 文件会随会话增长。Claude Code 通过压缩（compaction）来管理：将旧消息压缩为摘要，追加 compact boundary marker。恢复时跳过 boundary 之前的数据。

2. **parentUuid 链会断裂吗？** 理论上写入失败可能导致链断裂。Claude Code 通过 progressBridge 机制处理遗留断裂（PR #24099 移除了 progress entries）。

3. **为什么不用二进制格式？** 如 Protocol Buffers 或 MessagePack。原因：(1) 人类可读性对调试至关重要；(2) JSON 的 schema 灵活性允许 Entry 类型自由演进；(3) 性能瓶颈不在序列化。

4. **100ms 的写入缓冲会丢数据吗？** 如果进程在缓冲窗口内崩溃，未刷新的消息会丢失。但因为会话可以从最后成功写入的消息恢复，丢失的只是最近 100ms 内的数据——通常是一两条消息。
