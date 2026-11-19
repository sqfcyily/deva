# Decision · 打包基础五项（Q1/Q2/Q3/Q5/Q6）

日期 2026-11-19。用户逐条批复，Q5 授权由我决策。

## D1 · id 策略（Q1）

**无冲突保留原 id，冲突时铸随机 id。**
- 导入时 `originalId` 通过 `isSafeId` 且本地不存在 `<originalId>.md` → 沿用原 id（两台机器导入后 id 一致，任务/IM 绑定语义在包消费者侧可控）。
- 本地已存在同 id 且**并非**同一包的再次导入 → `makeId` 铸新 id，绝不覆盖（代码既有铁律：id 复用会让任务/对话/IM 范围的旧引用悄悄指向新角色）。
- 「同一包的再次导入」判定走 D3 的来源簿记。

## D2 · 内置角色（Q2）

**内置 `general` / `xiaomajiang` 不允许导出；导入永不落在内置 id 上。** 主进程本无防覆盖硬闸（`upsertPersona` 显式传 id 会覆盖种子文件、`RESERVED_IDS` 只在 skills.ts），此闸由本功能显式实现。

## D3 · 重复导入 = 更新（Q3）

**同一包再次导入走就地更新，不产生重复角色。**
- 来源簿记：`config.json → personas.imports[localId] = { originalId, bundleHash }`（bundleHash = 包内容规范哈希；启用态/order 仍不入簿记）。
- 导入判定序：本地已有 `originalId` 且其 `imports[localId].originalId` 匹配 → **更新**（persona.md / 头像 / 随包内容覆盖为包内版本）；id 冲突但簿记不匹配（撞了别的角色）→ 铸随机 id 新建；id 空闲 → 沿用原 id 新建并记簿记。
- 更新语义：包是这一内容的真源，覆盖即更新；用户本地对随包技能/MCP 的后续改动会被包内版本覆盖（v1 接受，UI 提示「将更新已导入的角色」）。

## D4 · UI 入口（Q5，用户授权决策）

**导出 = Rail 花名册角色右键菜单「导出…」（与置顶/删除并列，内置角色该项灰显）；导入 = BotsPane 花名册管理区入口（与「新建角色」并列）。** i18n 中英文案同步。

## D5 · 来源信息（Q6）

**只写进包内 `manifest.json`**（originalId / exportedAt / appVersion / format），`persona.md` 保持现有工件格式字节同构，frontmatter 不加新键（防污染用户可直接编辑的工件；也为 PR#49 的 `workspace`、issue#65 的 `knowledge` 字段预留干净的 frontmatter 空间）。

## 关联

- 冲突判定与 D3 簿记互为前提，实现时同一模块（persona-port.ts）内聚。
- Q4（打包范围：技能/MCP/文档/知识库/从属角色）另行细化，见 open-questions。
