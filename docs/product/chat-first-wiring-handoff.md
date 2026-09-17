# 对话优先外壳接线 · 续作交接文档（Parts F/G/H 待做）

> 用途：本对话过长频繁触发压缩，故把「计划 + 当前进度 + 续作所需全部签名/类型/坑」落成本文件。
> **下个对话从这里开始即可，无需再翻代码做发现性阅读。**
> 生成时间：2026-09-17 ｜ 分支：`feature/personality` ｜ 主工作目录：`D:\project\sqf\space1\deva`
> 原始计划：`C:\Users\Administrator\.claude\plans\ethereal-dreaming-lollipop.md`

---

## 0. 一句话目标

把新外壳原型 `redesign/ChatFirstShell.tsx`（`App.tsx` 里 `PREVIEW_CHAT_FIRST=true` 开关，当前**全用 `./mock` 假数据**）接上真实 store，一个里程碑做完：**一对话一身份（persona 单选、绑定后不可改）+ 工作区按对话可选挂载 + persona 完整身份（含编辑器）+ 设置弹层做成真的**。

**锁定产品决策（不可动摇）**：
1. **范围**：一次性全做（persona 绑定后端 + 全 UI 接线，同一里程碑）。
2. **Persona 首启**：只种 **1 个「通用」persona 兜底**（id `general`，`config.json` 里 `personas.seededGeneral` 守卫防复活）；其余用户在角色界面「添加角色」自建。
3. 一条对话绑**唯一** persona（单选、首发绑定后不可改）；一个 persona 可挂多条对话；工作区**可选、按对话**（默认无文件夹 = 全机通用助手；挂文件夹 = 聚焦范围）。

**两条铁律**：
- ① 旧 `AppShell`（`PREVIEW_CHAT_FIRST=false`）全程无回归——所有后端改动加字段、可选、向后兼容，`personaId` 缺省 = 旧行为逐字节不变。
- ② 安全不变式全程不动（见 §1）。`typecheck:web` / `typecheck:node` / `build` 三绿。

---

## 1. 安全不变式（MUST 逐字保持，改任何代码前先默念）

- **Tier-1 硬地板**（fs-guard `isSensitivePath`，realpath 解析，整棵子树）：`~/.ssh, ~/.aws, ~/.gnupg, ~/.deva`、`C:\Windows`/SystemRoot、`/etc /proc /sys /dev`——**永久拒读写、不弹窗**。`~/.deva` 对 agent 完全封死（personas/secrets/config 只由 MAIN 直接读）。
- **Tier-2 受保护段**（`.git`/`.claude`/`.vscode`）：写需**逐次授权、绝不记住**；读免授权。
- 写操作锚定受信根；`auto` **不是**写任意后门；根外写恒走**越界卡**。
- `run_command` 绕过路径级联，由 `isDangerousCommand`（硬拒）+ 前缀记忆 + PermMode（`evaluateExec`）约束。
- API 密钥恒 `safeStorage` 加密；渲染层只见布尔状态。权限刻意**不**存进项目 `.deva`。
- Persona 提示词注入框定为「用户自定义附加指令，在不违反安全与工具使用原则的前提下遵循」——persona **绝不能**关闭安全/工具规则。Persona 工具白名单只**收窄可见性**，每次调用仍过同一闸门——**零提权**。
- 挂载聚焦文件夹复用既有 `trustRoot`（走 `fs:open-folder`/`fs:open-path`），**非新信任机制**。`effectiveRoot` 只改「哪个根算受信/工作区内」；`isSensitivePath` 独立于根，故 `~/.deva` 等永不可写。

**R6（最关键的兼容保命点）**：旧壳无回归全靠 `personaId` 缺省 gate——后端所有新逻辑 `if (personaId)` 包裹，缺省走 `enabledPersonas()` 旧叠加分支。保住这一处。

---

## 2. 进度矩阵

| 部分 | 内容 | 状态 |
|---|---|---|
| **A** | 后端 `personas.ts`：`PersonaRecord`/`PersonaUpsertInput` 扩 `emoji/color/tagline/model/tools`；parse/compose/upsert 透传；`ensureSeededPersonas` + `seededGeneral` 守卫 | ✅ 完成 |
| **B** | 后端 `chat-store.ts`：`StoredSession`/`ChatSessionMeta` 加 `personaId?`/`focusRoot?`；`listSessions` map 带出；`ensureSession` 首发绑定不覆盖 | ✅ 完成 |
| **C** | 后端 `chat.ts`：`runTurn` 单身份注入 + `effectiveRoot = focusRoot ?? workspaceRoot`；模型/工具/聚焦/权限键穿透 | ✅ 完成 |
| **D** | preload：`ChatSendRequest`/`ChatSessionMeta`/`PersonaRecord`/`PersonaUpsertInput` 补字段 | ✅ 完成 |
| **E** | 渲染 store：`extensions.tsx`（persona 双向转换器 + `addPersona` 默认 + `upsertPersona`）、`chat.tsx`（`SessionMeta` 字段 + `startFresh`/`send`/`mountFocus`/`newSession`/`currentBinding` 覆盖层）、`mock/extensions.ts`（真 `Persona` 类型） | ✅ 完成 |
| **I** | `main/index.ts`：`ensureSeededPersonas()` + `registerPersonasIpc()` 已挂 | ✅ 完成 |
| **F** | **新壳 UI 接线** `ChatFirstShell.tsx`：换真 hooks、驱动 store 会话、Rail/Conversation/ProfileView 接线、工作区 chip、自动绑定通用、窗口控制 | ⏳ **待做** |
| **G** | **Persona 编辑器**（模态）：从角色 tab「添加角色」+ ProfileView 编辑入口；8 字段；`upsertPersona` 保存；**需新增 CSS** | ⏳ **待做** |
| **H** | **设置弹层做成真的**：通用/模型（内嵌 `<ModelSettings/>`）/扩展/关于四窗；**需加 i18n `cf` 命名空间** | ⏳ **待做** |
| 收尾 | redesign.css 加编辑器表单类 + `.cf-modal.is-wide` + composer 附件行；i18n `cf` 命名空间（zh+en）；三绿；旧壳回归 | ⏳ 待做 |

**当前工作树**：Parts A/B/C/D/E/I 的改动都在暂存/未提交状态（`git status` 见 M 标记），`redesign/` 为未跟踪新目录。**未跑过 typecheck/build**（本轮全是只读验证）。Part F/G/H 一行代码未写。

---

## 3. Part F — 重写 `ChatFirstShell.tsx`（688 行，主目标）

**文件**：`apps/desktop/src/renderer/src/redesign/ChatFirstShell.tsx`

### 3.1 换 import
删 `./mock` 的数据导入，改：
```ts
import type { Persona } from '../mock/extensions'   // 真 Persona 类型（见 §6.1）
import { useChat } from '../store/chat'
import { useExtensions } from '../store/extensions'
import { useModels } from '../store/models'          // Part G 模型下拉、Part H 模型页
import { useWorkspace } from '../store/workspace'    // Part H recentLimit、桶根
import { useI18n } from '../i18n/I18nProvider'       // 确认实际路径（t 只收 key）
import { useTheme } from '../store/theme'            // Part H 主题；确认实际路径
import { BlockView, StatusIndicator, deriveActivity } from '../features/chat/ChatView'
```
> provider 树已在 `main.tsx` 包好（ThemeProvider > I18nProvider > DialogProvider > ModelsProvider > ExtensionsProvider > WorkspaceProvider > GitProvider > ChatProvider > UIProvider > App），**零重连**，所有 hook 在 ChatFirstShell 内直接可用。
> `main.tsx` 已全局 import `styles/tokens.css` + `styles/app.css`，故 `.msg*`/`.bubble--user`/`.attach-chip`/`.permission`/`.ask`/`.subagent` 等块类在新壳内可直接渲染。

### 3.2 会话状态驱动（关键改动）
**丢弃 mock 的本地 `activeId` useState**，改由 store 驱动：
- `const { sessions, currentSessionId, messages, streaming, streamStatus, sessionStates, send, stop, newSession, selectSession, deleteSession, currentBinding, mountFocus, respondPermission, respondAsk, permMode, setPermMode } = useChat()`
- 当前激活对话 = `currentSessionId`；切换 = `selectSession(id)`。

### 3.3 Rail 消息 tab
- 数据：`sessions`（单桶全量）按 `updatedAt` **降序**。
- 每行 persona 解析：`personas.find(p => p.id === session.personaId)`（`personas` 来自 `useExtensions()`）。
- 徽标：`sessionStates` → `{streaming, attention}`（`SessionLiveState`）。
- **相对时间自己在 JS 组**（`t` 只收 key，不插值）：写一个 `relTime(ts:number, t)` helper，用 `chat.time.{now,min,hr,yesterday,day}` 或 `cf` 里的键拼。
- 渲染沿用原 `ThreadRow` 标记：`cf-thread` / `cf-thread__title` / `__time` / `__snippet` / `__owner` / `__proj` / 未读 `cf-thread__dot`；`Avatar 38`。

### 3.4 Rail 角色 tab
- 数据：`useExtensions().personas` → `PersonaRow`（`cf-prow`，用 `persona.desc`〔=专长〕+ `persona.model`；`cf-prow__name` 带 `--p`=color）。
- 底部「添加角色」按钮 → 开编辑器（Part G，create 模式）。

### 3.5 Conversation
- `messages` 来自 `useChat()`；**复用** `ChatView` 导出的 `BlockView` / `StatusIndicator` / `deriveActivity`，套进 `cf-msg` IM 外壳（**不要**重写安全相关渲染器）。
- 每条消息 `active={streaming && i === messages.length - 1}`（与 ChatView 一致）；agent 消息 `<BlockView key={i} block={b} thinkingDone={!(active && i===msg.blocks.length-1)} onPermission={respondPermission-adapter} onAsk={respondAsk-adapter}/>`。
- 流式时渲染 `<StatusIndicator activity={deriveActivity(messages)} status={streamStatus} onStop={stop}/>`。
- **用户附件 chip**：`iconFor` 在 ChatView 内**未导出** → 自己内联一个 icon helper（lucide `ImageIcon/FileText/FileCode2/Paperclip` 按 `AttachKind`），或直接用 emoji。
- `Composer`：textarea placeholder `跟 ${owner?.name ?? '助手'} 说点什么…`；发送调 `send(text, attachments?)`；📎 调 `window.deva.fs.pickAttachments()` → 得 `PickedAttachment[]`（`{path,name,kind}`）组 `SendAttachment[]`。

### 3.6 发起对话
- `PersonaRow`「发消息」或资料卡「开始对话」→ `newSession(personaId)`（= `startFresh(personaId, focusRoot?)`）→ 进空对话，首发落绑定。

### 3.7 工作区 chip（cf-wschip）
- 显示：`currentBinding.focusRoot` 有值 → basename + `· 聚焦中`；null → `全机通用助手`。
- 点击挂载：`const r = await window.deva.fs.openFolder(); if (r) mountFocus(r.path)`（`openFolder` 已 `trustRoot`）。
- 卸载：`mountFocus(null)`。
- **不要**用 `useWorkspace().openFolder`（那会翻 `activeProject`/桶）。

### 3.8 ProfileView
- 字段来自 persona；「与TA的对话」= `sessions.filter(s => s.personaId === id)`。
- 「编辑」入口 → 开编辑器（Part G，edit 模式，带 id）。

### 3.9 自动绑定「通用」
- `defaultPersona = personas.find(p => p.id === 'general') ?? personas[0]`。
- effect：`当 defaultPersona 存在 && !currentBinding.personaId && messages.length === 0 → newSession(defaultPersona.id)`。**循环安全**（一旦 `currentBinding.personaId` 置位，guard 阻止再触发）。

### 3.10 窗口控制
- min `window.deva.window.minimize()` / max `window.deva.window.toggleMaximize()` / close `window.deva.window.close()`。

---

## 4. Part G — Persona 编辑器（模态）

从角色 tab「添加角色」（create）+ ProfileView「编辑」（edit）打开。复用 `useExtensions().addPersona/update/remove/upsertPersona` + `PersonaUpsertInput`。

**字段**（8）：
| UI 名 | 字段 | 控件 |
|---|---|---|
| 名称 | `name` | 文本 |
| Emoji | `emoji` | 短文本（v1 纯输入框，不做 picker） |
| 主题色 | `color` | `<input type="color">`（`.cf-color`） |
| 专长 | `description`（映射！UI 叫 specialty） | 单行 |
| 开场白 | `tagline` | 单行 |
| 偏好模型 | `model` | 下拉，选项 = `useModels().providers[].models[]` 拼 `"providerId:modelId"`；空 = 跟随默认 |
| 可用工具 | `tools` | 多选内置（见下）；空选 = 全内置（附说明文字） |
| 系统提示词 | `prompt` | textarea |

**工具白名单可选项（R4，务必排除 3 个）**：
`read_file / list_dir / glob / grep / web_fetch / write_file / edit_file / run_command`
**排除**：`ask_user / create_skill / run_subagent`（与 `buildSubagentTools` 实际可授集一致）。
i18n 标签复用 `chat.tool.{readFile,listDir,glob,grep,webFetch,writeFile,editFile,runCommand}`。

**保存**：组 `PersonaUpsertInput`（create 省 `id`，edit 带 `id`），调 `upsertPersona`（round-trip 到 `personas:upsert`→`composePersonaMd`），`enabled` 默认 true。

**需新增 CSS**（redesign.css 当前无表单类）：`.cf-field` / `.cf-input` / `.cf-textarea` / `.cf-select` / `.cf-color` / `.cf-toolgrid` / `.cf-toolchip` / `.cf-editor__actions` / `.cf-btn`（全部 token 化，theme-aware）。

---

## 5. Part H — 设置弹层做成真的

ChatFirstShell 的 Settings 模态（`SETTINGS_NAV` = general/models/extensions/about），复用既有组件：
- **通用**：`useI18n().locale/setLocale` + `useWorkspace().recentLimit/setRecentLimit`（内联 clamp 1–50，`DEFAULT_RECENT_LIMIT=10` 模块私有不可导） + `useTheme().mode/setMode`（light/dark/system）。
- **模型**：整块内嵌 `<ModelSettings />`（`features/settings/ModelSettings.tsx`，`export function ModelSettings(): React.JSX.Element`，**零 prop、自包含**）。两列布局在 720px 模态可能挤，考虑 `.cf-modal.is-wide`。
- **扩展**：`useExtensions()` 的 skills/mcp/subagents/personas 列表 + `toggle`。
- **关于**：AboutPane，用 `app.name` / `settings.version` / `app.tagline`。

---

## 6. 续作所需精确签名/类型（照抄，无需再读）

### 6.1 真 `Persona`（`mock/extensions.ts` L98）— **import 这个**
```ts
interface Persona {
  id: string; name: string; desc: string;   // desc = 专长/specialty
  emoji: string; color: string; tagline: string;
  model: string;      // "providerId:modelId"，空=默认
  tools: string[];    // 空=全内置（只收窄可见性）
  prompt: string;
  scope: ExtScope; source: ExtSource; enabled: boolean;
}
```
> ⚠️ 别用 `./mock`（旧壳内） 的错误 `.specialty` 类型；一定 import `../mock/extensions` 的这个。
> 字段映射：渲染 `Persona.desc` ↔ 主进程 `PersonaRecord.description` = plan/UI 的「专长」。

### 6.2 `useChat()` 返回值（`store/chat.tsx` ChatContextValue L194-220）
```
sessions, currentSessionId, messages, streaming, streamStatus, sessionStates,
send(text, attachments?), stop(),
newSession(personaId?, focusRoot?), selectSession(id), deleteSession(id),
currentBinding: { personaId?; focusRoot: string|null },
mountFocus(path: string|null),
respondPermission(key, decision, remember), respondAsk(key, answer),
permMode, setPermMode(mode)
```
相关类型：
- `ChatMessage { id, role:'user'|'assistant', blocks:ChatBlock[], attachments?:{name,kind:AttachKind}[] }`
- `SessionMeta { id, title, createdAt:number, updatedAt:number, personaId?:string, focusRoot?:string|null }`
- `SendAttachment { path, name, kind:AttachKind }`
- `StreamStatus { elapsedSec, reconnecting }`
- `SessionLiveState { streaming, attention }`

### 6.3 `useExtensions()`（`store/extensions.tsx`）
返回含：`skills / mcp / subagents / personas / selected / select / toggle / remove / update / add / upsertPersona / addPersona / importSkill / mcpConnect / ...`
- `personaRecToPersona(rec)`（desc=rec.description + emoji/color/tagline/model/tools/prompt）
- `personaToInput(p)`
- `addPersona()` 默认 emoji `'🤖'`/color `'#7c7cf0'`/tagline `''`/model `''`/tools `[]`/prompt `''`/enabled true
- `upsertPersona(input)` → `window.deva.personas.upsert`，按 id 更新本地列表
- personas 挂载时从 `window.deva.personas.list()` 载入

### 6.4 ChatView 导出（`features/chat/ChatView.tsx`）
- `type Activity`（L107）；`deriveActivity(messages: ChatMessage[]): Activity`（L119）
- `StatusIndicator({ activity, status, onStop })`（L488）
- `BlockView({ block, thinkingDone, onPermission, onAsk })`（L644）
- `iconFor(kind)`（L68）**内部、未导出** → 自己内联。

### 6.5 preload `window.deva`（`preload/index.ts`）
- `window.minimize()` / `toggleMaximize()` / `close()`（L416-419）
- `fs.openFolder(): Promise<OpenFolderResult|null>`（`{path,name}`，L426）；`fs.openPath(path)`（L428）；`fs.pickAttachments(): Promise<PickedAttachment[]>`（L435）
- `personas.list()/get()/upsert(input)/remove(id)/setEnabled(id,enabled)`（L466-473）
- `chat.send(req)`（L528）；`chat.listSessions(root)`（L537）

### 6.6 `ModelSettings`（`features/settings/ModelSettings.tsx`）
`export function ModelSettings(): React.JSX.Element`（L31，named export，无 prop，自包含）。两列 providers/config 布局。

### 6.7 `useWorkspace()`（`store/workspace.tsx`）
`recentLimit:number`（L76）/ `setRecentLimit(n)`（L79）/ `activeProject:Project|null`（L70）。`DEFAULT_RECENT_LIMIT=10` 模块私有。设置输入用内联 clamp 1–50。

### 6.8 i18n（`i18n/messages.ts`，727 行）
`t(key)` **只收 key、不插值**——动态串（计数/名字/相对时间）在 JS 组。
- `chat.tool.*`（L226-237）；`chat.time.*`（L223：now/min/hr/yesterday/day）
- `settings.*`（zh L285-300 / en L642-657）；`common.*`（zh L358-366 / en L715-723）
- **需在 zhCN 与 en 两份都新增 `cf` 命名空间**（草拟键见 §7）。

---

## 7. 待加 i18n `cf` 命名空间（zh + en 两份）

草拟键（按用途）：
```
brandTag, newChat, search, tabChats, tabRoster, settings, localUser, viewProfile,
mountHint, unmountHint, focusing, mountWorkspace, fullMachine,
composerPlaceholder, send, attach, sendHint,
noPersona, addPersona, prefModel, authTools, allTools, defaultModel, startChat,
editPersona, convsWith, noConvs,
editorNewTitle, editorEditTitle,
fName, fEmoji, fColor, fSpecialty, fTagline, fModel, fTools, fToolsHint, fPrompt,
save, cancel,
extEmpty, kindSkill, kindMcp, kindSubagent, builtin, mcpConnected, mcpDisconnected
```

---

## 8. 待加 CSS（`redesign/redesign.css`，1096 行，全 token 化）

现有 `cf-*` 类齐全（`.cf-msg` grid 32px/1fr；`.cf-msg.is-user` grid 1fr/32px；`.cf-modal` max-width 720px，`.cf-modal__body` grid 168px/1fr）。**缺**表单/编辑器类，需加：
- 编辑器表单：`.cf-field` / `.cf-input` / `.cf-textarea` / `.cf-select` / `.cf-color` / `.cf-toolgrid` / `.cf-toolchip` / `.cf-editor__actions` / `.cf-btn`
- 模型页宽版：`.cf-modal.is-wide`
- Composer 附件行（如需）

---

## 9. 关键坑（R1-R6）与已确认事实

- **R1**：权限模式键须用 `effectiveRoot` 穿透，否则同桶通用对话间**串模式**。（后端 Part C 已做，验证时确认。）
- **R2**：`listSessions` map 必须带出 `personaId`/`focusRoot`，否则重开丢头像/聚焦 chip。（Part B 已做。）
- **R3**：`setConfig` 顶层浅合并，种子须**读出既有 `personas` 子对象再合并**保 `enabled`。（Part I 已做。）
- **R4**：工具白名单排除 `ask_user/create_skill/run_subagent`。（Part G 落实。）
- **R5**：颜色 `#` 值经 `fmScalar` 引号化，否则 YAML 当注释吃掉。（Part A 已做。）
- **R6**：旧壳无回归全靠 `personaId` 缺省 gate。
- 已确认：`styles/app.css` 全局 import → 复用块类在新壳可渲染；`iconFor` 未导出须内联；store 拥有 `currentSessionId/selectSession/newSession` → 新壳丢本地 `activeId`；自动绑通用循环安全；相对时间须 JS 组；`ModelSettings` 零 prop 可直接内嵌；聚焦挂载走 `window.deva.fs.openFolder()`+`mountFocus`（非 `useWorkspace().openFolder`）。

---

## 10. 验证（收尾必跑，全在 `apps/desktop/` 下）

1. `pnpm typecheck:web` 绿（renderer+preload 共享类型对齐）
2. `pnpm typecheck:node` 绿（主进程穿透）
3. `pnpm build`（electron-vite）绿
4. 手动点通：
   - 首启角色 tab 恰 1 个「通用」；删它重启 → **不复活**。
   - 添加角色填全字段（含模型+工具白名单）→ 存 → 花名册出现；重开编辑器值持久化。
   - 与某 persona 发起对话 → 发送 → 重开 app → 对话显正确头像（证 `listSessions` 带出 `personaId`）。
   - 头部 chip 挂文件夹 → 显目录名；夹内写文件放行；写 `~/.deva` 硬拒（Tier-1 完好）；卸载 → 显「全机通用助手」。
   - 两条未挂载对话：一条 `auto`、一条 `ask` → 模式**不串**（证 effectiveRoot 键）。
   - 窄工具白名单（只读）persona → `write_file`/`run_command` 不出现/不执行；出现的调用仍过闸门。
   - `PREVIEW_CHAT_FIRST=false` → 旧 AppShell 全功能无回归。

---

## 11. 推迟（本次不做）

persona @handle 搜索补全；多身份群聊（产品锁死单身份）；每对话模型覆盖 UI；emoji picker 打磨（v1 纯文本框）；旧壳历史会话回填 persona。

---

## 12. 完成后

更新记忆 `deva-chat-first-redesign.md`（标注 Parts F/G/H 完成、三绿、旧壳无回归）。
