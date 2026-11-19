# Roadmap · P001

## Done

- 全角落排查（2026-11-19）→ [topics/persona-surface.md](topics/persona-surface.md)
- 六问批复落决策（2026-11-19）→ [decisions/001-bundle-basics.md](decisions/001-bundle-basics.md)、[decisions/002-bundle-scope.md](decisions/002-bundle-scope.md)
- v2 能力包设计定稿（2026-11-19）→ [topics/export-import-design.md](topics/export-import-design.md)
- 实现（2026-11-19，local-dev 未提交）：persona-port.ts 新模块；personas.ts 导出 dir 助手/imports 簿记/删除级联；atomic-write 扩二进制重载；index.ts 注册；preload 桥；Rail 导出菜单 + AddMenu 导入项 + ChatFirstShell 接线 + i18n 中英文案
- 验证（2026-11-19）：`pnpm typecheck` 双侧通过；`pnpm build` 通过；electron 桩进程内冒烟 4 案全绿（导出含内置拒绝 / 全新机回环+同包更新 / 冲突铸新 id 不动外来者 / originalId=general 硬闸 + 坏 manifest 拒绝）——harness 在 /tmp/pp-smoke/（会话外即逝，复制回仓库再跑可复现）

## In Progress

（无）

## Next

- 用户 GUI 手工过一遍：真机导出 → 换 DEVA_HOME 导入 → 手机端可见
- `/llmdoc:update`：capabilities/skills-personas.mdx 补导出/导入契约（personas.ts 锚点已变脏）
- 提交（双语提交规范，type/refactor 之外应为 feat）；是否推送上游由用户定

## Deferred

- 批量导出（整份花名册）
- 「从属角色」若被纠正为递归子角色 → 重议（decisions/002 留有作废条款）
- issue#65 knowledge 字段落地后的包格式联动（open-questions 留观项 2）
- PR#49 工作区落地后的包内记录评估（留观项 3）
