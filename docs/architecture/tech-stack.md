# 技术栈决策

> 状态：草案 · 最后更新：2026-09-08
>
> 记录关键技术选型及其权衡。每项含「选择 / 理由 / 备选与否决原因」。已确认项标 ✅，待定项标 🔶。

## 决策总览

| 领域 | 选择 | 状态 |
| --- | --- | --- |
| 桌面框架 | Electron | ✅ |
| 前端框架 | React + TypeScript | ✅ |
| 构建/打包 | Vite + electron-builder | ✅ |
| 包管理/工程 | pnpm workspaces（monorepo） | ✅ |
| 前端状态 | Zustand（轻量），复杂域用 XState 局部 | 🔶 |
| 代码编辑器 | CodeMirror 6（默认）/ Monaco（重场景） | 🔶 |
| 终端 UI | xterm.js | ✅ |
| PTY | node-pty | ✅ |
| SSH | ssh2 | ✅ |
| MySQL | mysql2 | ✅ |
| Redis | ioredis | ✅ |
| Git | simple-git（命令封装）+ 可选 isomorphic-git | 🔶 |
| AI SDK | 官方各家 SDK（@anthropic-ai/sdk / openai），自研统一抽象 | ✅ |
| MCP | @modelcontextprotocol/sdk | ✅ |
| i18n | i18next + react-i18next | ✅ |
| 样式 | CSS 变量设计 token + Tailwind 或 CSS Modules | 🔶 |
| 测试 | Vitest（单元）+ Playwright（E2E，Electron） | ✅ |

---

## 1. 桌面框架：Electron ✅

**理由**
- 需要深度系统能力：本地 shell（`node-pty`）、SSH（`ssh2`）、MySQL（`mysql2`）、Redis（`ioredis`）——这些在 Node 生态中最成熟、开箱即用。
- 与 Codex 的 TS/React 技术栈一致，团队与生态复用度高。
- 跨平台成熟，Windows 优先场景稳妥。

**备选与否决**
- **Tauri 2.0**：包体更小、内存更低，但终端/SSH/DB 需依赖 Rust crate，生态成熟度与开发速度不如 Node，团队 Rust 成本高。作为长期「瘦身」备选保留，不作为初期方案。
- **JetBrains 平台**：最贴近 IDEA，但 Agent/MCP 生态需自建，JVM 技术栈与 Node 生态割裂，学习曲线陡。否决。

**代价与缓解**：包体与内存偏大 → 用 Utility Process 拆分、按需加载、生产裁剪；严格遵守 Electron 安全基线（见 [安全模型](./security.md)）。

## 2. 前端：React + TypeScript ✅

- 生态最广、组件与状态方案丰富、招聘友好。TypeScript 全栈统一类型，核心域与 UI 共享 `@deva/shared` 类型。
- 备选 Vue/Svelte：可行但生态与团队熟悉度不及 React；Solid 性能好但生态偏小。均否决。

## 3. 构建与打包：Vite + electron-builder ✅

- **Vite**：渲染层极快的 HMR 与构建；配合 `vite-plugin-electron` 或 electron-vite 管理主/预加载/渲染三套构建。
- **electron-builder**：成熟的多平台打包与自动更新（`electron-updater`），Windows NSIS、代码签名支持完善。
- 备选 Electron Forge：亦可，插件化清晰；但 electron-builder 的打包/更新链路更省心。作为备选。

## 4. 工程结构：pnpm monorepo ✅

- `apps/desktop`（Electron 应用）+ `packages/*`（核心域）。pnpm 的硬链接与 workspace 协议对多包、原生依赖友好。
- 好处：核心逻辑与 UI 解耦、独立测试、清晰依赖边界。详见 [目录结构](./directory-structure.md)。

## 5. 前端状态：Zustand（+ 局部 XState）🔶

- **Zustand**：轻量、样板少、易与 React 并发特性配合，适合本应用「多而杂」的 UI 状态。
- 复杂有状态流程（Agent 任务生命周期、连接状态机）局部引入 **XState** 提升可推理性。
- 备选 Redux Toolkit（重、规范强）、Jotai（原子化）。待 M0 做一次小型验证后定稿。

## 6. 代码编辑器：CodeMirror 6 vs Monaco 🔶

| | CodeMirror 6 | Monaco |
| --- | --- | --- |
| 体积 | 小、模块化 | 大（含 VS Code 编辑器内核） |
| 能力 | 高亮/编辑/扩展强，LSP 需自接 | 开箱即用的智能能力、diff 编辑器 |
| 定制 | 极高 | 中 |
| 移动/性能 | 好 | 一般 |

**倾向**：初期用 **CodeMirror 6**（契合「专业不臃肿」，diff 用其扩展或 `diff` 视图）。若后续需要重量级 IDE 体验（多语言智能、成熟 diff 编辑器），在特定视图引入 **Monaco**。M1 定稿。

## 7. 终端：xterm.js + node-pty ✅

- `xterm.js` 渲染 + `node-pty` 提供伪终端，是 VS Code 同款组合，稳定可靠。
- PTY 运行在 Utility Process，避免阻塞主进程；注意 Windows 下 `conpty` 支持与预编译产物。

## 8. 远程与数据库：ssh2 / mysql2 / ioredis ✅

- `ssh2`：纯 JS 的 SSH2 客户端，支持 exec/shell/SFTP，社区成熟。
- `mysql2`：性能好、支持 Promise 与预处理。
- `ioredis`：功能全、集群/哨兵支持好。
- 均在 Utility Process 内使用，连接状态与凭据由主进程管理。

## 9. Git：simple-git（+ 可选 isomorphic-git）🔶

- **simple-git**：封装系统 `git` 命令，功能全、贴近用户本地 Git 行为（凭据、hooks 一致）。**默认方案**。
- **isomorphic-git**：纯 JS，不依赖系统 git，适合无 git 环境或需精细控制的场景，作为可选后备。
- 取舍点：是否强依赖用户已安装 git。倾向默认要求系统 git（开发者受众合理），isomorphic-git 兜底。

## 10. AI 接入：官方 SDK + 自研抽象 ✅

- 使用各家官方 SDK（`@anthropic-ai/sdk`、`openai` 等），上层封装统一的 `Provider` 接口做能力抹平（流式、工具调用、多模态、token 计量）。
- Ollama / OpenAI 协议兼容端点通过 OpenAI 兼容适配器接入。
- 详见 [Provider 抽象层](./providers.md)。

## 11. MCP：@modelcontextprotocol/sdk ✅

- 使用官方 TypeScript SDK 实现 MCP 客户端，支持 stdio / SSE / Streamable HTTP 传输。详见 [Skill 与 MCP](../modules/skills-and-mcp.md)。

## 12. i18n：i18next + react-i18next ✅

- 成熟、支持命名空间、插值、复数、懒加载；语言默认跟随系统。详见 [界面/主题/多语言](../modules/ui-theming-i18n.md)。

## 13. 样式方案 🔶

- 核心：**CSS 变量驱动的设计 token**（承载主题与明/暗切换）。
- 组件样式：Tailwind（提速）或 CSS Modules（隔离清晰）二选一，M0 定稿。无论哪种，颜色/间距/圆角一律走 token，不硬编码。

## 14. 测试：Vitest + Playwright ✅

- **Vitest**：核心域与前端单元/组件测试，快、与 Vite 一致。
- **Playwright**：Electron E2E（`_electron` API），覆盖关键用户流。
- 详见 [测试策略](../engineering/testing.md)。

---

## 版本与兼容策略

- 追随 Electron 稳定版（LTS 化跟进），及时同步安全更新。
- 原生模块（node-pty/ssh2 依赖）随 Electron 的 Node ABI 重建，CI 中固化预编译流程。
- 依赖锁定（`pnpm-lock.yaml`），关键安全依赖定期审计。
