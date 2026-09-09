# Deva 文档中心

本目录是 Deva 的完整设计文档体系。所有文档随实现推进持续维护，是理解与参与项目的**唯一权威来源（single source of truth）**。

> 阅读建议：新成员按「产品 → 架构 → 模块 → 工程」的顺序通读；后续按需查阅。文中出现的专有名词见 [术语表](./glossary.md)。

## 📚 目录

### 01 · 产品 Product
| 文档 | 说明 |
| --- | --- |
| [产品需求文档 PRD](./product/PRD.md) | 愿景、目标用户、功能范围、竞品对比、非目标、成功指标 |
| [路线图 Roadmap](./product/roadmap.md) | 里程碑划分、MVP 范围、迭代计划 |

### 02 · 架构 Architecture
| 文档 | 说明 |
| --- | --- |
| [架构总览 Overview](./architecture/overview.md) | 分层架构、Electron 进程模型、模块划分、核心数据流 |
| [技术栈决策 Tech Stack](./architecture/tech-stack.md) | 关键技术选型及其权衡理由（含被否决方案） |
| [目录结构 Directory Structure](./architecture/directory-structure.md) | monorepo 组织、包边界与依赖方向 |
| [安全模型 Security](./architecture/security.md) | IPC 设计、进程隔离、权限模型、密钥与凭据存储 |
| [Provider 抽象层 Providers](./architecture/providers.md) | 多模型接入的统一抽象与适配设计 |

### 03 · 功能模块 Modules
| 文档 | 说明 |
| --- | --- |
| [Agent 引擎](./modules/agent-engine.md) | Agent 循环、工具系统、上下文管理、子 Agent 编排 |
| [权限管控](./modules/permissions.md) | 权限模型、决策流程、作用域与持久化 |
| [Skill 与 MCP](./modules/skills-and-mcp.md) | Skill 系统与 MCP 客户端集成 |
| [IDE 能力](./modules/ide-features.md) | 工作区、Git、编辑器、终端、SSH、MySQL/Redis |
| [界面 / 主题 / 多语言](./modules/ui-theming-i18n.md) | 布局规范、主题系统、国际化 |

### 04 · 工程 Engineering
| 文档 | 说明 |
| --- | --- |
| [编码规范 Coding Standards](./engineering/coding-standards.md) | 语言、命名、分层、错误处理、提交规范 |
| [构建与发布 Build & Release](./engineering/build-release.md) | 构建流程、打包、CI、自动更新、代码签名 |
| [测试策略 Testing](./engineering/testing.md) | 测试分层、工具选型、覆盖目标 |

### 附录
| 文档 | 说明 |
| --- | --- |
| [术语表 Glossary](./glossary.md) | 项目内专有名词与缩写 |

## 🧭 按角色导航

- **产品 / 需求视角** → [PRD](./product/PRD.md) → [路线图](./product/roadmap.md) → [界面规范](./modules/ui-theming-i18n.md)
- **架构 / 技术负责人** → [架构总览](./architecture/overview.md) → [技术栈](./architecture/tech-stack.md) → [安全模型](./architecture/security.md)
- **Agent / AI 方向开发** → [Agent 引擎](./modules/agent-engine.md) → [Provider 抽象](./architecture/providers.md) → [Skill 与 MCP](./modules/skills-and-mcp.md) → [权限管控](./modules/permissions.md)
- **IDE 工具方向开发** → [IDE 能力](./modules/ide-features.md) → [目录结构](./architecture/directory-structure.md)
- **新贡献者** → 本页通读 → [编码规范](./engineering/coding-standards.md) → [构建与发布](./engineering/build-release.md)

## 📐 文档约定

- 语言：中文为主，技术术语保留英文。
- 状态标记：文档顶部以 `状态：草案 / 评审中 / 已确认` 标注成熟度。
- 变更：涉及架构或接口的重大调整，应先更新对应文档再动代码（Docs-first）。
- 图示：优先使用 [Mermaid](https://mermaid.js.org/)，随文本一起进版本库。
