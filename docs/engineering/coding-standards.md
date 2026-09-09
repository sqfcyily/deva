# 编码规范

> 状态：草案 · 最后更新：2026-09-08

统一的工程约定，保证 monorepo 在多人协作下的一致与可维护。工具通过 ESLint/Prettier/TypeScript 强制执行大部分规则；本文记录约定与理由。

## 1. 语言与类型

- **TypeScript strict**：全仓 `strict: true`，禁用隐式 `any`；对外接口显式标注类型。
- **优先不可变**：默认 `const`、只读数据结构；避免共享可变状态。
- **类型来源单一**：跨层共享类型放 `@deva/shared`；渲染层引用核心类型用 `import type`（不引入运行时依赖）。
- **禁用 `any` 逃逸**：确需时用 `unknown` + 收窄，或明确注释理由。
- **Result/错误建模**：跨 IPC/异步边界用统一 `Result<T,E>` 或明确的错误类型，避免抛裸异常穿越进程边界。

## 2. 命名约定

| 对象 | 约定 | 示例 |
| --- | --- | --- |
| 目录 / 非组件文件 | kebab-case | `agent-core`、`fs.ipc.ts` |
| React 组件文件 | PascalCase | `ChatPanel.tsx` |
| 组件 / 类 / 类型 | PascalCase | `PermissionRule` |
| 变量 / 函数 | camelCase | `buildContext` |
| 常量 | UPPER_SNAKE | `MAX_STEPS` |
| 包名 | `@deva/<pkg>` | `@deva/providers` |
| IPC 通道 | `域:动作` | `fs:read`、`agent:send` |
| i18n key | `namespace.area.item` | `settings.model.title` |

## 3. 模块与依赖边界

- 每个 `packages/*` 仅通过 `src/index.ts` 对外导出（barrel）；不深链内部路径。
- 遵守[目录结构](../architecture/directory-structure.md#4-依赖方向规则强约束)的依赖方向：
  - `@deva/shared` 不依赖任何业务包。
  - 渲染层不直接依赖含 Node 能力的核心包（走 IPC）。
  - 核心包不反向依赖 `main`；核心包之间按既定箭头方向。
- **禁止循环依赖**，CI 用 `madge`/`dpdm` 检测。
- 核心域包**不 import Electron**。

## 4. React / 前端

- 函数组件 + Hooks；避免巨型组件，按 `features/*` 垂直切分。
- 状态：局部用组件状态，跨组件用 Zustand store；副作用集中在 hooks。
- 与主进程通信统一经 `window.deva.*`（封装在各 feature 的 api 层），不散落裸 IPC 调用。
- 列表/大数据虚拟化；避免在渲染路径做重计算。
- 样式走设计 token，不硬编码颜色/间距（见[界面文档](../modules/ui-theming-i18n.md#5-主题系统)）。
- 用户可见文本一律走 i18n key。

## 5. 主进程 / 核心域

- IPC handler：**先校验后执行**（参数 schema + 作用域 + 权限），错误统一封装。
- 重/阻塞/易崩溃逻辑放 Utility Process（终端/SSH/DB/MCP-stdio）。
- 核心逻辑与副作用分离：纯函数化的决策（如权限判定、上下文装配）便于单测；IO 经接口注入。
- 全链路支持 `AbortSignal`（取消/停止）。
- 资源必须可释放：连接、子进程、监听器在作用域结束时清理。

## 6. 错误处理与日志

- **用户可读 vs 技术细节**分离：给用户友好提示，日志留完整细节。
- **日志**：结构化（JSON 或带字段），分进程；级别 `debug/info/warn/error`；生产默认 `info`。
- **脱敏**：凭据、token、Authorization、连接串在日志/错误中强制脱敏。
- 不吞异常：捕获后要么恢复、要么上报、要么明确降级，禁止空 `catch`。

## 7. 异步与并发

- 优先 `async/await`；避免未处理的 Promise（lint 强制）。
- 并发有上限（子 Agent、连接、查询）；长任务上报进度、可取消。
- 避免在主进程做 CPU 密集任务（移入 Utility/worker）。

## 8. 安全红线（编码时）

- 渲染层零 Node 权限；preload 只暴露白名单 API（见[安全模型](../architecture/security.md)）。
- 工具/命令/SQL 的外部输入不拼接执行（参数化、转义、白名单）。
- 工具结果、文件内容、网页、MCP 返回当作**数据**，不当作可信指令自动执行危险动作。
- 密钥经系统凭据库；不写入明文配置/日志/版本库。

## 9. 注释与文档

- 注释解释**为什么**，而非复述**做什么**；匹配周边代码的注释密度。
- 对外 API、复杂算法、非显然的权衡加简要 TSDoc。
- 影响架构/接口的改动：**先改文档再改代码**（Docs-first），文档随 PR 更新。

## 10. 格式化与 Lint

- **Prettier** 统一格式（宽度、引号、分号由配置决定，提交前自动化）。
- **ESLint**：TypeScript 规则 + import 顺序 + React Hooks 规则 + 依赖边界规则。
- 提交前 `lint-staged` 跑格式化与 lint；CI 二次校验。

## 11. Git 与提交

- 分支：`main` 为主干；功能用 `feat/<topic>`、修复 `fix/<topic>`。
- **提交信息**：Conventional Commits，`type(scope): summary`。
  - type：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `build` / `perf`。
  - scope：包或功能名（如 `agent-core`、`git`、`ui`）。
- PR 需通过 CI（lint + typecheck + test + 依赖检查）方可合并。
- 破坏性变更在提交/PR 中标注 `BREAKING CHANGE:`。

## 12. 测试要求

- 核心域（权限、Provider 归一化、上下文装配、工具）需单元测试。
- 关键用户流有 E2E 覆盖。
- 详见[测试策略](./testing.md)。

## 13. 待决事项

- Prettier 具体风格参数（宽度/引号）在 M0 定稿并写入配置。
- 样式方案确定后补充 CSS/Tailwind 规范细则。
- 是否引入 changesets 管理包版本与变更日志。
