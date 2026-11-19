# P001 · 角色导出/导入

## 范围

把单条角色（persona）相关内容打包导出为可迁移文件，并在另一台机器/另一个 DEVA_HOME 导入。**桌面端功能**；手机端只经既有 `WebPersona` 视图看到导入结果，不做导入入口。

非目标（v1）：批量导出全部角色、角色「专属技能/MCP」连带打包（ext-roles 的 id 跨机不移植）、定时任务/对话绑定迁移、导入时更新已存在的角色。

## 受影响模块

main-personas（核心）、main-avatar-image、preload-ipc（新增 IPC）、renderer-shell（Rail 右键菜单 + BotsPane 入口）、main-skills（zip 导入先例参照）。详见 [topics/persona-surface.md](topics/persona-surface.md)。

## 文件地图

- [roadmap.md](roadmap.md) — 阶段状态
- [topics/persona-surface.md](topics/persona-surface.md) — 角色全角落清单（研究主体，含硬编码目录）
- [topics/export-import-design.md](topics/export-import-design.md) — 包格式与导入语义设计
- [open-questions.md](open-questions.md) — 待用户定夺的 6 个问题

## 状态

Ready（设计定稿 2026-11-19）。六问已批复成决策（decisions/001、002）；v2 能力包设计见 topics/export-import-design.md。实现待用户放行；「从属角色」按「从属内容」判读，若用户纠正则 decisions/002 作废重议。
