# 目录结构

> 状态：草案 · 最后更新：2026-09-08
>
> 定义 monorepo 的组织方式、各包边界与依赖方向。这是**约定**，落地时以此为准，如需调整先改本文。

## 1. 顶层布局

```
deva/
├── apps/
│   └── desktop/                 # Electron 桌面应用（唯一 app）
│       ├── electron.vite.config.ts
│       ├── package.json
│       └── src/
│           ├── main/            # 主进程
│           ├── preload/         # 预加载脚本
│           └── renderer/        # React 渲染层
├── packages/                    # 与 UI/Electron 无关的核心域（可单测）
│   ├── shared/                  # @deva/shared 跨层类型/常量/契约
│   ├── agent-core/              # @deva/agent-core Agent 引擎
│   ├── providers/               # @deva/providers 模型 Provider 适配
│   ├── tools/                   # @deva/tools 内置工具与注册表
│   ├── permissions/             # @deva/permissions 权限引擎
│   ├── skills/                  # @deva/skills Skill 运行时
│   ├── mcp-client/              # @deva/mcp-client MCP 客户端
│   ├── terminal/                # @deva/terminal PTY 会话
│   ├── ssh/                     # @deva/ssh SSH/SFTP
│   ├── db/                      # @deva/db MySQL/Redis
│   ├── git/                     # @deva/git Git 封装
│   ├── ui/                      # @deva/ui 设计系统与共享组件
│   └── i18n/                    # @deva/i18n 本地化资源与运行时
├── docs/                        # 文档体系（本目录）
├── resources/                   # 图标、许可、静态资源
├── scripts/                     # 构建/发布/开发脚本
├── .github/                     # CI 工作流
├── package.json                 # 根：工作区与统一脚本
├── pnpm-workspace.yaml
├── tsconfig.base.json           # 共享 TS 配置
├── LICENSE
└── README.md
```

## 2. `apps/desktop` 内部

```
apps/desktop/src/
├── main/
│   ├── index.ts                 # 主进程入口：app 生命周期、窗口
│   ├── windows/                 # 窗口创建与管理
│   ├── ipc/                     # IPC handler 注册（按域拆分）
│   │   ├── router.ts            # 统一注册/校验/错误封装
│   │   ├── agent.ipc.ts
│   │   ├── fs.ipc.ts
│   │   ├── git.ipc.ts
│   │   ├── terminal.ipc.ts
│   │   ├── ssh.ipc.ts
│   │   ├── db.ipc.ts
│   │   └── permissions.ipc.ts
│   ├── services/                # 编排核心域包，桥接 Utility 进程
│   │   ├── agent.service.ts
│   │   ├── workspace.service.ts
│   │   ├── config.service.ts
│   │   └── credentials.service.ts
│   ├── utility/                 # Utility Process 入口脚本
│   │   ├── terminal.worker.ts
│   │   ├── ssh.worker.ts
│   │   └── db.worker.ts
│   └── config/                  # 默认配置、schema
├── preload/
│   ├── index.ts                 # contextBridge 暴露 window.deva
│   └── api/                     # 分域 API 定义（与 ipc/ 对应）
└── renderer/
    ├── index.html
    ├── main.tsx                 # React 挂载
    ├── app/                     # 应用外壳、路由、Provider
    ├── layout/                  # 布局外壳（见 UI 文档：主体+工具窗口）
    ├── features/                # 按功能垂直切分
    │   ├── chat/                # Agent 会话（主体）
    │   ├── editor/              # 代码编辑器与 diff
    │   ├── explorer/            # 文件树/工作区
    │   ├── git/                 # Git 面板
    │   ├── terminal/            # 终端 UI
    │   ├── ssh/                 # SSH 面板
    │   ├── database/            # MySQL/Redis 面板
    │   ├── skills/              # Skill 管理
    │   ├── mcp/                 # MCP 管理
    │   ├── permissions/         # 权限弹窗与设置
    │   └── settings/            # 设置（模型/主题/语言…）
    ├── stores/                  # 前端状态（Zustand）
    ├── hooks/
    └── styles/                  # 全局样式与主题 token
```

> `features/*` 采用「功能垂直切分」：每个功能自带组件、hooks、局部状态、与 `window.deva` 的调用封装，减少横向耦合。

## 3. 典型 `packages/*` 结构

以 `@deva/agent-core` 为例，其余包同构：

```
packages/agent-core/
├── package.json                 # name: @deva/agent-core
├── tsconfig.json
├── src/
│   ├── index.ts                 # 公共导出（唯一对外入口）
│   ├── agent.ts
│   ├── loop.ts
│   ├── context/
│   ├── subagent/
│   └── types.ts
└── test/                        # 或 src 内 *.test.ts
```

**包规范**
- 每个包只通过 `src/index.ts` 对外导出（barrel），内部结构自由。
- `package.json` 的 `name` 统一 `@deva/<pkg>`，`exports` 指向构建产物或源（开发期）。
- 包内**不 import Electron**（`terminal`/`ssh`/`db` 也只依赖 Node 与其驱动库，不依赖 Electron API）。

## 4. 依赖方向规则（强约束）

```mermaid
flowchart TD
    R[renderer] --> UIp[@deva/ui]
    R --> I18N[@deva/i18n]
    R -. 仅类型 .-> SH[@deva/shared]
    R -->|IPC 运行期| MAIN[main]

    MAIN --> AG[@deva/agent-core]
    MAIN --> PERM[@deva/permissions]
    MAIN --> TOOLS[@deva/tools]
    MAIN --> SK[@deva/skills]
    MAIN --> MCP[@deva/mcp-client]
    MAIN --> TERM[@deva/terminal]
    MAIN --> SSHp[@deva/ssh]
    MAIN --> DB[@deva/db]
    MAIN --> GIT[@deva/git]

    AG --> PROV[@deva/providers]
    AG --> TOOLS
    SK --> AG
    TOOLS -. 经闸门 .-> PERM

    AG --> SH
    PROV --> SH
    TOOLS --> SH
    PERM --> SH
    SK --> SH
    MCP --> SH
    TERM --> SH
    SSHp --> SH
    DB --> SH
    GIT --> SH
    UIp --> SH
```

**规则**
1. `@deva/shared` 是最底层，**不依赖任何业务包**；所有包可依赖它。
2. **禁止循环依赖**（CI 用 `dpdm`/`madge` 检测）。
3. `renderer` **不得**直接依赖 `terminal/ssh/db/git/agent-core` 等核心包（它们含 Node 能力）；只能通过 IPC 调用 `main`。渲染层可依赖 `@deva/ui`、`@deva/i18n`，并 `import type` 引用 `@deva/shared` 的类型。
4. `main` 是核心域的**编排者**，可依赖核心包；核心包**不得反向依赖** `main`。
5. 核心包之间的依赖遵循上图箭头方向（如 `agent-core → providers`，不可反向）。

## 5. 配置与数据存放（运行时）

遵循各平台约定（经 Electron `app.getPath`）：

| 内容 | 位置（示意） | 说明 |
| --- | --- | --- |
| 全局配置 | `userData/config.json` | 主题、语言、默认 Provider 等 |
| 凭据/密钥 | 系统凭据库 / 加密文件 | 见 [安全模型](./security.md)，不入明文配置 |
| 会话/任务 | `userData/sessions/` 或本地 SQLite | 持久化与恢复 |
| 工作区配置 | `<workspace>/.deva/` | 项目级 Agent/权限/MCP/Skill 配置 |
| 日志 | `userData/logs/` | 分进程滚动日志 |
| MCP/Skill 缓存 | `userData/cache/` | 可清理 |

> `<workspace>/.deva/` 建议纳入或忽略由用户决定；敏感项默认加入 `.gitignore` 建议列表。

## 6. 命名与约定

- 目录/文件：`kebab-case`；React 组件文件：`PascalCase.tsx`。
- IPC 通道命名：`域:动作`（如 `fs:read`、`agent:send`）。
- 包名：`@deva/<pkg>`；类型集中在各包 `types.ts` 或 `@deva/shared`。
- 详见 [编码规范](../engineering/coding-standards.md)。
