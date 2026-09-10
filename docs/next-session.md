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
- **终端改造：多开 + Shell 选择 + 去黑边 + 精简面板（类 VSCode，2026-09-09；代码级完成 + typecheck/build 全绿，GUI 交互待人工确认）**：底部面板从「静态四标签（终端/问题/输出/端口）+ 单终端」升级为**终端多路复用器**，对齐 VSCode 集成终端。上文 v1 边界的 ①（切 tab 卸载）③（单终端）已部分突破——现支持多页签、隐藏页签保活、进程退出自动关页签。
  - **去黑边**：根因是 `.terminal` 有 `padding:4px 6px` + `.bottompanel__body` 背景用 `var(--bg-panel)`（与 xterm 主背景 `#1e1e20` 异色），FitAddon 按整行取整后露出异色空隙。修复：`.bottompanel__body` 与 `.term-instance` 均 `overflow:hidden`、去内边距（仅保留 VSCode 式 `padding-left:6px`），背景由组件按 `resolved` 主题内联为 xterm 底色（`xtermTheme.ts` 的 `xtermBg`），残余空隙与 xterm 同色。
  - **精简面板**：删除「问题/输出/端口」占位标签（连同 `ui.tsx` 的 `BottomTab`/`bottomTab`/`setBottomTab` 与 i18n `panel.problems/output/ports`）；底部面板专注做终端。
  - **多开 + Shell 选择**：新建 `src/main/services/shells.ts`（零配置探测——只用 `existsSync`/`process.env`，不引依赖、不碰 node-pty；win32 探 Windows PowerShell〔默认〕/cmd/pwsh/Git Bash〔`--login -i`〕/WSL，posix 探 `$SHELL`+bash/zsh/fish/sh；模块级缓存；`resolveShell(id)` 解析 `{path,args}`）。`terminal.ts` 加 `terminal:list-shells`（**只回 id/label/isDefault，path/args 留主进程**）+ `create` 带 `shellId`→`resolveShell`→发 `shellPath/shellArgs` 给 host；`pty-host.ts` `spawn(shellPath||defaultShell(), shellArgs??[])`；preload 加 `listShells` + `ShellProfile`（无 path/args）。渲染层：`TerminalView.tsx` 删除，逻辑参数化为 `features/terminal/TerminalInstance.tsx`（props `{id,shellId,visible,onExit}`；隐藏页签 `display:none` 保活、重可见再 fit；PTY `onExit`→上抛父组件关页签，去掉旧「已退出」占位行）；`xtermTheme.ts` 抽出明暗 `ITheme` 共享；`BottomPanel.tsx` 重写为多路复用器（页签条 + 「+」新建默认 shell + 「⌄」下拉选 shell + 关面板；`seqRef` 生成页签 id；`initRef` 幂等守卫抵御 StrictMode 双挂载自动新建默认终端；同名 title 追加 ` (n)`）。i18n 双语补 `terminal.newTerminal/killTerminal/selectShell`；`app.css` 加 `.termtabs/.termtab/.termtab__close/.term-actions/.term-newmenu/.term-menu/.term-menu__item/.term-instance/.term-empty`，删旧 `.terminal` mock 块。
  - **默认与取舍**：默认 shell = Windows PowerShell（恒在最稳，不默认 pwsh）；进程退出自动关页签（VSCode 默认）；跨面板不保活（关面板卸载 `BottomPanel`→销毁全部终端，沿用 v1 边界）；不做拆分窗格；WSL 仅探入口不枚举发行版。
  - **已验证**：`typecheck`(node+web) + `build` 全绿；`out/main/pty-host.js`(2.13kB) 仍产出、node-pty 仍运行时 `require`（未打包进 bundle）。
  - **唯一遗留（待人工确认，同 Phase 3 原因）**：底部面板默认隐藏 + 无法经现有工具驱动 Electron 渲染 GUI。需人工 `pnpm dev`→打开文件夹→底部终端面板：无黑边/无问题输出端口标签；「+」得 PowerShell、「⌄」列出已装 shell（cmd/Git Bash/pwsh 若装）各起页签；多页签切换各自保活、`dir`/`echo`/`ls`(bash) 真实交互、拉伸自适应；页签「×」单独关、某终端 `exit` 后自动消失；devtools 无原生加载报错。**用完 `taskkill //F //IM electron.exe`**。
  - **终端按视图显隐（2026-09-09；代码级完成 + typecheck/build 全绿，GUI 待人工确认）**：终端仅在**对话/资源管理器/版本控制**视图显示，切到 database/ssh/extensions/settings 时**隐藏但不销毁**（PTY 会话与滚动历史保活），顶栏「打开终端」按钮随之禁用。实现：`registry.ts` 给 `FeatureContribution` 加声明式 `showsTerminal?`（chat/explorer/git 置 `true`）+ 导出 `viewShowsTerminal(id)`（放注册表，避开 `ui.tsx`「store 不 import feature」的环约束）；`AppShell.tsx` 把 `{panelVisible && <BottomPanel/>}` 改为 `panelVisible && <BottomPanel hidden={!viewShowsTerminal(activeView)}/>`——面板一旦打开就随 `panelVisible` 常驻、切页仅 CSS `display:none`（保活），仅显式关面板才卸载；`BottomPanel` 加 `hidden?` prop（根节点内联 `display:none`，覆盖其 `display:flex`）；`TitleBar.tsx` 底部面板按钮 `disabled={!terminalAllowed}`、`is-active` 仅在 `panelVisible && terminalAllowed`；`app.css` 补 `.icon-btn:disabled`（`opacity .35 + pointer-events:none`）。重显靠 `TerminalInstance` 既有 `ResizeObserver`（容器 0→实尺寸自动 refit），无需额外 wiring。**StatusBar 同源收口**：底部状态栏原「Cpu 图标 + 模型名」项其实绑的是 `togglePanel`（显示模型、点开终端，图文与行为不符），改为**终端开关**（`Terminal` 图标 + `terminal.title` 文案），并同样 `viewShowsTerminal(activeView)` 门禁——非终端视图 `is-disabled`（灰、不可点），面板开且允许时加 `statusbar__accent` 高亮；与顶栏按钮同源 `togglePanel` 故行为始终一致（`app.css` 补 `.statusbar__item.is-disabled`，`StatusBar` 移除不再用的 `useModels`）。
  - **终端残余黑边 + 对话工具条选择器打磨（2026-09-09；typecheck/build 全绿，GUI 待人工确认）**：① **黑边收尾**——前次「去黑边」把容器背景对齐了 xterm 底色，但 `@xterm/xterm/css/xterm.css` 里 `.xterm-viewport { background-color:#000 }` 是硬编码，FitAddon 取整后的底部残余行仍透出黑边。修复：`app.css` 给 `.term-instance .xterm-viewport` 加 `background-color:transparent !important`，让 `.term-instance` 的内联 `xtermBg` 主题底色透上来（明暗皆准）。② **模型/权限选择器**——`.chip` 原缺 `white-space:nowrap`，模型名过长会换行撑破工具条；一旦换行/变长，`flex:1` 的 `.composer__spacer` 被挤成 0，权限贴片与模型贴片就贴到一起（用户所说「挤在一起」）。修复：`.chip` 加 `white-space:nowrap`+`flex-shrink:0`+`cursor:pointer`+悬停 `border-strong` 过渡，高度 24→26、左内边距微调；新增 `.chip__label`（`max-width:168px`+省略号截断长模型名）与 `.chip__caret`（箭头恒显不被挤压）；`ChatView.tsx` 把模型名与权限模式文案包进 `.chip__label`、`ChevronDown` 加 `.chip__caret`；工具条 `gap` `space-1→space-2`、`.composer__spacer` 加 `min-width` 兜底。长模型名现单行省略号、权限/模型贴片始终由 spacer 隔开不再贴挤。③ **模型下拉「选项」换行**（用户「选项自动换行」实指下拉项，非工具条贴片；1.png 见 `claude-haiku-4-5-20251001` 在菜单里折成两行且居中）——`.model-pick__menu` 原 `min-width:240px` 容不下长名，`.model-pick__name` 无换行控制故折行。修复：菜单改 `width:max-content`+`min-width:240`/`max-width:360`（按最长名单行自适应、短名不留空）；`.model-pick__name` 加 `flex:1`+`min-width:0`+`nowrap`+省略号，`.model-pick__prov`（Claude 标签）`flex-shrink:0`+`nowrap`（去掉 `margin-left:auto` 改由 name `flex:1` 顶到右缘）；`ChatView.tsx` 选项 `<button>` 加 `title={m.name}`（被 max-width 截断时悬停可读）。
- **Agent 命令执行工具 run_command（2026-09-09；代码级完成 + 策略层单测 49/49 + 真机 shell 解析实测，对话 GUI 回归待人工）**：对话循环第 8 个工具，补齐编码闭环最后一环——模型可跑构建/测试/git/脚本。**用户决策**：① 暂不做 OS 沙箱，参照 Claude Code 原生 Windows Bash 的「策略层」（人工授权 + 命令拆分 + 超时杀树 + 输出截断 + 非交互 env，不沙箱）；② **执行 shell 优先 Git Bash**（命令统一写 POSIX，未装回落 cmd）；③ **「本会话始终允许」按命令前缀记住**（如 `git status`，非整个工具）。
  - **新建 `src/main/services/exec-policy.ts`（纯函数零依赖策略层，不 import tools/permissions 避免环）**：`resolveExecShell()`（win 优先 Git Bash `bash -l -c`，去交互 `-i` 防挂起；**PATH 推导兜底**——`detectShells()` 硬编码候选只查 `%ProgramFiles%\Git\...`，漏掉非 C: 盘/绿色装，故补 `findGitBashOnPath()` 从 PATH 上 `git.exe` 按 Git for Windows 固定布局推导 `bin\bash.exe`；posix `/bin/bash -c` 否则 `/bin/sh -c`；模块缓存）；`splitCommand()`（引号感知、递归抽 `$()`/反引号、拆 `&& || ; | &`+换行 的顶层子命令，`2>&1`/`&>` 重定向不误拆，保守过拆防注入）；`commandPrefix()`（推导可记前缀，`git status`/`npm run`，`NEVER_REMEMBER_VERBS`=rm/mv/dd/curl… 返回空永不记）；`matchesPrefix()`（token 边界字面前缀匹配）；`isDangerousCommand()`（deny 名单纵深兜底，非主边界：整串测跨管道灌 shell + fork bomb，每子命令锚 `^` 测 rm -rf 根/dd 裸设备/mkfs/shutdown 等，`rm -rf ./node_modules`/`npm run format` 不误伤）。
  - **`tools.ts`**：`EXEC_TOOLS={run_command}`；ToolSpec（描述按 `process.platform` 动态拼，告知 OS+shell+非交互+超时）；`ToolContext` 加 `signal?`（随 abort 杀树）；helper `execEnv()`（禁分页器/凭据提示/颜色）、`killTree()`（win `taskkill /T /F`、posix 杀进程组）、`execCapture()`（`child_process.spawn`，合并 stdout/stderr 按到达序，超时/中止/暴产出 4×30000 字节杀树，先 `Buffer.concat` 再 utf8 解码）；`run_command` 分支：空参/无项目/受信校验/`isDangerousCommand` 兜底 deny/`clamp(timeout,1000,600000)`→执行→截断 30000+恒显状态行（退出码/超时/中止/spawnError）。
  - **`permissions.ts`**：`evaluate(sessionId,key,toolName,args?)` 增 `args` 形参，exec 类路由到 `evaluateExec`（顺序即语义：**deny 压过一切→auto→记住前缀覆盖每个子命令→ask**；`acceptEdits` 对 exec 不短路）；新增 `sessionAllowExec: Map` + `rememberSessionExec()`（拆分逐段 `commandPrefix` 入集，空串被 filter）；`clearSession` 一并清 exec 集。
  - **`chat.ts`**：`evaluate` 传 `tc.args`；工具执行块重构为三态（allow 直跑 / ask 弹窗 / policy `deny` **不弹窗**直拒）；ask 允许且记住时 exec 记前缀、其余记工具名；`ctx` 加 `signal: controller.signal`。**`ChatView.tsx`**：`SquareTerminal` 图标 + `TOOL_META.run_command`（i18n `chat.tool.runCommand` 已存在）+ `argHint` 优先回显 `command`（工具卡/权限卡都靠它给用户看清将执行的命令）。
  - **已验证**：`typecheck`(node+web)+`build` 全绿；`evaluate(` 全仓仅一处生产调用点（chat.ts）已改；**策略层 49 条单测全过**（splitCommand/commandPrefix/matchesPrefix/isDangerousCommand，含注入/误伤边界，用 esbuild bundle 后 node 跑，测毕删）；**真机实测** `resolveExecShell()` 在真实 Windows env（本机 git 装 D 盘）正确解析到 `d:\Program Files\Git\bin\bash.exe -l -c` 并跑通 `echo/pwd/git --version/ls|head`。
  - **唯一遗留（待人工确认，同 Phase 3 GUI 原因）**：对话页端到端未人工回归——需真机 key + `pnpm dev`→开项目→让 Agent 跑命令，照计划 10 场景（`echo`/`git status` 弹窗允许、「本会话始终允许」记前缀后 `git status -s` 免弹但 `git log` 再弹、注入 `git status && echo pwned` 仍弹、`rm -rf /`/`curl|sh` 不弹直拒且不误伤 `rm -rf ./node_modules`、无项目报错、`timeout` 超时杀树/Stop 中止进程树消失）。**用完 `taskkill //F //IM electron.exe`**。
  - **本次未做（留意）**：`shells.ts` 的 Git Bash 探测同样漏非 C: 盘装（本次只在 exec-policy 内做了 PATH 推导兜底，未改共享的 `shells.ts`／终端）；若日后要让终端 Git Bash 页签也覆盖此类安装，可把 `findGitBashOnPath` 思路上提到 `shells.ts`。

- **Agent 项目外访问「询问后信任」+ 符号链接穿越加固（2026-09-10；代码级完成 + typecheck/build 全绿，对话 GUI 回归待人工）**：解决「Agent 只能读写工作区内文件」的限制。**用户决策**：不加目录管理 UI，改为——文件类工具目标落在受信根之外时**弹权限卡询问**；同意即把目录加入受信根。**作用域＝仅本会话（内存态，重启清空）**，不落盘（刻意，避免供应链式预授权）。两颗按钮语义：**「仅此次允许」＝临时精确放行该路径、执行后立即撤销、不加根**；**「本会话信任该目录」＝ `trustRoot(dir)` 加会话根覆盖子树**。信任粒度：文件类工具取父目录、目录类工具（list_dir/glob/grep）取目标目录本身。
  - **`fs-guard.ts`（重写）**：① 新增 `realResolve()`——跟随符号链接取真实路径，目标不存在（将新建文件）时对最近存在祖先 realpath 再接回尾段，失败回退字面 resolve；`isInsideRoot` 改为**以真实路径比较**，堵住旧实现「根内符号链接指向根外」的真实穿越面（旧 `resolve()` 只归一 `..` 不跟随链接）。② 新增 `untrustRoot()`（供「仅此次」撤销）。③ 新增 `isSensitivePath()` **硬底**——`~/.ssh`/`~/.aws`/`~/.gnupg`/`~/.deva`（本应用密钥库！）/ win `%SystemRoot%` / posix `/etc /proc /sys /dev` 子树，真实路径比较；命中即便用户同意也一律拒绝（防授权流程变成读凭据的后门）。
  - **`tools.ts`**：新增导出 `outsideRootTarget(name,args,root)`——路径解析规则**与 `resolvePath` 完全一致**（保证「判在外→授权加根→执行时 assertInside 必过」一致性），返回 `{abs, dir}` 或 null；`web_fetch`/`run_command` 返回 null（走常规闸门，run_command 的 cwd 另在执行处校验）。`resolvePath`/`assertInside` 本身未改（透明受益于 realpath 加固）。
  - **`chat.ts`**：工具循环在 `evaluate` **之前**插入越界预检——`outside` 命中则：敏感路径→policy deny（不弹窗）；否则 `requestPermission(..., {outsideRoot, trustDir})` 询问，允许+remember→`trustRoot(dir)`、允许+一次性→`trustRoot(abs)` 且 `finally untrustRoot`；与常规三态 `if/else` **互斥**（故首次越界只弹一次卡，不叠加常规编辑卡）。`requestPermission` 增可选 outside 元信息透传到 `permission_request` 事件。
  - **线缆类型**：`permission_request` 事件 + 渲染层 `ChatBlock('permission')` 均加可选 `outsideRoot?`/`trustDir?`（chat.ts / preload/index.ts / store/chat.tsx 三处同步）。**`ChatView.tsx`**：越界卡显式展示**完整绝对路径**（`code` 可换行）+ `AlertTriangle` 告警行，两颗允许按钮改用 `outsideAllowOnce`/`outsideTrustDir` 文案（信任按钮 `title` 显示将信任的目录）。i18n zh/en 各加 `chat.permission.{outside,outsideAllowOnce,outsideTrustDir}`；`app.css` 加 `.permission--outside`/`.permission__warn`。
  - **边界要点**：fs IPC（`fs:read-file` 等，渲染层文件树用）**不走**此询问流、保持硬 `assertInside`（树只展示已开项目，无需越界）；本特性仅 Agent 文件工具。`auto` 模式下项目内编辑免弹，但跨出项目仍必弹询问（越界是更高一档的门槛）。realpath 加固对 pnpm 的 `node_modules/.pnpm` 相对符号链接无影响（仍在项目内）；仅真正指向项目外的链接会触发询问。
  - **待人工回归**：真机 `pnpm dev`→开项目→让 Agent ① 读项目外文件（弹越界卡、显绝对路径）→「仅此次」跑通且不留根（同文件再读再弹）；②「本会话信任该目录」→同目录后续文件免再弹（读免弹、写仍走常规编辑卡）；③ 让 Agent 读 `~/.ssh/id_rsa` 或 `~/.deva/secrets.json`→**不弹直拒**（安全策略）；④ 重启后信任消失。**用完 `taskkill //F //IM electron.exe`**。

- **Agent 用户交互工具 ask_user（征求决策/澄清，2026-09-10；代码级完成 + typecheck/build 全绿，对话 GUI 回归待人工）**：给对话循环加「反问用户」能力——需求有歧义/多方案抉择/缺关键信息时，模型可暂停循环、抛一个**单选问题**让用户选择或自行输入，答复回灌后继续。**选项形态参考 Codex**：竖排编号单选、一次一问、附自由输入兜底。**关键区分**：本工具是「征求**决策/澄清**」，与既有「征求**授权**」（权限卡）正交——`ask_user` **不含**「本会话始终允许/记住」语义，也**不过权限闸门**（恒放行）；系统提示明令「授权仍走权限按钮，切勿用 ask_user 问『是否允许』」。
  - **复用权限闸门的暂停/等待/恢复骨架**（emit 事件 + pending Map + IPC resolve），另起一套 `pendingAsk`：`tools.ts` 注册 `ask_user` ToolSpec（`{question:必填string, options?:{label必填,description?}[]}`，界面总额外提供「自己输入」项故无需模型列出）；**`ask_user` 不由 `executeTool` 执行**——`chat.ts` 工具循环在 `evaluate` **之前**特判拦截、`await askUser()` 暂停、答复 `用户回答：{answer}`（或取消 `用户取消了本次询问。`）回灌为 tool_result。
  - **去重双卡**：流式阶段抑制 `ask_user` 的通用 `tool_call` 事件（`ev.name!=='ask_user'` 才 emit），仅入 `toolCalls` 保 tool_use/tool_result 配对；循环真正走到它时才发**专用 `ask_user` 事件**（新 key，非 tc.id）→ 渲染层建 `ask` 块。`chat:abort` 一并把 `pendingAsk` 按 null（取消）解开（因 abort 检查在循环顶、该 tc 已过检，故取消的 tool_result 仍会落进 history 保持一致）。
  - **线缆类型五层同步**：`ChatStreamEvent`/`AskOption`/`AskResponse`（chat.ts）→ preload（事件 + `deva.chat.respondAsk` + `chat:ask-response` IPC）→ store/chat.tsx（`ChatBlock('ask')` + StreamEvent + `reduceBlocks` case + `respondAsk` 就地收敛 answered 态）→ `ChatView.tsx`（`AskCard` 组件：Codex 式编号单选 + Pencil 自由输入行，点选/输入即答、答后塌为 `ask__resolved`；`TOOL_META.ask_user`；`deriveActivity`/`StatusIndicator` 加「等待作答」态）。i18n zh/en 各加 `chat.tool.askUser`/`chat.ask.{title,customPlaceholder,send}`/`chat.work.awaitingAnswer`；`app.css` 加 `.ask*`（accent 观感区别于权限卡 warning）。
  - **v1 边界**：① 重开历史会话时 `ask_user` 降级为通用工具卡（`toDisplayMessages` 无 ask 专类，锦上添花可后补）；② 取消仅经 `chat:abort`（无独立「取消提问」按钮）；③ 模型一轮抛多问会并列多张卡（系统提示已导「一次一问」，属边界非常态）。
  - **待人工回归**：真机 `pnpm dev`→开项目→诱导模型调 `ask_user`（如「用 A 或 B 方案随你定」类模糊需求）→应见问答卡：点候选项即作答、或自由输入回车/发送；答后卡塌为已答态、循环带着 `用户回答：…` 继续；流式期底部指示器显「等待你的选择」；点停止应取消提问。**用完 `taskkill //F //IM electron.exe`**。

- **对话内容 Markdown 渲染（GFM + 代码高亮，参考 DeepSeek/Codex，2026-09-10；代码级完成 + typecheck/build 全绿，GUI 待人工确认）**：助手消息从「纯文本 `<p white-space:pre-wrap>`」升级为富文本渲染，补齐观感短板。**用户决策「按建议来」**：react-markdown + remark-gfm + rehype-highlight（highlight.js class 主题），DeepSeek 式代码块（语言名 + 复制条），思考块可折叠；**本期不做 KaTeX**；**用户消息仍纯文本**（保持原样、不被 Markdown 影响）。
  - **选型与安全（正文＝LLM 输出，恒不可信）**：① **react-markdown v9** 把 Markdown→AST→React 元素，**不启用 rehype-raw、无 `dangerouslySetInnerHTML`**，故裸 `<script>`/`<img onerror>` 一律当文本转义——天然免疫注入；链接 href 走其默认 `urlTransform` 净化（挡 `javascript:`/`data:`）。② 高亮选 **highlight.js（rehype-highlight，纯 JS class 主题）而非 Shiki**——因 CSP `script-src 'self'` 无 `wasm-unsafe-eval`，Shiki 的 WASM 会被拦；highlight.js 无 WASM/无内联脚本，契合现有 CSP。③ 外链统一 `target=_blank`→被主进程既有 `setWindowOpenHandler`（`main/index.ts:50`）拦下走 `shell.openExternal` 系统浏览器，**零新增 IPC**。
  - **流式性能**：`MessageRow` 包 `React.memo`（`(prev,next)=>prev.msg===next.msg`）——store 的 `updateLastAssistant` 只替换最后一条消息对象、其余引用稳定，故流式期只有「正在生长的那条消息」重渲染/重解析，历史消息全跳过；`Markdown` 组件亦按 `text` memo 化。
  - **落地文件**：新建 `src/renderer/src/features/chat/Markdown.tsx`（`Markdown` 组件 + `CodeBlock` 复制条 + `components` 覆写表：`a` 加 `target=_blank`、`pre` 解包避免双层 `<pre>`、`code` 按「有 `language-` 类名 or 含换行」判围栏块 vs 行内）。改 `ChatView.tsx`（text 块 `<div class="msg__text"><Markdown/></div>`；新增可折叠 `ThinkingBlock`〔`ChevronRight` 箭头旋转、默认展开、思考正文 `<Markdown muted/>`〕；`MessageRow` 包 memo；用户消息分支仍 `<p pre-wrap>` 不变）。`package.json` 加 3 依赖（react-markdown@9.1.0 / remark-gfm@4.0.1 / rehype-highlight@7.0.2，类型均经 `exports`）。`tsconfig.web.json` 加 `"moduleResolution":"bundler"`（这三个 ESM-only 包类型只经 `exports` 暴露，旧 `node` 解析取不到；`bundler` 是 Vite 渲染层正解、仅改 web 侧）。`i18n/messages.ts` zh/en 各加 `chat.md.{copy,copied}`。`styles/app.css`：加 `.md*`（正文排版：p/标题/列表/表格〔横向可滚〕/引用/hr/链接/任务列表，均用 token）、`.md-inline`（行内代码）、`.md--muted`（思考块弱化）、`.md-code*`（代码块头/语言名/复制钮/正文横滚）、`.hljs-*`（VS Code Light+/Dark+ 双套调色板，明色挂 `.md-code`、暗色挂 `:root[data-theme='dark'] .md-code` 覆盖）；`.msg__think` 改造为可折叠（`.msg__think-head` 按钮 + `.msg__think-caret` 旋转 + `.is-open` + `.msg__think-body`）。
  - **已验证**：`typecheck`(node+web) + `build` 全绿；2070 模块编译通过（含新增三依赖），渲染层 bundle 1.57MB（highlight.js 内置多语言所致，Electron 本地无网络成本、可接受，后续如需可换 `lowlight` 按需注册语言瘦身）。
  - **v1 边界 / 待人工回归**：① **不做数学公式**（KaTeX 未接，`$...$` 按普通文本）；② 用户消息保持纯文本；③ highlight.js 全量语言进包（体积换零配置）。人工：真机 `pnpm dev`→配 key→让 Agent 回复含标题/列表/表格/围栏代码块/行内代码/链接的内容→应见排版正确、代码块带语言名+复制钮（点击复制、图标转「已复制」）、明暗主题下高亮配色随切、外链点击走系统浏览器；思考块可点击折叠/展开、箭头旋转。**用完 `taskkill //F //IM electron.exe`**。

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
