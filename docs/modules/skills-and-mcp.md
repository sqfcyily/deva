# Skill 与 MCP

> 状态：草案 · 最后更新：2026-09-08 · 对应包：`@deva/skills`、`@deva/mcp-client`

Deva 的能力开放通过两条路径：**Skill**（把工作流/知识固化为可触发的指令集）与 **MCP**（接入外部工具与资源）。二者与[子 Agent](./agent-engine.md#5-子-agentsub-agent)共同构成扩展体系。

---

## 第一部分 · Skill 系统

### 1. 什么是 Skill

Skill 是一个**打包好的指令 + 资源**单元，用于教 Agent 如何完成某类任务（部署步骤、评审清单、仓库特定工作流、图表规范等）。当任务匹配某 Skill 时，其指令被加载进当前回合，指导 Agent 的行为；部分 Skill 可携带可执行脚本或参考资料。

> 设计上对齐 Claude Code 的 Skill 心智模型：**渐进式披露**——先看到简介，命中后才加载完整指令，避免上下文浪费。

### 2. Skill 结构（约定）

```
<skill-name>/
├── SKILL.md            # 元数据 + 指令主体（必需）
├── references/         # 可选：参考资料（按需加载）
├── scripts/            # 可选：可执行脚本（受权限约束）
└── assets/             # 可选：模板/静态资源
```

`SKILL.md` 前置元数据（示意）：

```markdown
---
name: deploy-web
description: 部署 web 应用的标准步骤；当用户要求部署/发布前端时使用
allowed-tools: [exec, fs.read]      # 可选：限定该 Skill 可用工具
scope: workspace                    # 内置 / 全局 / 工作区
---

# 部署 Web 应用
1. 运行 `pnpm build` ...
2. ...
```

### 3. 发现与来源

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 内置 | 应用内置 | 官方精选（如图表规范、评审清单） |
| 全局用户 | `userData/skills/` | 用户个人 Skill |
| 工作区 | `<workspace>/.deva/skills/` | 项目专属，可随库共享 |

引擎启动/进入工作区时扫描以上位置，建立 Skill 索引（name + description）。

### 4. 触发机制

```mermaid
flowchart TD
    IDX[Skill 索引\n(name+description)] --> INJ[将简介注入系统提示]
    INJ --> TURN[回合进行中]
    TURN --> M{匹配到 Skill?}
    M -->|模型判断相关| LOAD[加载 SKILL.md 完整指令]
    M -->|用户显式调用 /skill| LOAD
    LOAD --> FOLLOW[Agent 遵循指令执行]
    FOLLOW --> REF{需要参考/脚本?}
    REF -->|按需| PULL[加载 references/ 运行 scripts/]
```

- **自动触发**：模型依据简介判断相关性后加载完整指令（渐进式披露）。
- **显式触发**：用户通过命令面板或 `/<skill-name>` 主动调用。
- **工具约束**：`allowed-tools` 限定该 Skill 期间可用的工具子集。
- **脚本执行**：`scripts/` 中的可执行内容按 `exec` 工具经[权限闸门](./permissions.md)，不因是 Skill 而豁免。

### 5. 管理 UI

- Skill 列表：来源、启用状态、描述、作用域。
- 启用/禁用、查看内容、编辑（用户 Skill）、新建（脚手架 `SKILL.md`）。
- 冲突处理：同名 Skill 按作用域优先级（workspace > global > 内置）解析。

---

## 第二部分 · MCP 客户端

### 6. 什么是 MCP

[Model Context Protocol](https://modelcontextprotocol.io/) 是连接 AI 应用与外部工具/数据源的开放协议。Deva 作为 **MCP Host/Client**，可连接多个 MCP Server，把它们暴露的 **Tools（工具）/ Resources（资源）/ Prompts（提示）** 汇聚给 Agent 使用。

对应包 `@deva/mcp-client`，基于官方 `@modelcontextprotocol/sdk`。

### 7. 传输方式

| 传输 | 场景 | 说明 |
| --- | --- | --- |
| **stdio** | 本地 MCP server（子进程） | 拉起本地进程，走标准输入输出；隔离在子进程 |
| **SSE** | 远程/网络 server | Server-Sent Events |
| **Streamable HTTP** | 远程/网络 server | 新式 HTTP 流式传输 |

### 8. 架构与生命周期

```mermaid
flowchart LR
    subgraph Deva
      REG[MCP 注册表/配置] --> MGR[连接管理器]
      MGR -->|stdio| S1[MCP Server A\n(子进程)]
      MGR -->|SSE/HTTP| S2[MCP Server B\n(远程)]
      MGR --> AGG[能力聚合\nTools/Resources/Prompts]
      AGG --> TOOLREG[注入 Agent 工具注册表]
    end
    TOOLREG --> AG[Agent 引擎]
    AG -. 调用 MCP 工具(经权限) .-> MGR
```

生命周期：**配置 → 连接握手（能力协商）→ 列出并聚合能力 → 注入 Agent → 调用 → 断连/重连/清理**。

- 连接失败/超时有重试与降级；单个 server 故障不影响其他。
- stdio server 作为受管子进程，随作用域（全局/工作区）拉起与回收。

### 9. 能力接入

| MCP 能力 | 在 Deva 中的呈现 |
| --- | --- |
| **Tools** | 作为动态工具注入 Agent 工具注册表，默认权限 `ask`（见[权限](./permissions.md)） |
| **Resources** | 可被 Agent 读取或用户 `@` 引用的外部资源 |
| **Prompts** | 可作为命令/模板供用户或 Agent 使用 |

- MCP 工具的 schema 由 server 声明，映射到统一工具接口。
- 返回内容视为**数据**，不自动提权（防提示注入）。
- 若 server 声明工具为破坏性/写操作，纳入二次确认。

### 10. 配置

分层配置（全局/工作区），示意：

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "enabled": true
    },
    "company-tools": {
      "transport": "http",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "<secret-ref>" },
      "enabled": true
    }
  }
}
```

- 密钥用**凭据引用**，真实值在系统凭据库（见[安全模型](../architecture/security.md)）。
- 工作区级 MCP 配置可随库共享（不含密钥）。

### 11. 管理 UI

- MCP server 列表：连接状态、传输方式、暴露的工具/资源数、启用开关。
- 连接测试、日志查看、能力浏览（该 server 提供哪些工具）。
- 为特定 server/工具配置权限规则。

### 12. 安全要点

- stdio server 以子进程隔离，可设资源/超时上限。
- 默认**显式启用**，不自动信任第三方 server。
- 所有 MCP 工具调用经统一权限闸门；来源在权限弹窗中标注。
- 详见[安全模型 §7](../architecture/security.md)。

## 13. 待决事项

- Skill 与 Claude Code 生态 Skill 的兼容程度（能否直接复用社区 Skill 格式）。
- MCP OAuth 授权流程（远程 server 需要交互式授权时）的 UI。
- 工具命名冲突（多 server 同名工具）的命名空间策略（如 `serverName/toolName`）。
- 是否支持 Deva 反向作为 MCP Server 暴露自身能力（远期）。
