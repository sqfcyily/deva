# Deva 续作计划清单（下次会话从这里开始）

> 生成于 2026-09-08 · 维护人：AI 助手协作 · 这份文件是「明天/下次会话」的接续入口。
> 读完本文件 + 记忆索引（`~/.claude/.../memory/MEMORY.md` 自动加载）即可无缝继续，无需回放整段历史对话。

---

## 0. 如何恢复工作（给未来的会话 / 给用户）

**用户操作**：在 `apps/desktop` 目录启动 Claude Code，任选其一：
- `claude --continue`：直接接续最近一次会话（历史会被压缩摘要，非逐字）。
- 开全新会话，然后说一句：「读 `docs/next-session.md`，从 Phase 3 继续」。

**事实确认（关于"关闭后对话是否丢失"）**：不丢。会话实时落盘在
`C:\Users\Administrator\.claude\projects\D--project-sqf-space1-deva\<session-id>.jsonl`，
可用 `--continue` / `--resume` 恢复。只是超长历史在恢复时会被摘要压缩，所以本计划文件 + 持久记忆才是最稳的接续依据。

**给未来会话的开场自检**：
1. 读本文件「已完成」节（含 Phase 2 落地清单）与「Phase 3 终端」拆解。
2. Phase 3 设计依据：`docs/modules/agent-engine.md`（终端如何作为工具接回 agent）+ node-pty 打包/预编译要求（对齐「双击即启动、零配置」铁律）。
3. 按「验证流程」跑一遍 typecheck/build 确认当前基线是干净的，再动手。

---

## 1. 项目一句话 + 铁律

- **是什么**：Deva —— 面向开发者的桌面 Agent 应用（类 Codex + IntelliJ IDEA，具备类 Claude Code 能力：读写文件、权限管控、Skill、MCP、子 Agent、工作区、Git、MySQL/Redis、终端、远程 SSH）。技术栈 Electron + React 18 + TypeScript + Vite（electron-vite）；pnpm 10 monorepo，代码在 `apps/desktop`。
- **铁律（永远生效）**：最终产物必须**安装后双击即启动，终端用户零环境配置**。→ 优先纯 JS 库；原生模块必须打包 + 预编译（node-pty 等），绝不让终端用户装任何东西。
- **安全基线（永远生效）**：`contextIsolation:true / nodeIntegration:false / sandbox:true / webSecurity:true`；preload 只经 `contextBridge` 暴露白名单 `deva.*`，绝不暴露裸 `ipcRenderer` 或 Node 模块；所有文件读写在主进程校验受信根（防路径穿越）；API 密钥用主进程 `safeStorage` 加密存盘，绝不进渲染层/明文。
- **配置存储约定（永远生效）**：用户配置根目录 `~/.deva`（`DEVA_HOME` 可覆盖）。非敏感项 → `~/.deva/config.json` 明文可手改；敏感项（API Key）→ `~/.deva/secrets.json` **始终 safeStorage 加密**。**点目录不等于明文**——密钥无论存哪都保持加密。

---

## 2. 已完成 ✅

- **Phase 0 外观**：整套 UI（顶栏/活动栏/侧栏/编辑器/对话/设置/模型/DB/SSH/扩展）+ 主题（跟随系统/明/暗）+ i18n（zh-CN/en 双份同步）。用户已确认外观 OK。
- **Phase 1 真实工作区（fs）**：打开文件夹 / 文件树（懒加载）/ 编辑器读+存（Ctrl+S）。已落地：
  - `src/main/services/workspace.ts`：`registerWorkspaceIpc`，通道 `fs:open-folder|read-dir|read-file|write-file`；受信根 `roots` + `isInsideRoot` 校验；2MB 上限 + 二进制探测。
  - `src/preload/index.ts`：`deva.fs`（openFolder/readDir/readFile/writeFile），类型经 `DevaApi` 到渲染层。
  - `src/renderer/src/store/workspace.tsx`：`WorkspaceProvider`（projects/tabs/tree/文件脏态/保存）。
  - Explorer / Editor / TitleBar / StatusBar 均已接真实数据。
- **对话页 UI 改版（DeepSeek 风格）**：无头像、无"Deva"名；用户消息靠右带底色气泡（token `--chat-user-bubble`），助手消息靠左通栏无气泡；工具卡片/diff/权限卡片保留。用户已确认 UI 无问题。**注意：ChatView 目前仍是 mock 静态内容，Phase 2 要用真实 chat store 替换。**
- **dev 模式报错修复**：`ERR_CONNECTION_REFUSED` 根因是 Vite dev server 绑到了 IPv6 `[::1]`、而 Electron 走 IPv4 `127.0.0.1`。已在 `electron.vite.config.ts` 的 `renderer.server` 固定 `host:'127.0.0.1', port:5173, strictPort:true`。缓存 `access denied (0x5)` 是我遗留的后台 preview 实例抢 userData 锁，已清干净。已验证一轮干净 `pnpm dev`：URL 变 `http://127.0.0.1:5173/`，两种 host 都 HTTP 200，无 ERR_CONNECTION、无缓存报错。
- **Phase 1.5 内部功能贡献注册表（内部可插拔接缝）**：新建 `src/renderer/src/features/registry.ts`，每个左侧功能在此登记一条 `FeatureContribution`（`id/icon/titleKey/order/placement/scope/Sidebar?/Center`）。`ActivityBar`（顶/底部条目）、`SidePanel`（`getContribution(id).Sidebar`，无则折叠）、`AppShell.CenterView`（`getContribution(id).Center`，未知回退默认贡献）三处硬编码 `switch` 全部改为从注册表渲染；`store/ui.tsx` 的 `ActivityView` 由联合类型改为 `string`（id 归注册表管，避免导入环——ui.tsx 不 import registry）。**新增/删除一个左侧功能 = 加/删一条目 + 一行 import**。行为与改前 1:1 等价（typecheck+build+干净 dev 均通过）。为将来第三方插件系统预留了「贡献点」形状，但当前仅是内部机制、非公开插件 API。
- **Phase 2 AI Agent 对话循环（代码级完成，已验证 typecheck/build/干净 boot；功能级待真机密钥回归）**：对话页由 mock 变为真实 Agent 管线，五步 A–E 全部落地：
  - **A 密钥安全存储**：`src/main/services/secrets.ts`（`safeStorage` 加密存 `userData/secrets.json`，通道 `secrets:set|has|delete|list|available`）；`getSecret` 仅主进程内部可调、明文永不出主进程、无 `secrets:get`。渲染层模型设置页 `ModelSettings.tsx` 改为 `hasKey` 掩码态 + Save/Clear，不回显明文；`isEncryptionAvailable()=false` 时禁用输入并告警。
  - **B Provider 适配层**：`src/main/providers/{types,sse,anthropic,openai,index}.ts`。归一化 `StreamEvent`（`text_delta|thinking_delta|tool_call|usage|error|done`）；`anthropic.ts`（Messages API，`x-api-key`+`anthropic-version`，SSE content_block 增量拼 tool_use）；`openai.ts`（Chat Completions，兼容 DeepSeek/Kimi/智谱/Qwen/Ollama，`tool_calls` 按 index 增量拼接，`reasoning_content`→thinking）；`index.ts` 的 `streamChat` 按 `adapter` 分发、从 secrets 取解密 key（keyless 如 Ollama 传空）。**不引厂商 SDK**，全用 Node 原生 `fetch`+Web Streams 手写 SSE。
  - **C 会话/Agent 循环 + 流式 IPC**：`src/main/services/chat.ts`（`registerChatIpc`）。`runTurn` 循环：`streamChat`→累积文本+工具调用→推 assistant Message→逐个 toolCall 过权限闸门→执行→回填 tool_result→继续，直到无工具调用/错误/触顶（`MAX_STEPS=25`）。通道 `chat:send`（返回 turnId）/`chat:abort`（每 turn 一个 `AbortController`）/`chat:reset`/`chat:permission-response`；事件经 `chat:event` 推回。工具在 `src/main/services/tools.ts`：`read_file`/`list_dir`/`write_file`（受信根校验、2MB/二进制护栏；工具名合规 `^[a-zA-Z0-9_-]{1,64}$`，**不含点**）。
  - **D 权限闸门（三态）**：`src/main/services/permissions.ts`。`evaluate(sessionId, toolName)`：读/列=allow，写=ask，会话级"始终允许"记忆（内存 Map）；拒绝也回填工具结果让模型继续。
  - **E 渲染层真实 chat store**：`src/renderer/src/store/chat.tsx`（`ChatProvider`，`reduceBlocks` 纯函数把流事件累积成文本/思考/工具卡/权限卡/错误块；按 sessionId 过滤事件；send 前同步建空 assistant 消息避免首帧竞态；deny 时本地即标 nearest running tool 为 denied，主进程回执到达时保持 denied）。重写 `features/chat/ChatView.tsx` 吃真实数据（工具卡 + 权限卡 allow/allowAlways/deny + 模型下拉选择器 + 流式期"停止"）。`main.tsx` 挂 `ChatProvider`（Workspace 内、UI 外）。i18n 双语 chat/models 段同步补齐、`styles/app.css` 相应样式补齐。mock 的 chat 切片已无残留。
  - **密钥安全闭环**：渲染层只发 `providerId+baseURL+adapter+model`，主进程按 `getSecret` 取解密 key 发请求，key 从不过渲染层；渲染层只存布尔 `keyStatus`。
  - **已知边界（下次注意）**：本阶段仅做到「代码干净 + 冷启动无报错」；尚未用真实 API Key 跑通「发消息→流式→工具卡→写文件权限→停止」的功能级回归（需要真机密钥）。Phase 3 前若能拿到一个可用 provider key，应先做一轮功能验收。
- **流式真中断检测 + 自动重连（2026-09-09）**：不再靠「静默 N 秒」猜测，改为主进程直接检测流空闲超时（`providers/sse.ts` `STREAM_IDLE_MS=60s` + `StreamIdleError` + `readWithIdle`），`chat.ts` 内 `reconnect:` 标签循环（`MAX_RECONNECT=3` + 退避 `delay()`）自动重发该步并续跑；新增 `StreamEvent` 的 `reconnecting`/`stream_reset` 两事件（chat.ts / preload / store 三处结构同步）。渲染层 `store/chat.tsx` 收 `reconnecting` 显示琥珀色「连接中断，正在重连 (n/max)」横幅、收 `stream_reset` 用 `dropStepPartial` 丢弃本步未完成的半截块再重放。typecheck+build 全绿。
- **工具集扩充 edit_file/grep/glob（2026-09-09，Phase 3 前插入）**：`services/tools.ts` 从 3 工具（read_file/list_dir/write_file）扩到 6，补齐编码内核缺口——
  - `edit_file`（精确字面量替换）：默认要求 `old_string` 在文件中唯一，否则报错要求补上下文；`replace_all=true` 全替；用 `text.split(old).join(new)` 绕开 `String.replace` 对 `$` 的特殊解释；归 EDIT 类走权限 `ask`。
  - `grep`（正则搜内容）：可选 `glob` 限定文件 / `ignore_case`；返回 `路径:行号: 内容`；跳二进制/超大文件；护栏 `GREP_MATCH_MAX=200`。
  - `glob`（`**/*.ts` 式文件匹配）：手写 `globToRegExp`（支持 `**`/`*`/`?`/`{a,b}`）；按 mtime 倒序；护栏 `GLOB_RESULT_MAX=500`。
  - `read_file` 增强：带行号（cat -n 式）+ `offset`/`limit` 分段。
  - 零依赖手写 `collectFiles`（递归遍历跳 `IGNORE_DIRS`=node_modules/.git/dist… + `WALK_MAX=2万` 护栏）。复用现有权限闸门与 `fs-guard.assertInside`，无需改 permissions.ts。前端 `ChatView` 加 TOOL_META（Replace/Search/FileSearch 图标）+ `argPath`→`argHint`(path→pattern) + i18n 双语键。typecheck+build 全绿。
- **网络工具 web_fetch（2026-09-09，用户选「先只加 WebFetch」）**：`services/tools.ts` 第 7 个工具，首个网络能力。Node 原生 `fetch` 抓 http/https → HTML 用手写 `htmlToText`/`decodeEntities`（零依赖：剥 script/style/注释/head、块级标签转行、去标签、解码实体、折叠空白、抽 `<title>`）转纯文本；JSON/纯文本原样。护栏：30s 超时（AbortController）、5MB 下载上限（`readCapped` 流式截断）、10 万字符文本上限、仅 http/https。归 **read** 类恒放行（与 Claude Code WebFetch 一致，信息检索无本地副作用），未改 permissions.ts。前端 Globe 图标 + `argHint` 追加 url + i18n `webFetch`。typecheck+build 全绿。**WebSearch 暂缓**：需搜索引擎 key（破坏零配置）或绑 provider 原生搜索，方案未定——将来做「provider 原生优先 + 第三方 key 可选增强 + 无 key 降级」三层。
- **配置存储改到 `~/.deva`（Phase 2 后应用户要求补做，已验证 typecheck/build/运行时）**：用户配置从分散的 userData/localStorage 收敛到一个开发者可见、可手改、可备份/版本化的根目录（对标 ~/.claude）。**混合式**——非敏感明文、敏感仍加密：
  - **根目录**：`~/.deva`（`app.getPath('home')` 派生），可用环境变量 `DEVA_HOME` 覆盖（便携/测试/CI）。首次访问自动 `mkdir`。
  - **非敏感** → `~/.deva/config.json`（明文可手改）：`theme` / `locale` / `models`(providers 全量含 apiHost、enabled、自定义服务商 + `activeModelId`)。主进程 `src/main/services/config.ts`（`registerConfigIpc`）：`config:get-sync`（`sendSync`，供渲染层**首帧同步读**主题/语言防闪烁）+ `config:get` + `config:set`（顶层浅合并，值 undefined 即删键）。
  - **敏感（API Key）** → `~/.deva/secrets.json`：**保持 safeStorage 加密的 base64 密文,绝不明文**（点目录 ≠ 明文；DPAPI 密文绑 OS 用户账户、与路径无关）。`secrets.ts` 路径改到 deva home，并从旧 `userData/secrets.json` **一次性迁移**（旧文件保留兜底不删）。
  - **渲染层接线**：`ThemeContext`/`i18n` 首帧走 `config.getSync()`（localStorage 降级兜底 + 双写）；`models` store 挂载时 `config.get()` 载入并与默认种子**合并**（已存为准 + 追加新内置服务商），hydrate 后变更即 `config.set({models})` 回写。密钥仍只走 `deva.secrets`，绝不进 config.json。
  - **收益**：模型/服务商设置从此**持久化**（此前是内存态、刷新即丢）；为将来 `~/.deva/skills/`、`~/.deva/mcp.json`、`~/.deva/agents/`（全局）+ 项目内 `<project>/.deva/`（项目级）预留一致布局。
  - **实测**：冷启动即自动生成 `~/.deva/config.json`（含 models + activeModelId），dev.log 零错误。
- **Phase 3 集成终端（真实 PTY，2026-09-09；代码级完成 + 原生模块已实测，GUI 交互待人工确认）**：底部面板终端从静态 mock 换成真实伪终端。**Utility Process 隔离**（用户选定，对齐 `docs/modules/ide-features.md` §4）——
  - **原生模块选型（零配置铁律核心）**：`@lydell/node-pty@1.2.0-beta.15`。按平台以 `optionalDependencies` 分发**预编译 N-API 二进制**（`prebuilds/{platform}-{arch}/*.node`，prebuildify 布局，ABI 稳定，**永不调 node-gyp**），win32-x64 包自带 ConPTY 运行时（conpty.dll/OpenConsole.exe）。**本机无 MSVC 也能装**（纯下载预编译、无编译步骤）。**已实测**：`ELECTRON_RUN_AS_NODE=1 electron.exe` 跑冒烟脚本，node-pty 成功加载并 spawn `powershell.exe`、流出 203+234 字节 ConPTY 输出 —— 证明预编译 .node 在 Electron 33 的 Node/N-API ABI 下直接可用。前端 `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`（纯 JS，sandbox 下正常）。
  - **架构（三层中继）**：渲染层 xterm.js ──ipcRenderer──► 主进程 `services/terminal.ts`（桥）──parentPort──► Utility Process `src/main/pty-host.ts`（持 node-pty）。主进程只中继、不加载原生模块；渲染层永不碰 Node。线缆类型按约定三处（terminal.ts / pty-host.ts / preload）各自结构化复述、不跨层 import。
  - **落地文件**：新建 `src/main/pty-host.ts`（Utility 入口：收 create/input/resize/dispose，管 `Map<id,IPty>`，onData/onExit→postMessage；shell 默认 Win=powershell.exe / 其余=$SHELL||/bin/bash；cwd 不存在则回退 homedir）+ `src/main/services/terminal.ts`（`registerTerminalIpc`：惰性单例 `utilityProcess.fork('pty-host.js')`，`spawn` 事件前的消息进 pending 队列待冲刷防丢；宿主整体退出→给活跃会话补发 exit 并复位以便 refork；通道 `terminal:create`(invoke→{id}) / input|resize|dispose(send) / data|exit(webContents.send)）。改 `electron.vite.config.ts`（main 加第二 rollup 入口 pty-host，产出 `out/main/pty-host.js`）、`main/index.ts`（注册）、`preload/index.ts`（`deva.terminal` 命名空间 create/write/resize/dispose/onData/onExit + 结构化类型）、`TerminalView.tsx`（整体重写：xterm+FitAddon，挂载→fit→create→双向桥接→ResizeObserver 自适应；主题热切换更新 `options.theme` 不重建；cwd 取 `useWorkspace().activeProject?.path`；卸载 dispose+退订，disposed 标志防 create 未回先卸载）、`styles/app.css`（`.terminal` 撑满容器交给 xterm.css）、i18n（`panel.terminalExited` 双语）。
  - **已验证**：typecheck(node+web)+build 全绿，`out/main/pty-host.js`(2.09kB) 与 index.js 均产出，pty-host.js 里 node-pty 为运行时 `require`（externalize 生效、未打包进 bundle）；干净 `pnpm dev` 启动无报错、窗口加载、终端 IPC 注册成功。
  - **唯一遗留（待人工确认）**：底部面板默认隐藏（`ui.tsx` `panelVisible:false`），故自动化启动不会挂载 TerminalView；且无法经现有工具驱动 Electron 渲染进程 GUI。需人工：`pnpm dev`→打开一个文件夹→底部「终端」标签→应见真实 PowerShell 提示符、`dir`/`echo` 有真实输出、拉伸窗口自适应、交互正常。**用完记得 `taskkill //F //IM electron.exe`**。
  - **v1 边界（后续做，非本次）**：① 切 tab/关面板即卸载→PTY 被 dispose，重开是新终端、无 scrollback 恢复（待「稳定 session id + 保活 + 回放缓冲」）；② 切项目不重建终端（cwd 挂载时定格，需新 cwd 请关开面板）；③ 单终端，无多 tab/拆分；④ Agent `exec` 工具接回（终端作为工具走权限闸门+超时+截断，`EXEC_TOOLS` 已预留）；⑤ **打包（Phase 8）**：electron-builder 需 `asarUnpack` 覆盖 `@lydell/node-pty*`（含 `prebuilds/**` 的 .node 与 ConPTY 运行时）。

---

## 3. 既定 IPC 架构约定（每个功能照此扩展，勿另起炉灶）

1. 主进程 `src/main/services/<feature>.ts` 导出 `register<Feature>Ipc(getWindow)`，在 `main/index.ts` 的 `whenReady` 里调用；通道名 `feature:action`。
2. 文件/危险操作在主进程校验受信根 + 过权限闸门。
3. preload 在 `deva` 白名单里加命名空间（如 `deva.fs`/`deva.chat`/`deva.secrets`），类型经 `DevaApi` 流到渲染层 `window.deva.*`。
4. 渲染层每个功能一个 Context store（真实数据）；旧 `src/renderer/src/mock/data.ts` 按阶段逐块删除（git/db/ssh 仍是 mock）。
5. Provider 组件嵌套顺序（main.tsx）：Theme > I18n > Models > Extensions > Workspace > UI > App（Phase 2 会新增 Chat Provider，放在 Workspace 之后、UI 之前或就近）。

---

## 4. ✅ 已完成：Phase 2 —— AI Agent 对话循环（代码级完成，功能级待真机密钥回归）

> 落地清单存档见「2. 已完成」的 Phase 2 条目。下方保留原始步骤拆解作为设计留痕（复盘/回归时对照）；所有 checkbox 已勾。
> **唯一遗留**：未用真实 API Key 跑通端到端功能回归（发消息→流式→工具卡→写文件权限→停止）。拿到可用 key 后先做一轮再进 Phase 3。

**目标**：把对话页从 mock 变成真实可用的 Agent —— 配好模型密钥后，能对话、流式逐字输出、调用 fs 工具、写操作走权限确认。**设计依据**：`docs/modules/agent-engine.md`（Agent 循环/工具系统）、`docs/architecture/providers.md`（Provider 归一化接口 + `StreamEvent`）、`docs/modules/permissions.md`（三态 allow/deny/ask + 默认基线）。
**落地策略**：先在 `apps/desktop` 主进程内用 `services/` + `providers/` 目录实现，概念对齐设计文档里的 `@deva/providers`/`@deva/permissions`/`@deva/agent-core`，将来再抽包。**不引入厂商 SDK**，用主进程原生 `fetch` + 手写 SSE 解析（满足零配置、减小体积）。

### 步骤 A —— 密钥安全存储（safeStorage）
- [x] `src/main/services/secrets.ts`：`registerSecretsIpc`；通道 `secrets:set|has|delete|list`。用 Electron `safeStorage.encryptString/decryptString`，密文（base64）存 `userData/secrets.json`。`isEncryptionAvailable()` 为 false 时的降级提示。
- [x] **明文永不出主进程**：不提供 `secrets:get` 给渲染层；解密只在主进程内被 provider 调用时使用。
- [x] preload 加 `deva.secrets`：`setKey(providerId, key)` / `hasKey(providerId)` / `deleteKey(providerId)`（无 getKey）。
- [x] 渲染层模型设置页：API Key 输入 → `deva.secrets.setKey`；用 `hasKey` 显示"已配置/未配置"掩码态（不回显明文）。

### 步骤 B —— Provider 适配层（主进程）
- [x] `src/main/providers/types.ts`：`Message` / `ToolSpec` / `GenerateRequest` / `StreamEvent`（`text_delta|tool_call|tool_call_delta|thinking_delta|usage|error|done`）/ `Provider` 接口 —— 直接照 `providers.md` §3。
- [x] `src/main/providers/anthropic.ts`：对 Anthropic Messages API 发流式请求，SSE → `StreamEvent`；`tool_use` 归一为 `tool_call`；`stop_reason` 归一。
- [x] `src/main/providers/openai-compatible.ts`：OpenAI Chat Completions 风格（覆盖 DeepSeek / Qwen / Kimi / 自定义 baseURL），SSE → `StreamEvent`；`tool_calls` 增量拼接 → `tool_call`。
- [x] `src/main/providers/index.ts`：注册表 `resolveProvider(providerId)`；从 secrets 取解密 key、从模型配置取 baseURL/model。
- [x] 错误归一化 `NormalizedError`（auth/rate_limit/context_length/network/...），驱动 UI 提示。

### 步骤 C —— 会话 / Agent 循环 + 流式 IPC
- [x] `src/main/services/chat.ts`：`registerChatIpc`。通道：`chat:send`（入参 sessionId、messages、provider/model、workspaceRoot）→ 返回 turnId；事件经 `webContents.send('chat:event', {turnId, event})` 推回；`chat:abort`（每 turn 一个 `AbortController`）。
- [x] 实现 Agent 循环（照 agent-engine.md §2）：装配请求 → `provider.stream` → 转发 text/thinking/tool 事件 → 收到 `tool_call` 后**过权限闸门**再执行 → 回填 `tool_result` → 继续，直到 `end_turn` 或触顶（最大步数如 25 / 最长时间）。只读工具可自动放行并（可选）并行；写工具串行。
- [x] 主进程工具注册表：复用 Phase 1 fs → 暴露为工具 `fs.read` / `fs.list` / `fs.write`（后续加 `fs.edit`/`fs.search`）；全部走受信根校验；生成给 provider 的 JSON Schema 声明。
- [x] preload 加 `deva.chat`：`send(req)→turnId` / `onEvent(cb)` 订阅 / `abort(turnId)` / 取消订阅。

### 步骤 D —— 权限闸门（三态）
- [x] `src/main/services/permissions.ts`：`evaluate(toolCall) → allow|deny|ask`，默认基线照 permissions.md §10（读/列/搜=allow；写/编辑/exec=ask；删除/覆盖/危险=ask+二次确认）。会话级记忆（内存 Map，"本会话允许"）。
- [x] `ask` 时 → `chat:permission-request` 推渲染层，等 `chat:permission-response`（decision + 记忆粒度）再放行/拒绝；**拒绝也要回填工具结果**让模型知道并继续。
- [x] 破坏性操作即便命中 allow 仍二次确认；来源标注（外部内容/文件/MCP）以防提示注入。

### 步骤 E —— 渲染层真实 chat store，替换 mock
- [x] `src/renderer/src/store/chat.tsx`：`ChatProvider`。状态：messages[]、当前流式 assistant 缓冲、pending 权限请求、sending/aborting。方法：`send(text)` / `stop()` / `respondPermission(id, decision)`。订阅 `deva.chat` 事件 → text_delta 逐字追加（气泡增长）、tool_call/tool_result → 渲染工具卡片、permission-request → 弹权限卡片。
- [x] 重写 `features/chat/ChatView.tsx`：保留 DeepSeek 视觉，改吃 chat store 真实数据；输入区 send 接 `store.send`；模型选择器接 Models store（替换写死的 "Claude Sonnet"）；流式期间显示"停止"按钮。
- [x] 删除 `mock/data.ts` 里的 chat 切片。
- [x] main.tsx 挂上 `ChatProvider`。

### Phase 2 验收标准
配好一个 provider（例如 DeepSeek）→ 发「列出当前目录并读取 package.json」→ 助手流式输出、自动调用 `fs.list`/`fs.read`；再要求写文件 → 弹权限卡片 → 允许 → 文件写入并展示 diff；点"停止"能中断。全程 `typecheck` + `build` 干净，单个干净 dev 实例，无 ERR_CONNECTION / 无缓存报错。

---

## 5. 验证流程（每次改完照做）

```
pnpm --filter @deva/desktop typecheck
pnpm --filter @deva/desktop build
```
需要跑 UI 时：`pnpm dev`（现在绑 127.0.0.1:5173，dev 正常）。
**纪律（重要，别再犯）**：
- 验证用的 electron 实例**必须用完就关**（TaskStop 后台任务 + `taskkill //F //IM electron.exe`），绝不留后台实例 —— 多实例抢 userData/GPU 缓存就是之前 `access denied (0x5)` 的根因。
- 起 dev 前先确认没有残留 `electron.exe`（`tasklist | grep -ci electron` 应为 0）。
- 别用 `taskkill //IM node.exe`（可能误杀 Claude Code 自身运行时）；只杀 electron.exe。

---

## 6. 后续阶段（Phase 2 之后，按依赖排序）

- **▶ Phase 3 终端（下一步）**：真实 PTY（node-pty，需预编译打包进安装包）。**零配置铁律重点**：node-pty 是原生模块，必须为目标平台预编译并随安装包分发，绝不能让终端用户装编译工具链。先确认打包/预编译方案（prebuild / electron-rebuild），再接终端 UI；终端后续也要能作为工具回接 agent 循环（照 agent-engine.md）。
- **Phase 4 Git**：isomorphic-git（纯 JS，免装 git）。
- **Phase 5 数据库**：mysql2 / ioredis（DB 面板全局，不随项目切换）。
- **Phase 6 远程 SSH**：ssh2（SSH 面板全局）。
- **Phase 7 Skill / MCP / 子 Agent**：接入 agent 循环（照 skills-and-mcp.md、agent-engine.md §5）。
- **Phase 8 打包**：electron-builder 安装包 + 应用图标 + 「双击即启动、零配置」验证（含原生模块预编译验证）。

---

## 7. 关键文件地图

| 位置 | 作用 |
| --- | --- |
| `apps/desktop/electron.vite.config.ts` | 构建配置；renderer.server 已固定 127.0.0.1:5173 |
| `apps/desktop/src/main/index.ts` | 主进程入口、窗口、whenReady 里注册各 IPC service |
| `apps/desktop/src/main/services/workspace.ts` | Phase 1 fs 服务（受信根校验样板） |
| `apps/desktop/src/main/services/config.ts` | 配置存储：`~/.deva/config.json` 非敏感项（DEVA_HOME 可覆盖）；导出 `getDevaHome()` 供 secrets 共用；`config:get-sync/get/set` |
| `apps/desktop/src/main/services/secrets.ts` | 密钥存储：`~/.deva/secrets.json`（safeStorage 加密），从旧 userData 位置一次性迁移；`getSecret` 仅主进程内部 |
| `~/.deva/`（用户目录，非仓库内） | 运行期用户配置根：`config.json`（明文）+ `secrets.json`（加密）；将来 skills/mcp/agents |
| `apps/desktop/src/preload/index.ts` | `deva.*` 白名单桥 + `DevaApi` 类型源 |
| `apps/desktop/src/renderer/src/main.tsx` | Provider 嵌套 |
| `apps/desktop/src/renderer/src/features/registry.ts` | 功能贡献注册表（左侧功能在此登记；ActivityBar/SidePanel/CenterView 都从这里渲染） |
| `apps/desktop/src/renderer/src/store/*.tsx` | 各功能 store（workspace 真实；ui 保留视图态） |
| `apps/desktop/src/renderer/src/features/chat/ChatView.tsx` | 对话视图（DeepSeek 风格，待接真实数据） |
| `apps/desktop/src/renderer/src/mock/data.ts` | 剩余 mock（chat 待删；git/db/ssh 仍用） |
| `apps/desktop/src/renderer/src/i18n/messages.ts` | 双语资源（zh-CN/en 必须同步增改） |
| `apps/desktop/src/renderer/src/styles/{tokens,app}.css` | 设计 token + 组件样式 |
| `docs/modules/agent-engine.md` / `architecture/providers.md` / `modules/permissions.md` | Phase 2 设计依据 |

---

## 8. 待决 / 风险

- 单回合上限默认值（步数/token/时长）—— 先给保守默认（步数 25），后续可调。
- Provider 手写 SSE 解析要覆盖 Anthropic 与 OpenAI 两套事件格式差异（tool 增量拼接易错，重点测）。
- `safeStorage` 在个别 Windows 环境可能 `isEncryptionAvailable()` 为 false —— 要有清晰降级提示，不能静默存明文。
- 模型 ID 不写死（对齐"用最新最强模型"原则），从配置/`listModels()` 来。
