# Q: 如何追踪 Agent 性能？

> **核心问题**：一个 AI 编码代理的性能瓶颈在哪里？Claude Code 如何通过三层 Profiler、成本追踪、665+ 遥测事件来量化和优化性能？

---

## 1. 性能追踪体系全景

```
┌─────────────────────────────────────────────────────────────────┐
│                     三层 Profiler 体系                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐      │
│  │ Startup      │  │ Query        │  │ Headless          │      │
│  │ Profiler     │  │ Profiler     │  │ Profiler          │      │
│  │              │  │              │  │                    │      │
│  │ 启动阶段     │  │ 查询生命周期 │  │ 非交互模式        │      │
│  │ 4 个阶段     │  │ 19 个检查点  │  │ 每轮延迟          │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬─────────────┘      │
│         │                 │                  │                    │
│         └─────────────────┼──────────────────┘                    │
│                           ▼                                       │
│              ┌────────────────────────┐                           │
│              │ Profiler Base          │                           │
│              │ (perf_hooks + memory)  │                           │
│              └────────────────────────┘                           │
├─────────────────────────────────────────────────────────────────┤
│                     成本追踪                                     │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ cost-tracker.ts + modelCost.ts + bootstrap/state.ts  │       │
│  │ 6 种定价层级 × 5 类 token × 按模型统计               │       │
│  └──────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────┤
│                     遥测事件                                     │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 665+ 事件 (logEvent) + OpenTelemetry + Perfetto      │       │
│  │ Statsig + Datadog + 1P BigQuery                      │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Query Profiler：查询全生命周期分析

> **源码引用**：`src/utils/queryProfiler.ts`（302 行）

### 2.1 激活方式

```bash
CLAUDE_CODE_PROFILE_QUERY=1 claude
```

### 2.2 19 个检查点

```
用户输入 → 第一个 token (TTFT) 的完整路径：

query_user_input_received          ← 用户按回车
  │
  ├─ query_context_loading_start   ← 加载系统提示词
  ├─ query_context_loading_end
  │
  ├─ query_query_start             ← REPL 调用 query()
  ├─ query_fn_entry                ← 进入 query() 函数
  │
  ├─ query_microcompact_start      ← 微压缩消息
  ├─ query_microcompact_end
  │
  ├─ query_autocompact_start       ← 检查是否需要自动压缩
  ├─ query_autocompact_end
  │
  ├─ query_setup_start             ← 设置模型和执行器
  ├─ query_setup_end
  │
  ├─ query_tool_schema_build_start ← 构建工具 JSON Schema
  ├─ query_tool_schema_build_end
  │
  ├─ query_message_normalization_start ← 消息规范化
  ├─ query_message_normalization_end
  │
  ├─ query_client_creation_start   ← 创建 Anthropic 客户端
  ├─ query_client_creation_end
  │
  ├─ query_api_request_sent        ← HTTP 请求发送 ──── 预请求开销结束
  ├─ query_response_headers_received ← 响应头到达
  ├─ query_first_chunk_received    ← 第一个 chunk ──── TTFT！
  │
  ├─ query_api_streaming_end       ← 流式响应完成
  │
  ├─ query_tool_execution_start    ← 工具执行开始
  ├─ query_tool_execution_end
  │
  └─ query_end                     ← 查询结束
```

### 2.3 报告输出示例

```
================================================================================
QUERY PROFILING REPORT - Query #3
================================================================================

[+    0.0ms] (+   0.0ms) query_user_input_received    | RSS: 156.2MB, Heap: 98.4MB
[+    2.1ms] (+   2.1ms) query_context_loading_start   | RSS: 156.2MB, Heap: 98.4MB
[+   45.3ms] (+  43.2ms) query_context_loading_end     | RSS: 157.1MB, Heap: 99.1MB
[+   46.1ms] (+   0.8ms) query_query_start
[+   47.2ms] (+   1.1ms) query_fn_entry
[+   48.0ms] (+   0.8ms) query_setup_start
[+   52.4ms] (+   4.4ms) query_setup_end
[+   53.1ms] (+   0.7ms) query_tool_schema_build_start
[+   58.9ms] (+   5.8ms) query_tool_schema_build_end
[+   60.2ms] (+   1.3ms) query_api_request_sent
[+  412.7ms] (+ 352.5ms) query_first_chunk_received    | RSS: 160.8MB, Heap: 102.1MB

--------------------------------------------------------------------------------
Total TTFT: 412.7ms
  - Pre-request overhead: 60.2ms (14.6%)
  - Network latency: 352.5ms (85.4%)

PHASE BREAKDOWN:
  Context loading          43.2ms ████
  Query setup               4.4ms
  Tool schemas              5.8ms █
  Network TTFB            352.5ms ███████████████████████████████████
  Total pre-API overhead   60.2ms ██████
================================================================================
```

### 2.4 慢操作告警

```typescript
// src/utils/queryProfiler.ts:98-123
function getSlowWarning(deltaMs: number, name: string): string {
  if (deltaMs > 1000) return ' ⚠️  VERY SLOW'
  if (deltaMs > 100)  return ' ⚠️  SLOW'
  
  // 特定操作的更低阈值
  if (name.includes('git_status') && deltaMs > 50) return ' ⚠️  git status'
  if (name.includes('tool_schema') && deltaMs > 50) return ' ⚠️  tool schemas'
  if (name.includes('client_creation') && deltaMs > 50) return ' ⚠️  client creation'
  
  return ''
}
```

---

## 3. Startup Profiler：启动阶段分析

> **源码引用**：`src/utils/startupProfiler.ts`

### 3.1 四个启动阶段

| 阶段 | 起点 | 终点 | 测量内容 |
|------|------|------|----------|
| `import_time` | `cli_entry` | `main_tsx_imports_loaded` | 模块加载耗时 |
| `init_time` | `init_function_start` | `init_function_end` | 初始化函数耗时 |
| `settings_time` | `eagerLoadSettings_start` | `eagerLoadSettings_end` | 配置加载耗时 |
| `total_time` | `cli_entry` | `main_after_run` | 总启动时间 |

### 3.2 采样策略

```typescript
// 两种模式：
// 1. 采样上报 (默认)
//    - ant 用户: 100% 采样
//    - 外部用户: 0.5% 采样
//    - 事件名: tengu_startup_perf
//    - 目标: Statsig 统计

// 2. 详细报告 (手动启用)
//    CLAUDE_CODE_PROFILE_STARTUP=1
//    - 输出到: ~/.claude/startup-perf/{sessionId}.txt
//    - 包含完整时间线和内存快照
```

---

## 4. Headless Profiler：非交互模式延迟追踪

> **源码引用**：`src/utils/headlessProfiler.ts`

### 4.1 追踪指标

```typescript
// 每轮对话记录的指标（事件: tengu_headless_latency）

time_to_system_message_ms  // 仅 Turn 0：进程启动到系统消息
time_to_query_start_ms     // 轮次开始到查询开始
time_to_first_response_ms  // 轮次开始到第一个响应
query_overhead_ms          // 查询开始到 API 请求（预处理开销）
turn_number                // 当前轮次号（0-based）
entrypoint                 // 入口：sdk-ts / sdk-py / sdk-cli
```

### 4.2 采样率

```typescript
// ant 用户: 100% 采样
// 外部用户: 5% 采样（模块加载时决定）
```

**为什么 Headless 模式需要单独 Profiler？**

`-p`（print）模式下没有交互式 UI，延迟直接影响调用者的等待时间。这在 SDK 和 CI/CD 场景中尤为关键——用户（或脚本）在等待输出。

---

## 5. 成本追踪系统

### 5.1 定价模型

> **源码引用**：`src/utils/modelCost.ts`（180 行）

```typescript
// 6 种定价层级（每百万 token 的美元价格）

COST_TIER_3_15:    // Sonnet 系列
  input: $3, output: $15, cacheWrite: $3.75, cacheRead: $0.30

COST_TIER_15_75:   // Opus 4/4.1
  input: $15, output: $75, cacheWrite: $18.75, cacheRead: $1.50

COST_TIER_5_25:    // Opus 4.5/4.6 (标准)
  input: $5, output: $25, cacheWrite: $6.25, cacheRead: $0.50

COST_TIER_30_150:  // Opus 4.6 (Fast Mode)
  input: $30, output: $150, cacheWrite: $37.50, cacheRead: $3.00

COST_HAIKU_35:     // Haiku 3.5
  input: $0.80, output: $4, cacheWrite: $1.00, cacheRead: $0.08

COST_HAIKU_45:     // Haiku 4.5
  input: $1, output: $5, cacheWrite: $1.25, cacheRead: $0.10
```

### 5.2 成本计算公式

```typescript
// src/utils/modelCost.ts:131-142
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}
```

### 5.3 5 类 Token 追踪

```
┌────────────────────────────────────────────────────────┐
│                   Token 分类追踪                       │
│                                                        │
│  input_tokens          ← 输入 token                    │
│  output_tokens         ← 输出 token                    │
│  cache_read_tokens     ← Prompt Cache 命中             │
│  cache_creation_tokens ← Prompt Cache 创建             │
│  web_search_requests   ← 网页搜索次数                  │
│                                                        │
│  每种类型按模型分别统计                                 │
│  OpenTelemetry counter 按 {model, type} 维度递增        │
└────────────────────────────────────────────────────────┘
```

### 5.4 会话成本持久化

> **源码引用**：`src/cost-tracker.ts`（323 行）

```typescript
// src/cost-tracker.ts:143-174
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    lastModelUsage: Object.fromEntries(/* 按模型的详细用量 */),
    lastSessionId: getSessionId(),
  }))
}
```

**会话恢复时的成本还原**：

```typescript
// src/cost-tracker.ts:130-137
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) return false  // session ID 不匹配，不还原
  setCostStateForRestore(data)
  return true
}
```

### 5.5 成本展示

```typescript
// src/cost-tracker.ts:228-243
// 退出时显示的成本摘要

Total cost:            $0.42
Total duration (API):  2m 15s
Total duration (wall): 5m 30s
Total code changes:    150 lines added, 23 lines removed
Usage by model:
     claude-sonnet-4:  125k input, 12k output, 98k cache read, 5k cache write ($0.38)
      claude-haiku-4:  8k input, 2k output, 0 cache read, 0 cache write ($0.04)
```

### 5.6 未知模型处理

```typescript
// src/utils/modelCost.ts:166-173
function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model,
    shortName: shortName,
  })
  setHasUnknownModelCost()  // 标记成本可能不准确
}
```

当遇到未知模型时，回退到默认定价（`COST_TIER_5_25`），并在成本显示中注明"costs may be inaccurate"。

---

## 6. FPS 追踪

> **源码引用**：`src/utils/fpsTracker.ts`

```typescript
// 计算两种 FPS 指标

averageFps = frames / (totalTime / 1000)
// 平均帧率

// P1 低帧率（最差 1% 帧转换为 FPS）
p99FrameTime = sortedFrameTimes[ceil(0.01 * length) - 1]
low1PctFps = 1000 / p99FrameTime
```

**用途**：保存到项目配置中作为 UI 性能基线，用于检测性能退化。

---

## 7. 遥测事件系统

### 7.1 事件架构

```
代码中的 logEvent() 调用
         │
         ▼
┌──────────────────┐
│ Analytics Sink   │ → 事件分发
├──────────────────┤
│                  │
│  ├─ Statsig      │ ← 主要统计平台
│  ├─ Datadog      │ ← 监控告警
│  ├─ 1P BigQuery  │ ← 第一方日志
│  └─ OpenTelemetry│ ← 3P 遥测
│                  │
└──────────────────┘
```

### 7.2 事件命名约定

所有事件以 `tengu_` 为前缀（Claude Code 内部代号）：

```
tengu_startup_telemetry          ← 启动遥测
tengu_startup_perf               ← 启动性能
tengu_headless_latency           ← 无头模式延迟
tengu_api_query                  ← API 查询
tengu_api_retry                  ← API 重试
tengu_api_error                  ← API 错误
tengu_api_success                ← API 成功
tengu_tool_use_success           ← 工具使用成功
tengu_tool_use_rejected_in_prompt ← 工具在 prompt 中被拒绝
tengu_show_permission_request    ← 显示权限请求
tengu_config_stats               ← 配置统计（含 cache hit rate）
tengu_auto_compact_*             ← 自动压缩相关
tengu_unknown_model_cost         ← 未知模型成本
tengu_advisor_tool_token_usage   ← Advisor 工具 token 用量
tengu_web_fetch_host             ← Web Fetch 目标主机
tengu_write_claudemd             ← 写入 .claude.md
```

### 7.3 遥测事件分类

| 类别 | 事件数量 | 典型事件 |
|------|---------|----------|
| API 交互 | ~50 | query, retry, success, error, cache_breakpoints |
| Agent 行为 | ~80 | tool_lifecycle, memory, completion, color_set |
| 工具执行 | ~60 | execution, permission, results, rejection |
| 配置/设置 | ~40 | auto_compact, fast_mode, model_changes |
| 性能 | ~30 | startup_perf, headless_latency, config_stats |
| 其他 | ~400+ | 各种功能特定事件 |

### 7.4 Perfetto 追踪

> **源码引用**：`src/utils/telemetry/perfettoTracing.ts`

```bash
# 启用方式
CLAUDE_CODE_PERFETTO_TRACE=1 claude
# 或指定输出路径
CLAUDE_CODE_PERFETTO_TRACE=/path/to/trace.json claude

# 输出位置
~/.claude/traces/trace-{sessionId}.json
```

生成 Chrome Trace Event 格式文件，可在 [ui.perfetto.dev](https://ui.perfetto.dev) 中查看：

```
追踪内容：
├─ Agent 层级结构（父子 Agent 关系）
├─ API 请求（开始、结束、耗时）
├─ 工具执行（类型、参数、耗时）
├─ 用户等待时间
└─ Cache 命中率
```

---

## 8. OpenTelemetry 集成

> **源码引用**：`src/bootstrap/state.ts`

```typescript
// OpenTelemetry 提供的 meter
meter           // 度量器
costCounter     // 成本计数器
tokenCounter    // Token 计数器
sessionCounter  // 会话计数器

// 维度属性
{ model, type: 'input' | 'output' | 'cacheRead' | 'cacheCreation' }
{ model, speed: 'fast' }  // Fast Mode 时附加 speed 属性

// 每轮指标
turnHookDurationMs       // Hook 耗时
turnToolDurationMs       // 工具执行耗时
turnClassifierDurationMs // 分类器耗时
```

---

## 9. 配置缓存命中率追踪

```typescript
// src/utils/config.ts 中追踪
configCacheHits   // 配置缓存命中次数
configCacheMisses // 配置缓存未命中次数

// 上报到遥测
logEvent('tengu_config_stats', {
  cache_hits: configCacheHits,
  cache_misses: configCacheMisses,
  hit_rate: configCacheHits / (configCacheHits + configCacheMisses),
})
```

---

## 10. 性能优化洞察

### 10.1 TTFT 分解

从 Query Profiler 的数据，典型 TTFT 分解为：

```
TTFT ≈ 预请求开销 + 网络延迟

预请求开销 (通常 50-200ms):
  ├─ 上下文加载:     10-50ms   (系统提示词、git 状态)
  ├─ 微压缩:         0-20ms    (如果开启)
  ├─ 查询设置:       5-15ms    (模型选择、执行器创建)
  ├─ 工具 Schema:    5-20ms    (Zod → JSON Schema)
  ├─ 消息规范化:     5-15ms    (格式转换)
  └─ 客户端创建:     5-20ms    (Anthropic SDK 实例)

网络延迟 (通常 200-2000ms):
  └─ API 请求 → 第一个 chunk
```

### 10.2 优化策略

```
1. 减少预请求开销：
   ├─ lazySchema()       → 延迟 Zod Schema 构建到首次使用
   ├─ 配置缓存           → 避免重复读取配置文件
   ├─ 动态导入           → 按需加载模块
   └─ 预请求并行化       → 并行执行独立的预处理步骤

2. 减少网络延迟：
   ├─ Prompt Cache       → 重用缓存的 prompt 前缀
   ├─ Keep-alive 连接    → 复用 HTTP 连接
   └─ 区域就近部署       → 选择最近的 API 端点

3. 减少感知延迟：
   ├─ 流式输出           → 第一个 token 就开始显示
   ├─ 进度指示           → 工具执行中显示进度
   └─ 乐观更新           → UI 立即响应用户操作
```

### 10.3 数据驱动决策

遥测数据如何指导优化决策：

```
问题: "用户报告启动慢"
数据: tengu_startup_perf → import_time P95 = 3.2s
发现: 模块加载占启动 80%
优化: 延迟加载非核心模块
验证: P95 降至 1.1s

问题: "Token 成本过高"
数据: cost-tracker → cache_read_tokens / total_tokens = 15%
发现: Prompt Cache 命中率低
优化: 调整工具注册顺序以稳定 system prompt
验证: Cache 命中率提升至 85%

问题: "UI 卡顿"
数据: fpsTracker → low1PctFps = 8
发现: 最差 1% 帧只有 8 FPS
优化: 减少不必要的重渲染
验证: low1PctFps 提升至 24
```

---

## 11. 启发与超越

### 构建你自己的性能追踪系统

1. **从 TTFT 开始**——这是用户最直接感知的指标。Query Profiler 的 19 个检查点是很好的参考。

2. **成本追踪不是可选项**——AI 应用的运行成本直接可见。5 类 token（input/output/cache_read/cache_creation/web_search）是完整模型。

3. **采样策略很重要**：
   - 内部用户 100%（充分的调试信息）
   - 外部用户 0.5-5%（足够的统计显著性，不影响性能）

4. **分层 Profiler 比统一 Profiler 更实用**——启动、查询、无头模式有完全不同的瓶颈。

5. **Perfetto 格式是可视化利器**——Chrome Trace Event 格式成熟，生态完善。

6. **安全超时是测量边界**——如果 Profiler 本身影响了性能，那就失去了意义。所有检查点操作必须是 O(1)。

7. **665 个事件太多了？** 不一定——关键是命名约定（`tengu_` 前缀）和分类结构让它们可管理。但要定期清理不再使用的事件。
