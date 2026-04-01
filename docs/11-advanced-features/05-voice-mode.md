# Q: 语音交互如何集成到终端 Agent？

## 一句话回答

Claude Code 通过原生音频模块捕获麦克风输入，经 WebSocket 连接 Anthropic 的 STT 服务（Deepgram Nova 3）实时转录，以 Push-to-Talk 方式集成到终端提示输入中；目前仅支持语音输入，无 TTS 语音输出。

---

## 1. 语音模式架构

### 1.1 系统概览

```
┌─────────────────────────────────────────────────┐
│                  Voice Mode                      │
│                                                  │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐ │
│  │ 音频捕获  │──▶│ WebSocket │──▶│ 转录结果   │ │
│  │ (CPAL/   │   │ STT 客户端│   │ 插入光标处  │ │
│  │  SoX/    │   │           │   │            │ │
│  │  arecord)│   └───────────┘   └────────────┘ │
│  └──────────┘                                   │
│       ▲                                         │
│       │                                         │
│  ┌────┴─────┐   ┌───────────┐   ┌────────────┐ │
│  │ 按住空格  │   │ 音频电平  │   │ Voice      │ │
│  │ Push-to- │   │ 可视化    │   │ Indicator  │ │
│  │ Talk     │   │ (16 bar)  │   │ UI 组件    │ │
│  └──────────┘   └───────────┘   └────────────┘ │
└─────────────────────────────────────────────────┘
```

## 2. 音频捕获

### 2.1 多平台录音策略

> 源码: `src/services/voice.ts` (526 行)

Claude Code 采用三级降级策略来捕获麦克风输入：

```
优先级 ①: 原生音频模块 (audio-capture-napi)
    └── macOS / Linux / Windows
    └── 基于 CPAL 的原生绑定
    └── 16 kHz, 16-bit signed PCM, 单声道
    └── 首次激活时懒加载（避免启动时触发权限弹窗）
    └── 冷启动约 8s（CoreAudio 唤醒后），热启动约 1s

优先级 ②: ALSA 工具 (arecord)
    └── 仅 Linux
    └── 探测设备可用性
    └── WSL1 / Win10-WSL2 检测

优先级 ③: SoX (rec 命令)
    └── 跨平台降级方案
    └── 内置静音检测
    └── --buffer 1024 低延迟流式传输
```

### 2.2 音频参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 采样率 | 16,000 Hz | 语音识别标准采样率 |
| 位深 | 16-bit signed | 平衡精度和带宽 |
| 声道 | 单声道 (Mono) | 语音不需要立体声 |
| 编码 | linear16 (PCM) | 无损，STT 服务要求 |

---

## 3. 语音转文字 (STT)

### 3.1 WebSocket 协议

> 源码: `src/services/voiceStreamSTT.ts` (545+ 行)

```
连接目标: api.anthropic.com/api/ws/speech_to_text/voice_stream
认证方式: OAuth Bearer token (需要 Claude.ai 订阅)
目标服务器: api.anthropic.com (非 claude.ai，避免 TLS 指纹问题)
```

### 3.2 STT 配置

```typescript
{
  encoding: 'linear16',        // 16-bit PCM
  sampleRate: 16000,           // 16 kHz
  channels: 1,                 // 单声道
  endpointing: 300,            // 300ms — 语句端点检测
  utteranceEnd: 1000,          // 1000ms — 语句结束判定
  language: 'en',              // BCP-47 语言代码
  provider: 'Deepgram Nova 3', // 由 tengu_cobalt_frost 标志控制
}
```

### 3.3 支持的语言

19 种语言:

```
en (英语), es (西班牙语), fr (法语), ja (日语),
de (德语), pt (葡萄牙语), it (意大利语), ko (韩语),
hi (印地语), id (印尼语), ru (俄语), pl (波兰语),
tr (土耳其语), nl (荷兰语), uk (乌克兰语), el (希腊语),
cs (捷克语), da (丹麦语), sv (瑞典语), no (挪威语)
```

### 3.4 消息协议

**控制消息**:
- `KeepAlive`: 每 8 秒发送一次
- `CloseStream`: 停止录音时发送

**服务器响应**:
- `TranscriptText`: 临时或最终的转录片段
- `TranscriptEndpoint`: 标记语句结束
- `TranscriptError`: 转录失败

---

## 4. 按住说话 (Push-to-Talk) 机制

### 4.1 激活逻辑

> 源码: `src/hooks/useVoice.ts` (1000+ 行)

```
默认按键: 空格键（按住录音）
可配置: 通过快捷键系统

模式:
  ① Push-to-Talk (默认): 按住录音，松开停止
  ② Focus Mode: 终端获得焦点时自动录音
```

### 4.2 自动重复检测

终端的按键自动重复（每 30-80ms 触发一次）需要特殊处理：

```
按键快速连续到来 (auto-repeat)
       │
       ├── holdThreshold = 5 次快速按键 → 确认激活
       ├── warmupThreshold = 2 次 → 显示预热提示
       ├── releaseTimeout = 200ms 间隔 → 判定松开
       └── fallback = 600ms 无重复 → 强制停止
```

### 4.3 Focus Mode

```
终端获得焦点 → 开始录音
       │
       ├── 5s 静音 → 断开 WebSocket
       ├── 失去焦点 → 停止录音
       └── 重新获得焦点 → 重新开始录音
```

---

## 5. 语音状态管理

### 5.1 状态存储

> 源码: `src/context/voice.tsx` (87 行)

使用 Zustand 管理语音状态:

```typescript
type VoiceState = {
  voiceState: 'idle' | 'recording' | 'processing'
  voiceError: string | null
  voiceInterimTranscript: string     // 实时预览文本
  voiceAudioLevels: number[]         // 波形可视化数据
  voiceWarmingUp: boolean
}
```

### 5.2 状态 Hook

```typescript
useVoiceState(selector)    // 订阅状态变化
useSetVoiceState()         // 更新状态（同步）
useGetVoiceState()         // 同步读取（用于回调）
```

### 5.3 状态流转

```
             ┌──────────────────────────┐
             │                          │
             ▼                          │
     ┌──────────────┐                   │
     │    idle       │←─────────────────┤
     │  (空闲)       │                   │
     └──────┬───────┘                   │
            │ 用户按住空格               │
            ▼                           │
     ┌──────────────┐                   │
     │  recording   │                   │
     │  (录音中)     │                   │
     └──────┬───────┘                   │
            │ 用户松开                    │
            ▼                           │
     ┌──────────────┐                   │
     │ processing   │ ─────────────────┘
     │ (处理中)      │  转录完成
     └──────────────┘
```

---

## 6. UI 组件

### 6.1 VoiceIndicator — 录音指示器

> 源码: `src/components/PromptInput/VoiceIndicator.tsx` (137 行)

| 状态 | 显示内容 | 动画 |
|------|----------|------|
| `idle` | 不显示（隐藏） | 无 |
| `recording` | `"listening…"` (暗色文本) | 静态 |
| `processing` | `"Voice: processing…"` (微光) | 2 秒脉冲（暗灰 ↔ 亮灰） |
| `warmup` | `"keep holding…"` (暗色文本) | 静态，持续约 120ms |

**无障碍设计**: 尊重 `prefersReducedMotion` 设置，禁用微光动画。

### 6.2 VoiceModeNotice — 可用性通知

> 源码: `src/components/LogoV2/VoiceModeNotice.tsx` (68 行)

```
文本: "Voice mode is now available · /voice to enable"
位置: 消息列表顶部（快速滚动到后面）
频率: 每会话最多显示 3 次
触发: 语音模式可用但尚未启用时
动画: 带星号的动画指示器
```

### 6.3 音频电平可视化

> 源码: `src/hooks/useVoice.ts:179-197`

```
波形显示:
  - 条数: 16 根
  - 计算: 16-bit PCM 样本的 RMS (均方根) 振幅
  - 归一化: sqrt 曲线，展开安静电平
  - 状态: voiceAudioLevels[] 存储在 context 中
```

---

## 7. 转录结果集成

### 7.1 实时插入

> 源码: `src/hooks/useVoiceIntegration.tsx` (500+ 行)

转录结果实时插入到光标位置：

```
用户按住空格
       │
       ▼
  音频流式传输 → STT 处理
       │
       ▼
  临时转录 (interimTranscript)
       │
       ├── 记录光标前后文本 (voicePrefixRef / voiceSuffixRef)
       ├── 在光标位置插入临时文本
       ├── 实时更新预览
       │
       ▼
  最终转录 (finalTranscript)
       │
       ├── 提交到输入框
       ├── 清理临时标记
       └── 检测用户手动编辑 → 放弃覆盖
```

### 7.2 防编辑保护

```
录音中用户手动编辑:
  检测编辑行为
  → 放弃语音插入
  → 保留用户输入
  → 避免覆盖用户文本
```

### 7.3 按键泄漏清理

按住空格键时，自动重复可能在输入框中留下多余的空格字符。系统会自动清理这些泄漏的按键字符。

---

## 8. 功能门控与认证

### 8.1 启用条件

> 源码: `src/voice/voiceModeEnabled.ts` (55 行)

语音模式需要满足所有以下条件：

```
① GrowthBook 开关: VOICE_MODE 特性启用
   - 紧急关闭: tengu_amber_quartz_disabled
   - 新安装默认可见（过期缓存 = 启用）

② 认证要求: Anthropic OAuth 必须
   - 仅 Claude.ai 订阅用户（非 API key 用户）
   - OAuth 令牌刷新检查 (~20-50ms macOS，已记忆化)

③ 麦克风访问:
   - macOS: TCC 权限（首次激活时触发）
   - WSL/无头环境检查
   - 平台特定的降级验证
```

### 8.2 /voice 命令

> 源码: `src/commands/voice/voice.ts` (151 行)

预检清单:
```
✅ 认证与开关已启用
✅ 录音可用（麦克风可访问）
✅ 语音流端点可达
✅ 依赖已安装（原生音频/SoX/arecord）
✅ 麦克风权限已授予
✅ 语言支持（不支持时降级到英语）
```

输出: 语言提示 + 快捷键显示

---

## 9. 语音关键词 (STT 准确率提升)

### 9.1 工作原理

> 源码: `src/services/voiceKeyterms.ts` (107 行)

为 Deepgram STT 提供领域特定词汇提示，提高技术术语的识别准确率。

### 9.2 全局词汇（硬编码）

```
MCP, symlink, grep, regex, localhost, codebase, TypeScript,
JSON, OAuth, webhook, gRPC, dotfiles, subagent, worktree
```

### 9.3 动态词汇（自动收集，最多 50 个）

| 来源 | 处理方式 | 示例 |
|------|----------|------|
| **项目根目录名** | 完整名称作为短语 | `my-project` |
| **Git 分支名** | 按分隔符拆分单词 | `feat/voice-keyterms` → `["feat", "voice", "keyterms"]` |
| **最近文件名** | camelCase/kebab/snake 拆分 | `VoiceIndicator.tsx` → `["Voice", "Indicator"]` |

过滤规则: 长度 < 2 或 > 20 的词被排除。

---

## 10. 错误处理与容错

### 10.1 早期重试逻辑

```
WebSocket 连接早期失败:
  → 在新连接上重试一次
  → 重放完整音频缓冲区

"静默丢弃" (服务器接收音频但返回零转录):
  → 重放缓冲区
  → 有限缓冲区: ~32KB/s × 60s ≈ 2MB
```

### 10.2 WebSocket 失败模式

| 模式 | 描述 |
|------|------|
| `post_closestream_endpoint` | 正常完成 (CloseStream 后收到 TranscriptEndpoint) |
| `no_data_timeout` | 1.5s 无数据 → 静默丢弃 |
| `safety_timeout` | 5s 最大超时（安全网） |
| `ws_close` | WebSocket 提前关闭 |
| `ws_already_closed` | 连接从未建立 |

### 10.3 分析事件

```
tengu_voice_toggled:
  语音模式启用/禁用

tengu_voice_recording_completed:
  录音会话完成
  ├── transcriptChars: 转录字符数
  ├── wsConnected: WebSocket 是否成功连接
  └── hadAudioSignal: 是否有音频信号
```

---

## 11. 终端环境限制

### 11.1 不可用的环境

| 环境 | 原因 |
|------|------|
| **远程环境 (SSH/Homespace)** | 无本地麦克风 |
| **WSL1 / Windows 10 WSL2** | 无 ALSA 声卡 |
| **无头 Linux** | 无音频设备检测 |
| **Windows (无原生模块)** | 需要原生音频模块（无降级方案） |

### 11.2 平台指导

| 平台 | 启用音频的方法 |
|------|---------------|
| **macOS** | 系统设置 → 隐私与安全 → 麦克风 |
| **Windows** | 设置 → 隐私 → 麦克风 |
| **Linux** | 系统音频设置 |

### 11.3 终端上下文特殊性

- 语音录音**仅在 CLI 中**有效（非浏览器）
- 读取终端焦点状态以启用 Focus Mode 录音
- 使用终端快捷键系统配置按住键
- 集成 `KeyboardEvent` 系统保证可靠的按键检测

---

## 12. 无语音输出 (TTS)

> 代码库中**无任何 TTS 集成**。

语音功能严格为**仅输入**（语音转文字）：
- ❌ 无音频输出/播放代码
- ❌ 无语音合成
- ❌ 无响应朗读

虽然代码中有 `speech` 相关的动画和 UI 反馈引用，但不存在实际的音频输出功能。

---

## 13. 设计分析

### 13.1 为什么选择 Push-to-Talk 而非 VAD？

**Push-to-Talk** (按住说话) vs **Voice Activity Detection** (语音活动检测):

| 维度 | Push-to-Talk | VAD |
|------|-------------|-----|
| **误触率** | 极低（需明确按键） | 可能被环境噪音触发 |
| **用户体验** | 需要额外操作 | 更自然 |
| **终端适配** | ✅ 与按键系统集成 | ❌ 需要持续监听，资源消耗大 |
| **隐私** | 仅按下时录音 | 持续监听（隐私顾虑） |

终端环境中，Push-to-Talk 是更合理的选择。

### 13.2 为什么使用 WebSocket 而非 REST？

- **延迟**: 流式音频需要实时传输，HTTP 请求的往返延迟过高
- **双向通信**: 服务器需要推送临时转录结果
- **连接保活**: KeepAlive 机制维持连接

### 13.3 三级录音降级的设计哲学

```
原生模块 → ALSA → SoX
  高性能      中等     通用

设计原则:
  ① 优先性能: 原生模块延迟最低
  ② 广泛兼容: SoX 是跨平台兜底
  ③ 优雅降级: 不因缺少某个依赖就完全不可用
  ④ 懒加载: 首次使用时才加载，避免启动时触发权限弹窗
```

### 13.4 领域关键词的价值

对于技术对话，STT 模型容易将专业术语识别为普通单词：

```
用户说: "Run grep on the TypeScript codebase"
无关键词: "Run grep on the type script code base"
有关键词: "Run grep on the TypeScript codebase"  ✅
```

动态从项目上下文收集关键词是一个低成本高回报的优化。
