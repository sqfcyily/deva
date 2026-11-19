# Topic · 角色全角落清单（研究底稿）

证据日期 2026-11-19，分支 local-dev @ d69b2a2。逐文件核实，非推测。

## 1. 存储面（main-personas / personas.ts，515 行）

| 内容 | 位置 | 导出/导入相关性 |
|---|---|---|
| 角色工件 | `~/.deva/personas/<id>.md`（`personasDir()`，模块私有） | **包主体**：frontmatter（name/description/avatar/model）+ 正文 prompt |
| 自定义头像图 | `~/.deva/personas/avatars/<id>.{webp,png,jpg}`（`avatarsDir()`，私有；ext 白名单 `AVATAR_EXT_MIME`） | **包内第二个文件**；不入 frontmatter（真源是磁盘存在性），一 id 至多一张，写入先清全部变体 |
| 启用态 | `config.json → personas.enabled[id]`，默认关 | **不导出**（机器本地偏好）；导入后默认关 |
| 手动排序 | `config.json → personas.order[]` | 不导出 |
| 种子簿记 | `config.json → personas.seeded[id]` / `seededPrompt[id]`（+ 历史键 `seededGeneral`） | **绝不导出/导入**：内置种子协议专用 |
| 前缀头 avatar spec | frontmatter `avatar` = Humation AvatarSpec JSON 字符串（`fmScalar` 引号化落盘） | 随 md 原样迁移 |
| 偏好模型 | frontmatter `model` = `"providerId:modelId"`，空 = 跟随默认 | 原样迁移；导入机无此模型时 `resolveModelRef` 永不抛错、优雅回退，**无需校验** |

关键函数：`isSafeId`（`/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`）、`makeId`（slug≤40 + 8hex 随机后缀，**永不复用已删 id**——任务/对话/IM 范围按 id 引用）、`resolvePersonaId`（失效回落 `'general'`）、`upsertPersona`（显式传 id 会**覆盖**已存在文件——导入的覆盖风险点）、`parsePersona`/`composePersonaMd`、`deletePersona` 级联（文件+头像+任务重指+ext-roles prune+enabled+order）。

**内置角色无主进程防删/防覆盖硬闸**：删除禁止只活在 UI（Rail/BotsPane 对 `DEFAULT_PERSONA_ID='general'` 禁用菜单）；`upsertPersona({id:'general',…})` 会直接覆盖种子文件。`RESERVED_IDS` 只存在于 skills.ts。→ **导入必须自设内置 id 硬闸**（general/xiaomajiang）。

## 2. 种子协议（default-personas.ts）

`DEFAULT_PERSONAS = [DEVA(general), XIAOMAJIANG(xiaomajiang)]`；`LEGACY_PROMPT_HASHES`（v0.1.2–v0.1.9 历史哈希）。`ensureSeededPersonas` 按 `seeded[id]` 防复活、按 `seededPrompt[id]` 基线做「提示词跟随新版」。**内置角色是代码常量、不在导出范围内**（Q2）。

## 3. 头像落盘（main-avatar-image / avatar-image.ts）

`readAvatarImage/clearAvatarImage/writeAvatarImage(dir, id)`；MIME 白名单 webp/png/jpg、解码后 ≤2MB、data URI 进出（渲染层 CSP 禁 `file:`）。**与用户头像 `profile/avatar.<ext>` 共用模块但不同目录**——角色包只涉及 `personas/avatars/`，勿混入 profile。

## 4. IPC 面（preload-ipc）

`personas:list/get/upsert/remove/set-enabled/reorder/set-avatar-image/clear-avatar-image`（personas.ts `registerPersonasIpc`）。**无 personas:changed 广播**——渲染层自拉自刷；手机端经 `web/adapter.ts` 的 `conn.send({t:'personas', …})` 推送。新增导出/导入 IPC 照此模式，导入成功后渲染层重拉即可，手机端下次拉取/连接时自然可见。

## 5. 引用面（谁按 id 指着角色）

| 引用方 | 位置 | 迁移含义 |
|---|---|---|
| 对话绑定 | 会话属性 `personaId`（resolvePersonaId 读取时回退） | 机器本地，不迁移 |
| 定时任务 | `tasks-types.ts auth.personaId`；删角色时 `reassignTaskPersona(id→general)` | 不迁移 |
| IM 回复范围 | `remote/store.ts ReplyScope.personas[]`（mode='personas'） | 不迁移 |
| 手机视图 | `shared/remote-web.ts WebPersona`（id/name/description/model/avatar/avatarImage/enabled） | 导入后自动出现，无需改动 |
| 手机建角色 | `remote/hub.ts:1345`（名片 accept → `upsertPersona`，**enabled:true**，形状按名 seededShape 定死） | 证明：非桌面的 upsert 已有先例；导入流程可参照（upsert → 落图） |
| ext-roles | `config.json → skills.roles[id] / mcp.roles[id]`（缺席=全部角色；指定角色全删→回退全体并**停用**） | **不导出**（Q4）：导入机没有同 id 技能/MCP，带上只会制造悬挂引用 |
| 技能清单过滤 | chat.ts 按 `allowsPersona('skills'/'mcp', id, personaId)` 过滤 | 同上 |

## 6. UI 面（renderer-shell）

- `Rail.tsx`：花名册 tab + 角色右键菜单（置顶/删除，general 禁删）→ **导出菜单项的落点**
- `BotsPane.tsx`：花名册管理 + PersonaEditor（新建/编辑，头像 AvatarEditor）→ **导入入口候选**
- `SettingsPane.tsx`：技能导入所在（`skills:import` 先例：dialog 在主进程弹）
- 提示：菜单/编辑器文案在 `i18n/messages.ts`（中英双语都要加）

## 7. zip 导入先例（main-skills / skills.ts）

`skills:import`：`.md` 或 `.zip`；fflate `unzipSync`；zip-slip 段守卫；限额 20MB 总量/200 文件/单文件 10MB；dialog 在主进程；返回结构化结果给渲染层。→ 角色包导入**照抄这套骨架**，限额可更紧（角色包理论上限 ≈ md 文本 + 2MB 头像）。

## 8. 硬编码目录汇总（用户点名要盯的角落）

全部经 `getDevaHome()` 派生（DEVA_HOME 可覆盖，便携模式生效）——**包实现里禁止出现字面量 `~/.deva`**，一律复用 personas.ts 的 `personasDir()`/`avatarsDir()`（现为模块私有，需导出或把端口逻辑放进 personas.ts）：

1. `personasDir()` = `<DEVA_HOME>/personas`
2. `avatarsDir()` = `<DEVA_HOME>/personas/avatars`
3. 知识库目录（issue#65 档 0 约定，非代码实体）：`<DEVA_HOME>/personas/knowledge/<id>/`——子目录不干扰角色扫描（顶层扫描只认 `*.md`）；打包范围已含（decisions/002）
4. 头像扩展名变体：`<id>.webp|.png|.jpg`（同一 id 可能任一存在，读写都要遍历三分——avatar-image.ts 已封装）
5. config 键四件：`personas.enabled / order / seeded / seededPrompt`（导入只允许间接经 `setPersonaEnabled`；**不碰 seeded 族**）；导入新增簿记键 `personas.imports`
6. 易混淆的非角色目录：`profile/avatar.<ext>`（用户头像）、`data/media/`（附件 blob）——均不在角色包内；`skills/<id>/` 与 `mcp.json+secrets` 属**随包从属内容**（decisions/002）

## 9. PR#49（角色默认工作区）状态

提交 b96184c/c010fa1/81a0459 在 `origin/feature/workspace`，**不在 main**（`git merge-base --is-ancestor` 已验）。落地后角色会多一个按 id 存放的 home folder（机器本地用户数据）——包格式 v1 不预留字段，落地后经 update 评估（roadmap Deferred）。
