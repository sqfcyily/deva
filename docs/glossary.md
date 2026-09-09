# 术语表（Glossary）

> 状态：草案 · 最后更新：2026-09-08
>
> 项目内专有名词与缩写的统一解释，避免歧义。按主题分组。

## Agent 相关

| 术语 | 解释 |
| --- | --- |
| **Agent** | 能通过工具调用自主完成任务的 AI 智能体，Deva 的核心。 |
| **Session（会话）** | 一段持续的 Agent 对话，绑定工作区、模型、权限作用域与上下文。 |
| **Turn（回合）** | 用户一次输入触发的一轮「模型↔工具」交互。 |
| **Tool（工具）** | Agent 可调用的能力单元（读写文件、执行命令、Git、DB 等）。 |
| **Tool Call（工具调用）** | 模型请求执行某工具的一次调用（name + args）。 |
| **Context（上下文）** | 送入模型的消息、系统提示、工具声明与引用材料的集合。 |
| **Checkpoint（检查点）** | 可回滚的会话/文件状态快照。 |
| **Sub-Agent（子 Agent）** | 由主 Agent 派生、上下文隔离、执行子任务的 Agent。 |
| **@-mention（引用）** | 用户把文件/选区/符号精确注入上下文的机制。 |

## 模型与 Provider

| 术语 | 解释 |
| --- | --- |
| **Provider** | 某家模型服务的适配器（Anthropic/OpenAI/Ollama 等），实现统一接口。 |
| **Provider 抽象层** | 抹平各家差异、供 Agent 引擎统一编程的层，见 [providers.md](./architecture/providers.md)。 |
| **能力探测（capabilities）** | 判断某模型是否支持工具调用/多模态/思考等，用于降级。 |
| **StreamEvent** | 归一化的流式事件（text_delta / tool_call / usage 等）。 |
| **OpenAI 协议兼容** | 遵循 OpenAI API 形状的第三方/自建端点，可用自定义 baseURL 接入。 |
| **Token / 用量** | 模型输入输出的计量单位，用于成本估算。 |

## 权限与安全

| 术语 | 解释 |
| --- | --- |
| **权限引擎** | Agent 与危险能力之间的闸门，做 allow/deny/ask 决策。 |
| **决策三态** | `allow`（放行）/ `deny`（拒绝）/ `ask`（询问用户）。 |
| **作用域（Scope）** | 规则生效范围：`session` / `workspace` / `global`。 |
| **记忆粒度** | 用户放行时选择的记住范围：仅本次 / 本会话 / 本项目 / 永久。 |
| **只读模式** | 全局降级，禁止写/执行/破坏性工具。 |
| **破坏性操作** | 删除、覆盖、`rm -rf`、`DROP`、`push --force` 等有严重副作用的操作。 |
| **提示注入（Prompt Injection）** | 外部内容（文件/网页/MCP 返回）中夹带的恶意指令；防线是「内容即数据非指令」。 |
| **凭据引用（secret-ref）** | 配置中指向系统凭据库的占位，不含明文密钥。 |

## 扩展能力

| 术语 | 解释 |
| --- | --- |
| **Skill** | 打包的指令 + 资源单元，教 Agent 如何完成某类任务；渐进式披露。 |
| **渐进式披露** | 先展示 Skill 简介，命中后才加载完整指令，节省上下文。 |
| **MCP** | Model Context Protocol，连接 AI 应用与外部工具/数据源的开放协议。 |
| **MCP Host/Client** | 连接并使用 MCP Server 能力的一方，Deva 扮演此角色。 |
| **MCP Server** | 对外暴露 Tools/Resources/Prompts 的服务端。 |
| **stdio / SSE / Streamable HTTP** | MCP 的三种传输方式。 |

## 架构与工程

| 术语 | 解释 |
| --- | --- |
| **Main Process（主进程）** | Electron 应用主进程，负责窗口、生命周期、编排、权限。 |
| **Renderer（渲染进程）** | 运行 React UI 的 Chromium 进程，零 Node 权限。 |
| **Preload（预加载）** | 主/渲染之间的受控桥梁，经 contextBridge 暴露白名单 API。 |
| **Utility Process（工具进程）** | 承载终端/SSH/DB/MCP 等易崩溃/阻塞能力的独立进程。 |
| **IPC** | 进程间通信；Deva 用类型安全、经校验的通道。 |
| **contextIsolation** | Electron 安全特性，隔离页面与预加载上下文。 |
| **monorepo** | 单仓多包结构（`apps/` + `packages/`），用 pnpm workspaces。 |
| **核心域（core domain）** | 与 UI/Electron 无关、可单测的业务包（`@deva/*`）。 |
| **设计 token** | 语义化的颜色/间距/圆角变量，支撑主题与明暗切换。 |
| **PTY** | 伪终端，`node-pty` 提供，支撑交互式终端。 |
| **Docs-first** | 涉及架构/接口的改动先改文档再改代码的约定。 |

## 产品

| 术语 | 解释 |
| --- | --- |
| **Deva** | 本产品名（暂用，可替换）。 |
| **工作区（Workspace）** | 一个打开的项目根目录及其绑定配置/仓库/会话。 |
| **Activity Bar** | 左侧窄条，切换主导航面板（会话/文件/Git/DB/SSH…）。 |
| **工具窗口** | IDEA 式可停靠面板（终端/Git/DB 结果等）。 |
| **命令面板** | 全局动作/文件/会话检索入口（Ctrl/Cmd+K）。 |
| **MVP** | 最小可行版本，Deva 定义为 M0+M1（见 [roadmap](./product/roadmap.md)）。 |
