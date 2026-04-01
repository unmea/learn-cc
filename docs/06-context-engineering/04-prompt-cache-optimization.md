# 如何让 API 调用更快更便宜？Prompt Cache 的工程实践

> **深度学习笔记**
>

---

## Q1: 什么是 Prompt Cache？为什么它对 Claude Code 至关重要？

**A:** Anthropic 的 Prompt Cache 是一种服务端缓存机制：当请求的前缀与之前的请求相同时，服务端可以复用已处理的 KV Cache，避免重复计算。

### 为什么对 Claude Code 特别重要？

```
一次典型的 Claude Code API 请求 token 分布：

┌────────────────────┬────────────┬──────────────┐
│ 组成部分           │ Token 数   │ 变化频率     │
├────────────────────┼────────────┼──────────────┤
│ 系统提示词         │ 3,000-5,000│ 几乎不变     │
│ 工具 Schema        │ 3,000-5,000│ 偶尔变化     │
│ 对话历史（旧消息） │ 10K-150K   │ 只增不减     │
│ 最新用户消息       │ 100-1,000  │ 每次变化     │
├────────────────────┼────────────┼──────────────┤
│ 总计               │ 16K-161K   │              │
└────────────────────┴────────────┴──────────────┘

可缓存的部分（前缀）: 系统提示词 + 工具 Schema + 旧消息
                      = 总输入的 95%+

不可缓存的部分: 最新消息
              = 总输入的 <5%
```

**经济账：**

```
假设：平均请求 100K input tokens，cache hit 95%

无 cache:  100K × $3/M = $0.30 per request
有 cache:  5K × $3/M + 95K × $0.30/M = $0.015 + $0.0285 = $0.0435
                                               ↑ 缓存读取 90% 折扣

节省: ($0.30 - $0.0435) / $0.30 = 85.5% 成本降低
```

在 Agent 模式下，一个任务可能需要 20-50 次 API 调用。85% 的成本降低意味着 **$6 的任务只需 $0.87**。

---

## Q2: Prompt Cache 的技术原理是什么？

**A:** Anthropic 的 Prompt Cache 基于**确定性前缀匹配**：

```
请求 1:  [System Prompt] [Tool Schema] [Msg1] [Msg2] [New Query]
         ──────────────── cached prefix ────────────── │ new │

请求 2:  [System Prompt] [Tool Schema] [Msg1] [Msg2] [Msg3] [New Query]
         ──────────────── cached prefix ────────────────────── │ new │
                                                 ↑
                                           新增的 Msg3 在
                                           旧前缀之后，
                                           旧前缀仍然命中！

请求 3:  [MODIFIED System Prompt] [Tool Schema] [Msg1] [Msg2] ...
         │ cache miss! │
         ↑ 系统提示词变了 → 整个前缀失效！
```

**关键规则：**
1. 只有**相同前缀**才能命中缓存
2. 前缀中任何一个 byte 的变化都会导致缓存失效
3. `cache_control` 标记指示缓存断点位置
4. 缓存有 TTL：默认 5 分钟，高级用户 1 小时

---

## Q3: Claude Code 在哪里设置 cache_control 标记？

**A:** Cache 标记在三个位置设置：系统提示词块、消息、工具 Schema。

### 3.1 系统提示词的缓存块

```typescript
// src/services/api/claude.ts:3216-3230
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: { skipGlobalCacheForSystemPrompt?: boolean; querySource?: QuerySource },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {...}).map(block => {
    return {
      type: 'text',
      text: block.text,
      // 只在启用缓存 + 有缓存范围时添加 cache_control
      ...(enablePromptCaching && block.cacheScope !== null && {
        cache_control: getCacheControl({
          scope: block.cacheScope,      // 'global' 或 'org' 或 null
          querySource: options.querySource,
        }),
      }),
    }
  })
}
```

### 3.2 系统提示词的分割策略

```typescript
// src/utils/api.ts:321-435
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {

  // 策略 1: 有 MCP 工具（需要 tool-based cache）
  // → 跳过全局缓存，使用 'org' 级别
  if (useGlobalCacheFeature && options?.skipGlobalCacheForSystemPrompt) {
    return [
      { text: attributionHeader, cacheScope: null },       // 计费头（不缓存）
      { text: systemPromptPrefix, cacheScope: 'org' },     // CLI 前缀
      { text: restJoined, cacheScope: 'org' },             // 其余内容
    ]
  }

  // 策略 2: 有边界标记（标准模式）
  // → 边界前: global，边界后: null
  if (useGlobalCacheFeature && boundaryIndex !== -1) {
    return [
      { text: attributionHeader, cacheScope: null },       // 计费头
      { text: systemPromptPrefix, cacheScope: null },      // CLI 前缀
      { text: staticJoined, cacheScope: 'global' },        // ← 静态部分全局缓存！
      { text: dynamicJoined, cacheScope: null },           // ← 动态部分不全局缓存
    ]
  }

  // 策略 3: 无全局缓存（回退）
  return [
    { text: attributionHeader, cacheScope: null },
    { text: systemPromptPrefix, cacheScope: null },
    { text: restJoined, cacheScope: null },
  ]
}
```

### 缓存范围可视化

```
系统提示词在 API 请求中的实际形态：

[Block 1: Attribution Header]
  text: "x-anthropic-billing-header: ..."
  cache_control: null                          ← 不缓存

[Block 2: Static Content]
  text: "You are an interactive agent...\n     ← 角色 + 规则
        # System\n...\n                        ← 工具机制
        # Doing tasks\n...\n                   ← 编码准则
        # Actions\n...\n                       ← 危险操作
        # Using tools\n...\n                   ← 工具指南
        # Tone and style\n..."                 ← 风格
  cache_control: { type: "ephemeral",
                   scope: "global" }           ← 全局缓存！所有用户共享！

[Block 3: Dynamic Content]
  text: "# Session guidance\n...\n             ← 会话指导
        # Memory (CLAUDE.md)\n...\n            ← 用户自定义
        # Environment\n..."                    ← 环境信息
  cache_control: null                          ← 不全局缓存
                                                 但消息级缓存仍可能命中
```

### 3.3 消息上的缓存断点

```typescript
// src/services/api/claude.ts:3063-3090

// 每个请求只放一个消息级缓存断点
// 为什么不放多个？——Mycro 的逐轮逐出机制

// Mycro 的 page_manager/index.rs: Index::insert 
// 在非 cache_store_int_token_boundaries 位置释放 local-attention KV pages
// 两个标记 → 倒数第二位被保护 → locals 多存活一轮（浪费）
// 一个标记 → 及时释放（高效）

const markerIndex = skipCacheWrite
  ? messages.length - 2    // fork 请求：放在倒数第二条（共享前缀点）
  : messages.length - 1    // 正常请求：放在最后一条

// 在目标消息的最后一个 content block 上添加 cache_control
const targetMsg = messages[markerIndex]
const lastBlock = targetMsg.content[targetMsg.content.length - 1]
lastBlock.cache_control = getCacheControl({ querySource })
```

### 3.4 cache_control 结构

```typescript
// src/utils/api.ts:358-370
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',                                    // 类型固定
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),  // 高级用户 1 小时
    ...(scope === 'global' && { scope }),                  // 全局范围
  }
}
```

---

## Q4: 工具排序为什么用字母序？这和缓存有什么关系？

**A:** 工具排序是 prompt cache 优化的关键一环。工具 Schema 在 API 请求中是 system prompt 之后、messages 之前的部分，它的稳定性直接影响缓存命中。

### 核心排序代码

```typescript
// src/tools.ts:345-367
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

### 为什么是分区排序而不是全局排序？

```
假设内置工具: [Bash, Edit, Grep, Read, Write]
假设 MCP 工具: [DatabaseQuery, SlackPost]

全局排序（错误方式）:
  [Bash, DatabaseQuery, Edit, Grep, Read, SlackPost, Write]
              ↑ MCP 工具插入到 Bash 和 Edit 之间！

问题: 如果 MCP 工具变化（增删），内置工具的位置会移动
     → 前缀改变 → 缓存失效！

分区排序（正确方式）:
  [Bash, Edit, Grep, Read, Write | DatabaseQuery, SlackPost]
  ←─── 内置工具（固定前缀）────→ ←── MCP 工具（追加）──→

优势: 内置工具排序固定，MCP 工具只在末尾追加
     → 内置工具的前缀永远不变 → 缓存稳定！
```

### 为什么使用字母序而不是定义顺序？

```
定义顺序的问题:
  - 代码重构可能改变 import 顺序
  - 新增工具的位置取决于在文件中的位置
  - 不同分支可能有不同顺序

字母序的优势:
  - 确定性: 相同名称集合 → 相同顺序
  - 稳定性: 新增工具只影响其字母位置之后
  - 可预测: 无需了解代码结构就能知道排序
```

### 第二处排序（headless 路径）

```typescript
// src/utils/toolPool.ts:55-79
const [mcp, builtIn] = partition(
  uniqBy([...initialTools, ...assembled], 'name'),
  isMcpTool,
)
const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
const tools = [...builtIn.sort(byName), ...mcp.sort(byName)]
```

REPL 和 Headless 两条路径使用完全相同的排序逻辑。

---

## Q5: MCP 工具为什么追加在内置工具之后？

**A:** 这是由 Anthropic 服务端的缓存策略决定的。

### 服务端缓存策略

```typescript
// 注释来自 src/tools.ts:354-359
// The server's claude_code_system_cache_policy places a global cache
// breakpoint after the last prefix-matched built-in tool; a flat sort
// would interleave MCP tools into built-ins and invalidate all downstream
// cache keys whenever an MCP tool sorts between existing built-ins.
```

**Anthropic 服务端的 `claude_code_system_cache_policy`：**
- 在最后一个匹配的内置工具之后放置全局缓存断点
- 断点之前的所有内容（系统提示词 + 内置工具 Schema）可以全局缓存
- 断点之后的内容（MCP 工具 + 消息）按用户级缓存

### 全局缓存策略的选择

```typescript
// src/services/api/claude.ts:1217-1227
const needsToolBasedCacheMarker =
  useGlobalCacheFeature &&
  filteredTools.some(t => t.isMcp === true && !willDefer(t))

const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
  ? needsToolBasedCacheMarker
    ? 'none'              // 有非延迟 MCP 工具 → 无法全局缓存
    : 'system_prompt'     // 无 MCP 或全部延迟 → 系统提示词全局缓存
  : 'none'
```

```
场景 1: 无 MCP 工具
  策略: 'system_prompt'
  [系统提示词 (global)] [内置工具 (global)] [消息 (per-session)]
        ↑ 全局缓存：所有用户共享

场景 2: 有 MCP 工具但全部延迟加载
  策略: 'system_prompt'
  [系统提示词 (global)] [内置工具 (global)] [MCP defer] [消息]
                                             ↑ 延迟工具只是元数据

场景 3: 有非延迟 MCP 工具
  策略: 'none'
  [系统提示词 (org)] [内置工具 (org)] [MCP 工具 (org)] [消息]
        ↑ MCP 工具是用户特定的 → 不能全局缓存
        ↑ 降级到 org 级别缓存
```

---

## Q6: 消息不变性是怎么保证的？为什么重要？

**A:** 修改旧消息会改变缓存前缀，导致缓存失效。Claude Code 通过**克隆**和**不可变操作**保护消息前缀的稳定性。

### 克隆消息内容

```typescript
// src/services/api/claude.ts:623-625
// Clone array content to prevent in-place mutations (e.g., insertCacheEditsBlock's
// splice) from contaminating the original message. Without cloning, multiple calls
// to addCacheBreakpoints share the same array and each splices in duplicate cache_edits.
return {
  role: 'user',
  content: Array.isArray(message.message.content)
    ? [...message.message.content]  // ← 克隆数组！
    : message.message.content,
}
```

### 创建新对象而非修改

```typescript
// src/services/api/claude.ts:3195-3205
// 为 tool_result 添加 cache_reference 时创建新对象
if (!cloned) {
  msg.content = [...msg.content]  // ← 克隆数组
  cloned = true
}
msg.content[j] = Object.assign({}, block, {  // ← 新对象！不修改原始 block
  cache_reference: block.tool_use_id,
})
```

### 源码中关于缓存保护的注释

整个代码库中散布着大量关于缓存保护的注释，体现了这个优化的优先级：

```
src/memdir/memdir.ts:
  "preserve the prompt cache prefix across midnight"
  → 午夜切换日期时保持 CLAUDE.md 内容不变

src/utils/toolResultStorage.ts:
  "same choices every time (preserves prompt cache prefix)"
  → 工具结果存储的决策要确定性

src/utils/api.ts:
  "so including it preserves their GB-flip cache stability"
  → Feature flag 翻转不应影响缓存

src/Tool.ts:
  "input is never mutated (preserves prompt cache)"
  → 工具输入不可修改
```

---

## Q7: Cache TTL（生存时间）是怎么管理的？

**A:** 缓存有两种 TTL：5 分钟（默认）和 1 小时（高级用户），通过 session 级别的锁存（latch）确保稳定。

### TTL 资格判断

```typescript
// src/utils/api.ts:378-416
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 3P Bedrock 用户：通过环境变量 opt-in
  if (getAPIProvider() === 'bedrock' && isEnvTruthy(...)) {
    return true
  }

  // 锁存（Latch）资格到 Bootstrap 状态
  // → 防止 session 中途的资格变化导致缓存失效
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||            // Anthropic 内部用户
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)  // 订阅且未超额
    setPromptCache1hEligible(userEligible)           // ← 锁存！后续不再重新判断
  }
  if (!userEligible) return false

  // 锁存允许列表到 Bootstrap 状态
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_prompt_cache_1h_config',
      {},
    )
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)             // ← 锁存！
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}
```

### 为什么要锁存？

```
问题场景（无锁存）：

请求 1: cache_control = { type: "ephemeral", ttl: "1h" }
        → 服务端创建 1h 缓存条目
        
请求 2: 用户超额 → 资格变化 → cache_control = { type: "ephemeral" }
        → ttl 从 "1h" 变为默认 "5m"
        → cache_control 内容变化 → 前缀 hash 变化 → 缓存失效！
        
结果: 一次资格变化导致约 20K tokens 的缓存失效

解决（锁存）：

Session 开始时判断资格 → 锁存 → 整个 session 不变
→ 即使中途资格变化，cache_control 保持一致
→ 缓存前缀稳定
```

---

## Q8: Cache 断点放在什么位置？为什么只放一个？

**A:** 每个请求只放一个消息级缓存断点，放在最后一条消息上。

### 断点位置代码

```typescript
// src/services/api/claude.ts:3063-3090
function addCacheBreakpoints(
  messages: MessageParam[],
  enablePromptCaching: boolean,
  querySource: QuerySource,
  skipCacheWrite?: boolean,
  ...
): MessageParam[] {
  // 正常请求: 最后一条消息
  // Fork 请求: 倒数第二条消息
  const markerIndex = skipCacheWrite
    ? messages.length - 2
    : messages.length - 1

  // 在目标消息的最后一个 block 上放置 cache_control
  // ...
}
```

### 为什么只放一个？

```typescript
// 源码注释（claude.ts:3063-3078）翻译：

// 每个请求严格一个消息级 cache_control 标记。
//
// Mycro 的逐轮逐出机制（page_manager/index.rs: Index::insert）
// 在任何非 cache_store_int_token_boundaries 的缓存前缀位置
// 释放 local-attention KV pages。
//
// 两个标记 → 倒数第二位被保护 → 其 locals 多存活一轮（即使
//            没有请求会从该位置恢复）→ 浪费内存
//
// 一个标记 → locals 立即释放 → 高效
```

**简单说：** Anthropic 服务端的 KV 缓存逐出策略会保护缓存断点位置的 local attention pages。两个断点意味着两个位置被保护，但倒数第二个位置的缓存数据实际上永远不会被复用（因为下一轮请求会在更后面的位置恢复），所以是浪费。

### Fork 请求的特殊处理

```
正常请求:  [...旧消息, 新消息]
           ─────────────────── ↑ 断点在这里

Fork 请求: [...旧消息, 新消息]   → 分叉到子 agent
           ──────────── ↑ 断点在倒数第二条
                         ↑ 这是父子共享的最后位置
                         ↑ 写入是 mycro 的无操作合并（条目已存在）
                         ↑ fork 不会在 KVCC 中留下自己的尾部
```

---

## Q9: cache_reference 是什么？怎么工作的？

**A:** `cache_reference` 是一种优化，允许 API 通过引用已缓存的内容来避免重复发送。

### 工作原理

```typescript
// src/services/api/claude.ts:3164-3205

// 为最后一个 cache_control 标记之前的 tool_result 添加 cache_reference
// API 要求 cache_reference 出现在最后一个 cache_control "之前或之上"

// 1. 找到最后一个有 cache_control 的消息位置
let lastCCMsg = -1
for (let i = 0; i < result.length; i++) {
  // 扫描所有消息找到最后一个 cache_control
  if (hasAnyCacheControl(result[i])) {
    lastCCMsg = i
  }
}

// 2. 在 lastCCMsg 之前的 tool_result 上添加 cache_reference
for (let i = 0; i < lastCCMsg; i++) {
  const msg = result[i]
  if (msg.role !== 'user') continue
  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      block.cache_reference = block.tool_use_id
      // → 服务端通过 tool_use_id 查找已缓存的内容
      // → 不需要重新发送完整的 tool_result 内容
    }
  }
}
```

### 去重逻辑

```typescript
// src/services/api/claude.ts:3112-3127
const seenDeleteRefs = new Set<string>()

const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
  const uniqueEdits = block.edits.filter(edit => {
    if (seenDeleteRefs.has(edit.cache_reference)) {
      return false  // 跳过重复的 cache_reference 删除
    }
    seenDeleteRefs.add(edit.cache_reference)
    return true
  })
  return { ...block, edits: uniqueEdits }
}
```

---

## Q10: 缓存命中率和成本节省能量化吗？

### Token 指标追踪

```typescript
// src/services/api/claude.ts:2936-3003

// API 响应中的缓存指标
usage = {
  input_tokens: number,                    // 未缓存的输入 token
  cache_creation_input_tokens: number,     // 首次缓存创建的 token
  cache_read_input_tokens: number,         // 缓存命中的 token
  cache_deleted_input_tokens: number,      // 被 cache_edits 删除的 token
  output_tokens: number,                   // 输出 token
  ephemeral_1h_input_tokens: number,       // 1h TTL 缓存的 token
  ephemeral_5m_input_tokens: number,       // 5m TTL 缓存的 token
}

// 跨轮次累积
totalUsage = {
  cache_creation_input_tokens:
    totalUsage.cache_creation_input_tokens +
    messageUsage.cache_creation_input_tokens,
  cache_read_input_tokens:
    totalUsage.cache_read_input_tokens +
    messageUsage.cache_read_input_tokens,
}
```

### 典型的缓存命中模式

```
轮次 1: 首次请求
  cache_creation: 8,000 tokens (系统提示词 + 工具 Schema)
  cache_read:     0 tokens
  input_tokens:   2,000 tokens (用户消息)
  → 创建缓存，无命中

轮次 2: 第二次请求（用户回复后）
  cache_read:     8,000 tokens (系统提示词 + 工具 Schema 命中！)
  cache_creation: 2,000 tokens (轮次 1 的消息被缓存)
  input_tokens:   500 tokens (新消息)
  → 80% 命中率

轮次 3-10: 后续请求
  cache_read:     持续增长 (前缀越来越长)
  cache_creation: 稳定 (~1K-3K per turn)
  input_tokens:   稳定 (~500-1K per turn)
  → 90-98% 命中率

轮次 20+: 长对话
  cache_read:     100K+ tokens
  cache_creation: ~2K tokens
  input_tokens:   ~1K tokens
  → 97%+ 命中率
```

### 成本影响估算

```
Anthropic 定价（Claude Sonnet 4 估算）：
  Input:          $3.00 / M tokens
  Cache Write:    $3.75 / M tokens（125% of input）
  Cache Read:     $0.30 / M tokens（10% of input）
  Output:         $15.00 / M tokens

一个 20 轮的 Agent 任务（无缓存 vs 有缓存）：

无缓存:
  20 轮 × 平均 80K input = 1,600K input tokens
  成本: 1,600K × $3.00/M = $4.80

有缓存（95% 命中率）:
  Cache read:     1,520K × $0.30/M = $0.456
  Cache write:    40K × $3.75/M = $0.15
  Uncached input: 40K × $3.00/M = $0.12
  成本: $0.726

节省: ($4.80 - $0.726) / $4.80 = 84.9%
```

---

## Q11: Prompt Cache Break Detection — 缓存失效检测

**A:** Claude Code 主动检测可能导致缓存失效的变化。

```
src/services/api/promptCacheBreakDetection.ts

追踪的哈希值：
  systemHash:       系统提示词内容哈希
  toolsHash:        工具 Schema 内容哈希
  cacheControlHash: cache_control 配置哈希
  betasHash:        Beta 功能头哈希

每次请求前比较这些哈希值：
  如果任何一个变化 → 记录 "cache break" 事件
  → 用于监控和诊断缓存命中率下降
```

---

## Q12: 哪些操作会导致缓存失效？

```
┌─────────────────────────────────┬────────────────┬───────────────────┐
│ 操作                            │ 影响范围       │ 严重程度          │
├─────────────────────────────────┼────────────────┼───────────────────┤
│ 修改 CLAUDE.md                  │ 动态 section   │ 中（不影响全局）  │
│ MCP 服务器连接/断开             │ 工具 Schema    │ 高（全部工具重排）│
│ /compact                        │ 消息前缀       │ 高（消息全部替换）│
│ Feature flag 翻转               │ 系统提示词     │ 锁存机制缓解      │
│ 切换模型                        │ 无关           │ 无（不同 model）  │
│ 午夜日期切换                    │ 环境信息       │ 低（被锁存缓解）  │
│ 新增/删除工具                   │ 工具 Schema    │ 中（分区排序缓解）│
│ cache_control TTL 变化           │ 整个前缀       │ 锁存机制缓解      │
│ Beta header 变化                │ 整个请求       │ 锁存机制缓解      │
└─────────────────────────────────┴────────────────┴───────────────────┘
```

### 缓解策略汇总

```
1. 分区排序（工具排序稳定性）
   → 防止 MCP 工具变化影响内置工具前缀

2. 静态/动态边界标记
   → 静态部分全局缓存，动态部分变化不影响全局

3. Session 级锁存
   → TTL 资格、允许列表、Beta headers 一旦确定就不变

4. Section 缓存
   → 系统提示词 section 只计算一次（除了 MCP 指令）

5. 消息不变性
   → 克隆操作防止修改已有消息

6. 午夜保护
   → "preserve the prompt cache prefix across midnight"
```

---

## Q13: 这个优化为什么是"不可见"的？

**A:** Prompt cache 优化完全透明——用户看不到任何不同，但它影响了系统的每一个设计决策。

### 不可见的影响

```
1. 系统提示词的结构设计
   → 静态部分在前（可全局缓存）
   → 动态部分在后（不影响全局缓存前缀）
   → 加一个 DYNAMIC_BOUNDARY 标记分界

2. 工具排序逻辑
   → 字母序（而非定义序）确保确定性
   → 分区排序（而非全局排序）保护内置工具前缀

3. 上下文注入策略
   → 用户上下文放在 messages 而非 system prompt
   → 因为 messages 的变化只影响尾部，不影响前缀

4. 压缩策略
   → Microcompact 优先用 cache_edits API（不修改消息内容）
   → 基于时间的 MC 等 cache TTL 过期后才清理

5. Section 缓存框架
   → DANGEROUS_uncachedSystemPromptSection 需要显式声明原因
   → 默认所有 section 都缓存

6. Feature flag 管理
   → 所有可能影响缓存的 flag 都做 session 级锁存
   → 防止中途翻转导致缓存失效
```

### 设计哲学

```
"每一个修改消息或系统提示词的操作，
 都必须问自己：这会打破 prompt cache 吗？"

这个原则渗透到了代码库的每一个角落：
- 60+ 处关于缓存保护的注释
- 多个专门的缓存稳定性机制
- 专门的缓存失效检测系统
- Feature flag 锁存架构

这不是一个"feature"，而是一种"文化"——
对前缀稳定性的偏执级关注。
```

---

## Q14: 如果我要实现类似的系统，关键设计要点是什么？

### 设计清单

```
□ 1. 请求结构排列
  将稳定内容放在前面，变化内容放在后面
  system prompt → tools → old messages → new message

□ 2. 分区管理
  在稳定和不稳定内容之间放置明确的边界
  使用不同的缓存范围（global / org / session）

□ 3. 排序稳定性
  所有集合类型（工具列表、规则列表）都用确定性排序
  避免依赖运行时顺序

□ 4. 不可变操作
  永远克隆消息再修改，不原地修改
  创建新对象而非修改旧对象

□ 5. Session 级锁存
  所有可能影响缓存前缀的配置项都锁存
  一旦确定就不在 session 内变化

□ 6. 缓存感知的压缩
  压缩操作应考虑缓存影响
  优先使用不修改前缀的压缩方式

□ 7. 监控和检测
  追踪缓存命中率
  检测缓存失效事件
  量化成本节省

□ 8. 最少缓存断点
  不要过度放置 cache_control 标记
  一个就够了——放在最后一条消息上
```

---

## 总结：Prompt Cache 优化的设计哲学

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  1. 前缀稳定性是第一优先级                                   │
│     → 每个设计决策都考虑对缓存前缀的影响                     │
│                                                              │
│  2. 不可见但无处不在                                         │
│     → 用户看不到缓存优化，但它影响了架构的每个方面           │
│                                                              │
│  3. 分层缓存策略                                             │
│     → global（所有用户）> org（组织）> session（会话）       │
│                                                              │
│  4. 防御性工程                                               │
│     → 锁存防止中途变化                                       │
│     → 克隆防止意外修改                                       │
│     → 检测系统及时发现问题                                   │
│                                                              │
│  5. 巨大的经济效益                                           │
│     → 典型场景下 80-95% 的输入 token 可以命中缓存            │
│     → 成本降低 70-85%                                        │
│     → 这可能是整个系统中 ROI 最高的优化                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

