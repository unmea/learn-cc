# Q: 512K 行 TypeScript 如何打包成单文件？

> **核心问题**：Claude Code 拥有约 512K 行 TypeScript 源码、1884 个 `.ts/.tsx` 文件，最终如何打包成一个可直接运行的 `dist/cli.js`？这个构建系统有哪些不同寻常的设计？

---

## 1. 构建系统全景

### 1.1 原始构建 vs 开源构建

Claude Code 的原始构建使用 **Bun 运行时**的编译时特性。开源版本使用 esbuild 提供了一个"最大努力"的替代构建方案：

```
原始构建 (Anthropic 内部)          开源构建 (本项目)
┌─────────────────────────┐      ┌─────────────────────────┐
│  Bun bundler            │      │  esbuild                │
│  ├─ feature() 内建      │      │  ├─ feature() → false   │
│  ├─ MACRO.* 内建        │      │  ├─ MACRO.* → 字面量     │
│  ├─ 死代码消除 (DCE)    │      │  ├─ bun:bundle → stub   │
│  └─ 单文件输出          │      │  └─ 迭代式 stub 生成     │
└─────────────────────────┘      └─────────────────────────┘
```

### 1.2 构建流水线

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Phase 1     │ →  │  Phase 2     │ →  │  Phase 3     │ →  │  Phase 4     │
│  复制源码    │    │  源码变换    │    │  创建入口    │    │  迭代打包    │
│  src/ →      │    │  feature()   │    │  entry.ts    │    │  esbuild     │
│  build-src/  │    │  MACRO.*     │    │  wrapper     │    │  + stub      │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

> **源码引用**：`scripts/build.mjs:1-245`

---

## 2. Phase 1：源码复制——不碰原始文件

```javascript
// scripts/build.mjs:56-59
await rm(BUILD, { recursive: true, force: true })
await mkdir(BUILD, { recursive: true })
await cp(join(ROOT, 'src'), join(BUILD, 'src'), { recursive: true })
```

**设计决策**：构建过程永远不修改 `src/` 目录，所有变换在 `build-src/` 副本上进行。

**为什么？**
- 保护源码完整性，构建失败不会污染 working copy
- 允许反复运行构建，每次从干净状态开始
- `build-src/` 可用于调试构建问题（构建失败时保留中间产物）

---

## 3. Phase 2：源码变换——编译时到运行时

这是构建系统最核心的部分：将 Bun 特有的编译时特性替换为 esbuild 兼容的运行时代码。

### 3.1 feature() 替换

```javascript
// scripts/build.mjs:86-90
// 2a. feature('X') → false
if (/\bfeature\s*\(\s*['"][A-Z_]+['"]\s*\)/.test(src)) {
  src = src.replace(/\bfeature\s*\(\s*['"][A-Z_]+['"]\s*\)/g, 'false')
  changed = true
}
```

**原始代码中**：
```typescript
import { feature } from 'bun:bundle'

if (feature('KAIROS')) {
  // Kairos 模式特有代码
  const KairosUI = require('./kairos/KairosUI.js')
  // ... 数百行特性代码
}
```

**变换后**：
```typescript
// feature() replaced with false at build time

if (false) {
  // 这段代码会被 esbuild 的 DCE 完全移除
  const KairosUI = require('./kairos/KairosUI.js')
}
```

**关键洞察**：正则表达式 `/\bfeature\s*\(\s*['"][A-Z_]+['"]\s*\)/g` 精确匹配所有 `feature('FLAG_NAME')` 模式，其中 flag 名称必须是全大写加下划线，这保证了不会误替换其他函数调用。

### 3.2 MACRO 常量替换

```javascript
// scripts/build.mjs:67-78
const MACROS = {
  'MACRO.VERSION':               `'${VERSION}'`,           // → '2.1.88'
  'MACRO.BUILD_TIME':            `''`,                     // → ''
  'MACRO.FEEDBACK_CHANNEL':      `'https://github.com/...'`,
  'MACRO.ISSUES_EXPLAINER':      `'https://github.com/...'`,
  'MACRO.FEEDBACK_CHANNEL_URL':  `'https://github.com/...'`,
  'MACRO.ISSUES_EXPLAINER_URL':  `'https://github.com/...'`,
  'MACRO.NATIVE_PACKAGE_URL':    `'@anthropic-ai/claude-code'`,
  'MACRO.PACKAGE_URL':           `'@anthropic-ai/claude-code'`,
  'MACRO.VERSION_CHANGELOG':     `''`,
}
```

这些常量在原始 Bun 构建中通过 `--define` 注入，类似于 C 预处理器的 `#define`。

**使用场景**：
```typescript
// src/services/analytics/metadata.ts:33-34
const version = MACRO.VERSION       // → '2.1.88'
const buildTime = MACRO.BUILD_TIME  // → ''

// src/services/api/errors.ts:87
const feedback = MACRO.FEEDBACK_CHANNEL  // → GitHub Issues URL

// src/cli/update.ts:115
const pkg = MACRO.PACKAGE_URL  // → '@anthropic-ai/claude-code'
```

### 3.3 bun:bundle 导入移除

```javascript
// scripts/build.mjs:100-104
// 2c. Remove bun:bundle import
if (src.includes("from 'bun:bundle'") || src.includes('from "bun:bundle"')) {
  src = src.replace(
    /import\s*\{\s*feature\s*\}\s*from\s*['"]bun:bundle['"];?\n?/g,
    '// feature() replaced with false at build time\n'
  )
}
```

### 3.4 类型导入清理

```javascript
// scripts/build.mjs:107-110
// 2d. Remove type-only import of global.d.ts
if (src.includes("import '../global.d.ts'") || src.includes("import './global.d.ts'")) {
  src = src.replace(/import\s*['"][.\/]*global\.d\.ts['"];?\n?/g, '')
}
```

### 3.5 变换统计

构建过程遍历 `build-src/src/` 下所有 `.ts/.tsx/.js/.jsx` 文件：

```javascript
// scripts/build.mjs:80-81
for await (const file of walk(join(BUILD, 'src'))) {
  if (!file.match(/\.[tj]sx?$/)) continue
```

每次构建大约变换 **158+ 文件**（即导入 `feature()` 的文件数量）。

---

## 4. Phase 3：入口包装器

```javascript
// scripts/build.mjs:123-127
await writeFile(ENTRY, `#!/usr/bin/env node
// Claude Code v${VERSION} — built from source
// Copyright (c) Anthropic PBC. All rights reserved.
import './src/entrypoints/cli.tsx'
`, 'utf8')
```

**为什么需要包装器？**

1. **Shebang 行**：`#!/usr/bin/env node` 让文件可直接执行
2. **版本信息**：嵌入构建版本号
3. **间接层**：避免直接修改 `cli.tsx` 入口文件

`scripts/transform.mjs` 中的替代方案更复杂——它注入全局 `MACRO` 对象：

```javascript
// scripts/transform.mjs:73-93
const MACRO = {
  VERSION: '${VERSION}',
  BUILD_TIME: '',
  FEEDBACK_CHANNEL: 'https://github.com/...',
  // ...
}
globalThis.MACRO = MACRO
import './src/entrypoints/cli.tsx'
```

**设计差异**：`build.mjs` 使用文本替换（编译时），`transform.mjs` 使用运行时注入（运行时）。前者产出更小的 bundle，后者更灵活。

---

## 5. Phase 4：迭代式 Stub + Bundle

这是构建系统最巧妙的部分——**迭代式解决依赖缺失**。

### 5.1 核心循环

```javascript
// scripts/build.mjs:140-229
const MAX_ROUNDS = 5
let succeeded = false

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`🔨 Phase 4 round ${round}/${MAX_ROUNDS}: Bundling...`)

  try {
    esbuildOutput = execSync([
      'npx esbuild', `"${ENTRY}"`,
      '--bundle',
      '--platform=node',
      '--target=node18',
      '--format=esm',
      `--outfile="${OUT_FILE}"`,
      '--packages=external',    // ← npm 包不打包
      '--external:bun:*',       // ← Bun 内建模块排除
      '--allow-overwrite',
      '--log-level=error',
      '--log-limit=0',          // ← 显示所有错误
      '--sourcemap',
    ].join(' '), { ... })
    succeeded = true
    break
  } catch (e) {
    // 解析错误，生成 stub，继续
  }
}
```

### 5.2 esbuild 配置解析

| 参数 | 值 | 作用 |
|------|------|------|
| `--bundle` | - | 将所有本地模块打包成单文件 |
| `--platform=node` | - | 目标是 Node.js 运行时 |
| `--target=node18` | - | 编译到 Node.js 18 支持的语法 |
| `--format=esm` | - | 输出 ES Module 格式 |
| `--packages=external` | - | **不打包 npm 包**，保持 `import` |
| `--external:bun:*` | - | 排除所有 `bun:` 协议导入 |
| `--log-limit=0` | - | 不限制错误数量（用于收集所有缺失模块） |
| `--sourcemap` | - | 生成 source map 以便调试 |

**关键决策**：`--packages=external`

这意味着最终的 `dist/cli.js` **不包含** `node_modules` 中的依赖。用户需要先 `npm install` 安装依赖。这与完全自包含的 bundle 不同：

```
完全 bundle (未采用):    混合 bundle (已采用):
┌──────────────┐        ┌──────────────┐
│ cli.js       │        │ cli.js       │  ← 只包含项目代码
│  ├─ 项目代码 │        └──────┬───────┘
│  ├─ chalk    │               │
│  ├─ zod      │               ▼
│  ├─ ink      │        node_modules/     ← npm 包保持外部
│  └─ 200+ pkg │          ├─ chalk
└──────────────┘          ├─ zod
(可能 > 100MB)            └─ ... (正常 npm install)
```

### 5.3 Stub 生成策略

当 esbuild 报告缺失模块时，构建脚本解析错误并生成 stub：

```javascript
// scripts/build.mjs:176-228
const missingRe = /Could not resolve "([^"]+)"/g
const missing = new Set()

// 文本资源 → 空文件
if (/\.(txt|md|json)$/.test(cleanMod)) {
  await writeFile(p, cleanMod.endsWith('.json') ? '{}' : '', 'utf8')
}

// JS/TS 模块 → 导出空函数
if (/\.[tj]sx?$/.test(cleanMod)) {
  await writeFile(p, `
    // Auto-generated stub
    export default function ${safeName}() {}
    export const ${safeName} = () => {}
  `, 'utf8')
}
```

**为什么需要 Stub？**

因为 `feature('FLAG')` 被替换为 `false` 后，条件分支内的 `require()` / `import()` 虽然在运行时不会执行，但 esbuild 的静态分析仍然会尝试解析这些模块。如果模块文件不存在，esbuild 会报错。

```typescript
// 原始代码
if (feature('KAIROS')) {                    // → if (false)
  const Kairos = require('./kairos/UI.js')  // esbuild 仍尝试解析此模块
}
```

Stub 让 esbuild 能找到文件并成功打包，而死代码消除会最终移除这些 stub 代码。

### 5.4 专用 Stub 脚本

`scripts/stub-modules.mjs` 提供了更智能的 stub 生成：

```javascript
// scripts/stub-modules.mjs:48-120
for (const [mod] of moduleFiles) {
  // 用 grep 找到实际的导入者
  const grepResult = execSync(
    `grep -rl "${escapedMod}" "${BUILD_SRC}" 2>/dev/null || true`
  )
  
  // 从导入者的目录解析相对路径
  for (const importer of importers) {
    const importerDir = dirname(importer)
    const absPath = resolve(importerDir, mod)  // 精确解析路径
    // 生成 stub
  }
}
```

**关键改进**：`stub-modules.mjs` 使用 `grep` 找到实际导入该模块的文件，从导入者的位置解析相对路径。这比 `build.mjs` 中的"猜测路径"策略更准确。

---

## 6. `prepare-src.mjs`：另一种变换策略

`scripts/prepare-src.mjs` 提供了另一种构建前处理方法——**就地修改** `src/`：

```javascript
// scripts/prepare-src.mjs:40-50
// 将 bun:bundle 导入替换为 stub 文件的相对路径
if (src.includes("from 'bun:bundle'")) {
  // 根据文件深度计算正确的相对路径
  const rel = path.relative(SRC, path.dirname(filePath))
  const depth = rel ? '../'.repeat(rel.split('/').length) : ''
  src = src.replace(
    "from '../stubs/bun-bundle.js'",
    `from '${depth}stubs/bun-bundle.js'`
  )
}
```

**与 build.mjs 的区别**：

| 特性 | build.mjs | prepare-src.mjs |
|------|-----------|-----------------|
| 工作目录 | build-src/ 副本 | src/ 就地修改 |
| feature() 处理 | 替换为 false | 指向 stub 函数 |
| MACRO 处理 | 文本替换 | 正则表达式替换 |
| 用途 | 完整构建 | TypeScript 类型检查 |

`prepare-src.mjs` 主要服务于 `tsc --noEmit` 类型检查，让源码在不依赖 Bun 的情况下通过 TypeScript 编译器。

---

## 7. 构建输出分析

### 7.1 最终产物

```
dist/
└── cli.js           ← 主入口 (~数 MB)
└── cli.js.map       ← Source Map
```

```javascript
// scripts/build.mjs:231-235
if (succeeded) {
  const size = (await stat(OUT_FILE)).size
  console.log(`✅ Build succeeded: ${OUT_FILE}`)
  console.log(`   Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
}
```

### 7.2 Banner 注入

```javascript
`--banner:js=$'#!/usr/bin/env node\\n// Claude Code v${VERSION}\\n...'`
```

这确保输出文件：
1. 可作为 CLI 直接执行（shebang）
2. 包含版本和版权信息
3. 用户知道这是"从源码构建"的版本

---

## 8. 构建时优化策略

### 8.1 死代码消除 (DCE)

esbuild 的 DCE 机制会移除：
- `if (false) { ... }` 中的所有代码（feature flag 替换后）
- 未被引用的 stub 模块导出
- 未使用的 import 语句

**效果估算**：86 个 feature flag 全部设为 false，可能移除 **30-50%** 的代码量。

### 8.2 迭代而非一次性

```
Round 1: 打包 → 发现 15 个缺失模块 → 生成 stub
Round 2: 打包 → 发现 5 个新缺失模块 → 生成 stub
Round 3: 打包 → 成功！
```

**为什么需要多轮？** 因为 stub 模块本身可能导入其他缺失的模块。Round 1 创建的 stub 在 Round 2 中可能暴露新的依赖。最多 5 轮，通常 2-3 轮即可收敛。

### 8.3 增量构建策略

构建脚本本身不支持增量构建（每次清理 `build-src/` 重新开始），但可以通过以下方式加速：

1. **跳过 Phase 1**：如果 `build-src/` 已存在且源码未变更
2. **缓存 stub**：记录已知需要 stub 的模块，跳过迭代
3. **esbuild 的内建增量**：使用 `esbuild --watch` 模式

---

## 9. 设计决策与 Trade-off

### 决策 1：为什么用 esbuild 而不是 webpack/rollup？

| 维度 | esbuild | webpack | rollup |
|------|---------|---------|--------|
| 速度 | ⚡ Go 编写，极快 | 慢 | 中等 |
| 配置 | CLI 参数即可 | 需要 config 文件 | 需要 config + plugins |
| Node.js 支持 | 原生支持 | 需要 target 配置 | 需要 plugins |
| ESM 输出 | 原生 | 需要配置 | 原生 |

**结论**：esbuild 是 Node.js + ESM + 单文件输出场景的最佳选择。

### 决策 2：为什么 `--packages=external`？

- **优点**：bundle 体积小，npm 包可以独立更新
- **缺点**：用户需要 `npm install`，部署多了一步
- **权衡**：Claude Code 作为 npm 包分发，`npm install` 是自然的步骤

### 决策 3：为什么用文本替换而非 AST 变换？

- **优点**：简单、快速、无额外依赖
- **缺点**：可能误替换字符串中的内容
- **缓解**：正则表达式精确匹配特定模式，误替换风险极低

---

## 10. 启发与超越

### 如果你在构建类似系统

1. **编译时 feature flag** 是大规模代码库的必备工具。它让你在一个代码库中维护多个产品变体。
2. **迭代式 stub 生成** 是处理复杂依赖图的实用策略。与其预先分析所有依赖，不如"试错—修复"循环。
3. **不修改源码的构建** 消除了一大类构建问题。副本策略虽然慢一点，但安全得多。
4. **保持 npm 包外部** 让 bundle 保持轻量。只有项目代码被打包，第三方依赖通过正常的包管理器安装。
5. **考虑同时支持多个构建策略**——Claude Code 有 `build.mjs`、`transform.mjs`、`prepare-src.mjs` 三个脚本，分别服务于不同场景（完整构建、快速构建、类型检查）。

### 练习

- 运行 `node scripts/build.mjs`，观察每个 Phase 的输出
- 检查 `build-src/` 中变换后的代码，对比 `src/` 中的原始代码
- 尝试修改 `MACROS` 中的版本号，重新构建并验证
- 故意删除一个 feature-gated 模块，观察 stub 生成过程
