<div align="center">

# Deva

**面向开发者的 AI 原生开发工作台 / AI-Native Development Workbench**

一款桌面端 AI Agent 应用，融合 Claude Code 的智能体能力（读写文件、权限管控、Skill、MCP、子 Agent）与 IntelliJ IDEA 的开发工具能力（工作区、Git、MySQL/Redis、终端、SSH），界面以 Codex 为主体、参考 IDEA 2026。

[文档](./docs/README.md) · [产品需求](./docs/product/PRD.md) · [架构设计](./docs/architecture/overview.md) · [路线图](./docs/product/roadmap.md)

</div>

---

> ⚠️ **项目状态：文档设计阶段（Pre-Alpha）。** 当前仓库以设计文档为主，代码尚未开始落地。文档中出现的目录、模块、依赖均为**设计约定**，随实现推进可能调整。

## 这是什么

Deva 是一个把「AI 编码智能体」与「专业 IDE 工具集」合二为一的桌面应用。它面向开发人员，试图回答一个问题：

> 当 AI Agent 成为开发流程的一等公民时，围绕它的 IDE 应该长什么样？

- 像 **Claude Code** 一样：拥有一个可以读写代码、执行命令、调用工具的 Agent，具备**细粒度权限管控**，可扩展 **Skill**、接入 **MCP** 服务、编排**子 Agent**。
- 像 **Codex** 一样：以对话式 Agent 工作流为主体的清爽界面，任务驱动、diff 可视化、可回溯。
- 像 **IntelliJ IDEA** 一样：内置工作区管理、Git 集成、数据库客户端（MySQL / Redis）、集成终端、远程 SSH 连接等专业工具窗口。

## 核心能力一览

| 领域 | 能力 |
| --- | --- |
| **AI Agent** | 多 Provider 抽象（Claude / OpenAI / Ollama / OpenAI 协议兼容）、工具调用循环、上下文管理、任务回溯 |
| **权限管控** | 工具级 / 路径级 / 命令级权限，Ask / Allow / Deny 三态，会话与项目级作用域 |
| **可扩展性** | Skill 系统、MCP 客户端（stdio / SSE / HTTP）、子 Agent 编排 |
| **代码与文件** | 代码编辑器、文件树、读写与 diff、搜索 |
| **工作区** | 多工作区/项目管理、最近打开、项目级配置 |
| **版本控制** | Git 状态、暂存、提交、分支、diff、历史、冲突处理 |
| **数据库** | MySQL 与 Redis 连接、查询、结果浏览与编辑 |
| **终端与远程** | 集成终端（PTY）、SSH 远程连接、远程命令与文件 |
| **界面体验** | Codex 主体布局 + IDEA 工具窗口、主题切换（默认跟随系统）、多语言 i18n |

> 详见 [产品需求文档 PRD](./docs/product/PRD.md)。

## 技术栈

- **桌面框架**：[Electron](https://www.electronjs.org/)（多进程：Main / Renderer / Utility）
- **前端**：React + TypeScript + Vite
- **工程结构**：pnpm monorepo（`apps/` + `packages/`）
- **AI**：自研 Agent 引擎 + 多 Provider 适配层
- **关键原生能力**：`node-pty`（终端）、`ssh2`（SSH）、`mysql2`（MySQL）、`ioredis`（Redis）、`simple-git` / `isomorphic-git`（Git）
- **目标平台**：Windows 优先，架构兼容 macOS / Linux

> 技术选型的详细理由见 [技术栈决策](./docs/architecture/tech-stack.md)。

## 文档地图

完整文档索引见 **[docs/README.md](./docs/README.md)**。快速入口：

- 🧭 [产品需求文档（PRD）](./docs/product/PRD.md) — 愿景、用户画像、功能范围、竞品对比
- 🗺️ [路线图](./docs/product/roadmap.md) — 里程碑与 MVP 范围
- 🏛️ [架构总览](./docs/architecture/overview.md) — 进程模型、模块划分、数据流
- 🔐 [安全模型](./docs/architecture/security.md) — IPC、进程隔离、权限与密钥
- 🤖 [Agent 引擎](./docs/modules/agent-engine.md) — Agent 循环、工具、子 Agent
- 🧩 [Skill 与 MCP](./docs/modules/skills-and-mcp.md)
- 🛠️ [IDE 能力](./docs/modules/ide-features.md) — 工作区、Git、终端、SSH、数据库
- 🎨 [界面 / 主题 / 多语言](./docs/modules/ui-theming-i18n.md)

## 开发（规划中）

> 以下命令为**目标形态**，实际脚手架尚未搭建。

```bash
pnpm install          # 安装依赖
pnpm dev              # 启动开发环境（Electron + Vite HMR）
pnpm build            # 构建产物
pnpm package          # 打包为可分发安装包
pnpm test             # 运行测试
pnpm lint             # 代码检查
```

工程规范见 [编码规范](./docs/engineering/coding-standards.md) 与 [构建与发布](./docs/engineering/build-release.md)。

## 许可证

[MIT](./LICENSE) © 2026 sqfcy
