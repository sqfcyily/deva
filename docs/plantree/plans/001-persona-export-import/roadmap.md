# Roadmap · P001

## Done

- 全角落排查（2026-11-19）→ [topics/persona-surface.md](topics/persona-surface.md)
- 六问批复落决策（2026-11-19）→ [decisions/001-bundle-basics.md](decisions/001-bundle-basics.md)、[decisions/002-bundle-scope.md](decisions/002-bundle-scope.md)
- v2 能力包设计定稿（2026-11-19）→ [topics/export-import-design.md](topics/export-import-design.md)
- 实现 + 提交（2026-11-19）：feat c42f180（persona-port.ts 新模块、personas.ts 助手/簿记/级联、atomic-write 二进制重载、IPC+preload 桥、Rail/AddMenu 入口、i18n）；docs 55b57c7（本方案树）
- 验证（2026-11-19）：typecheck 双侧 + build 通过；electron 桩冒烟 6 案全绿（导出含内置拒绝 / 回环+同包更新 / 冲突铸新 id / originalId=general 硬闸+坏 manifest / **删除级联：簿记+头像+知识库随删，再导入为全新** / **缺秘密导出：包成功+警告列出字段**）；隔离 user-data-dir+DEVA_HOME 真机启动，CDP 验证桥函数在位、种子正常（原生对话框路径无法脚本化，留手工）
- 冒烟揪出的缺口已修（2026-11-19）：删除级联漏清知识库目录（档 0 遗留行为，随本功能收编）→ fix a65e049；llmdoc 级联描述同步 → docs 3a073e3
- 真实数据 dry-run（2026-11-19，用户在跑的 Deva 的「办公室运维助手」persona-3585c7d1，~/.deva 纯读 + zip 落 /tmp）：回环与更新路径**字节级一致**（13928B）；揪出第二个缺口——导入经 frontmatter 重组会**静默丢非标准键**（knowledge/x-custom 实测丢失）→ fix c8020b7（writePersonaMdRaw 原样写字节 + lstat 跳符号链接防环/防越界，符号链接专项测试通过）；llmdoc 同步 → f228b7c
- 真实数据 dry-run 之二（2026-11-19，「T3Code 配置专家」t3code-7fdbb385，带知识库：平铺 6 md / 83KB）：包含全部 6 个知识文件；导入临时家后知识树 sha256 逐一匹配、零缺失零多余；md 字节一致；**未发现新缺口**。迁移语义备注：该角色 prompt 正文硬编码知识库绝对路径 `/Users/jambo/.deva/...`——同账户默认 DEVA_HOME 下迁移后仍成立，跨用户名/自定义 DEVA_HOME 时路径失效（静默按无知识库处理，档 0 约定的固有局限，issue#65 字段化是正解，已记 open questions 留观项 2）
- llmdoc 同步（2026-11-19）：capabilities/skills-personas.mdx 补角色包契约，baseline 已前进到 bdcd580

## In Progress

（无）

## Next

- 用户 GUI 手工过一遍原生对话框路径：真机导出 → 换 DEVA_HOME 导入 → 手机端可见
- 是否推送上游（feature 分支 PR）由用户定

## Deferred

- 批量导出（整份花名册）
- 「从属角色」若被纠正为递归子角色 → 重议（decisions/002 留有作废条款）
- issue#65 knowledge 字段落地后的包格式联动（open-questions 留观项 2）
- PR#49 工作区落地后的包内记录评估（留观项 3）
