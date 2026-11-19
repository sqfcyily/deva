# Baseline

全局上下文的检索枢纽。**架构权威在 llmdoc/**，这里只放 Plan 元数据需要的模块键与指路。

## 模块键（Plan 的 Affected Modules 用）

| 键 | 内容 | llmdoc owner |
|---|---|---|
| main-personas | apps/desktop/src/main/services/personas.ts（存储/种子/删除级联） | capabilities/skills-personas.mdx |
| main-ext-roles | services/ext-roles.ts（技能/MCP 角色作用域） | capabilities/skills-personas.mdx |
| main-avatar-image | services/avatar-image.ts（头像落盘，角色与用户共用） | （可重建面） |
| main-skills | services/skills.ts（技能，zip 导入先例） | capabilities/skills-personas.mdx |
| main-tasks | services/tasks.ts / tasks-types.ts（定时任务绑定 personaId） | capabilities/scheduler.mdx |
| main-remote-hub | services/remote/hub.ts（手机名片建角色） | remote/remote.mdx |
| main-config | services/config.ts（config.json 各 personas.* 键） | security/security.mdx（secrets 部分） |
| preload-ipc | src/preload/index.ts（personas:* 桥） | protocol-ui/protocol.mdx |
| renderer-shell | redesign/Rail.tsx / BotsPane.tsx 等（花名册 UI） | protocol-ui/protocol.mdx |
| shared-protocol | shared/remote-web.ts（WebPersona 手机视图） | remote/remote.mdx |
| mobile-web | src/mobile/（手机端角色列表/抽屉） | remote/remote.mdx |

## 检索

- 冷启动：`npx -y @tokenroll/llmdoc tree`
- 概念：`npx -y @tokenroll/llmdoc search "<词>"`
- 文件→文档：`npx -y @tokenroll/llmdoc context --files <path>`

## 已知进行中分支（不在 main）

- `origin/feature/workspace`：角色默认工作区（PR#49，按 id 存放 home folder + mount_workspace 工具）。**main 尚无此面**；涉及角色的方案要预留其落地的兼容位。
