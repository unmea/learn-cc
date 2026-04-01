import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '从零构建 AI 编码代理',
  description: '深度学习指南 — 通过提出问题、深入解答的方式，全面理解如何从零实现一个工业级 AI 编码代理',
  lang: 'zh-CN',
  base: '/learn-cc/',

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '学习路线', link: '/guide' },
      { text: '开始学习', link: '/01-agent-anatomy/01-what-is-coding-agent' }
    ],

    sidebar: [
      {
        text: '📖 学习路线',
        link: '/guide'
      },
      {
        text: '01 — Agent 解剖',
        collapsed: false,
        items: [
          { text: 'AI 编码代理是什么？', link: '/01-agent-anatomy/01-what-is-coding-agent' },
          { text: 'CLI Agent 如何启动？', link: '/01-agent-anatomy/02-bootstrap-and-lifecycle' },
          { text: '主循环为何选 AsyncGenerator？', link: '/01-agent-anatomy/03-main-loop-design' }
        ]
      },
      {
        text: '02 — LLM 集成',
        collapsed: false,
        items: [
          { text: '健壮的 API 客户端设计', link: '/02-llm-integration/01-api-client-design' },
          { text: '流式响应架构', link: '/02-llm-integration/02-streaming-architecture' },
          { text: 'Token 预算管理', link: '/02-llm-integration/03-token-management' },
          { text: '多模型切换与回退', link: '/02-llm-integration/04-model-selection' }
        ]
      },
      {
        text: '03 — 工具系统',
        collapsed: false,
        items: [
          { text: '可扩展的工具接口', link: '/03-tool-system/01-tool-abstraction' },
          { text: '43+ 工具全图鉴', link: '/03-tool-system/02-tool-catalog' },
          { text: '工具执行管线', link: '/03-tool-system/03-tool-execution-pipeline' },
          { text: '安全并发执行', link: '/03-tool-system/04-concurrent-tool-execution' },
          { text: '工具池动态组装', link: '/03-tool-system/05-tool-registry-and-filtering' }
        ]
      },
      {
        text: '04 — 权限与安全',
        collapsed: false,
        items: [
          { text: '7 层权限系统', link: '/04-permission-and-safety/01-permission-architecture' },
          { text: 'AI 判断命令安全性', link: '/04-permission-and-safety/02-yolo-classifier' },
          { text: '沙箱设计', link: '/04-permission-and-safety/03-sandbox-design' }
        ]
      },
      {
        text: '05 — 状态管理',
        collapsed: false,
        items: [
          { text: '自定义 Store 模式', link: '/05-state-management/01-store-pattern' },
          { text: 'JSONL vs SQLite 持久化', link: '/05-state-management/02-session-persistence' },
          { text: '跨会话记忆体系', link: '/05-state-management/03-memory-hierarchy' }
        ]
      },
      {
        text: '06 — 上下文工程',
        collapsed: false,
        items: [
          { text: '系统提示词设计', link: '/06-context-engineering/01-system-prompt-design' },
          { text: '上下文组装流程', link: '/06-context-engineering/02-context-assembly' },
          { text: '三层压缩策略', link: '/06-context-engineering/03-compaction-strategies' },
          { text: 'Prompt Cache 优化', link: '/06-context-engineering/04-prompt-cache-optimization' }
        ]
      },
      {
        text: '07 — 终端 UI',
        collapsed: false,
        items: [
          { text: '为什么在终端用 React？', link: '/07-terminal-ui/01-why-react-in-terminal' },
          { text: '自定义 React Reconciler', link: '/07-terminal-ui/02-custom-reconciler' },
          { text: 'Flexbox 终端布局', link: '/07-terminal-ui/03-yoga-layout' },
          { text: '组件设计系统', link: '/07-terminal-ui/04-component-design-system' },
          { text: '输入系统设计', link: '/07-terminal-ui/05-input-system' }
        ]
      },
      {
        text: '08 — 命令系统',
        collapsed: false,
        items: [
          { text: '斜杠命令设计', link: '/08-command-system/01-slash-commands' }
        ]
      },
      {
        text: '09 — 多 Agent 协作',
        collapsed: false,
        items: [
          { text: '7 种任务类型', link: '/09-multi-agent/01-task-types' },
          { text: '协调器模式', link: '/09-multi-agent/02-coordinator-pattern' },
          { text: 'Agent 间通信', link: '/09-multi-agent/03-team-collaboration' },
          { text: 'Worktree 隔离', link: '/09-multi-agent/04-worktree-isolation' }
        ]
      },
      {
        text: '10 — MCP 协议',
        collapsed: false,
        items: [
          { text: 'MCP 基础', link: '/10-mcp-protocol/01-mcp-fundamentals' },
          { text: '8 种传输实现', link: '/10-mcp-protocol/02-transport-implementations' },
          { text: 'OAuth 与安全认证', link: '/10-mcp-protocol/03-oauth-and-security' },
          { text: 'MCP Server 模式', link: '/10-mcp-protocol/04-mcp-server-mode' }
        ]
      },
      {
        text: '11 — 高级特性',
        collapsed: false,
        items: [
          { text: '远程控制 (Bridge)', link: '/11-advanced-features/01-bridge-remote-control' },
          { text: '后台任务管理', link: '/11-advanced-features/02-daemon-background' },
          { text: '技能系统', link: '/11-advanced-features/03-skills-system' },
          { text: '主动模式', link: '/11-advanced-features/04-proactive-mode' },
          { text: '语音交互', link: '/11-advanced-features/05-voice-mode' },
          { text: '插件系统', link: '/11-advanced-features/06-plugin-system' }
        ]
      },
      {
        text: '12 — 工程基础设施',
        collapsed: false,
        items: [
          { text: '构建系统', link: '/12-infrastructure/01-build-system' },
          { text: 'Feature Flags', link: '/12-infrastructure/02-feature-flags' },
          { text: '错误处理', link: '/12-infrastructure/03-error-handling' },
          { text: '遥测与性能', link: '/12-infrastructure/04-telemetry-and-profiling' },
          { text: 'Git 深度集成', link: '/12-infrastructure/05-git-integration' }
        ]
      },
      {
        text: '13 — 设计哲学',
        collapsed: false,
        items: [
          { text: '10 个核心架构决策', link: '/13-design-philosophy/01-architecture-decisions' },
          { text: '哪些可以做得更好？', link: '/13-design-philosophy/02-what-to-improve' },
          { text: '从零构建路线图', link: '/13-design-philosophy/03-build-your-own' }
        ]
      }
    ],

    outline: {
      level: [2, 3],
      label: '目录'
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/unmea/learn-cc' }
    ],

    footer: {
      message: '从零构建 AI 编码代理 — 深度学习指南',
    }
  }
})
