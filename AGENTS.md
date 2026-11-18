# AGENTS.md

## 提交信息

提交信息使用中英双语，标题格式：

```
<type>(<scope>): <中文说明> / <English description>
```

- **type**：从 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`chore`、`ci` 中选择；scope 可省略。
- **顺序**：中文说明在前，英文说明在后，用 ` / `（斜杠前后各一个空格）分隔，两部分表达同一含义。
- **中文说明**：简洁陈述做了什么，句末不加标点。
- **英文说明**：以小写的动词原形开头（如 add、fix、update、remove），句末不加句号。
- **长度**：标题只占一行。因含两种语言，不受 72 字符限制，但两部分各自应尽量精炼（中文约 30 字以内，英文约 70 字符以内）。
- **正文**：改动较复杂时，空一行后分点说明，每点同样采用「中文 / English」格式。简单改动不写正文。
- **破坏性变更**：在 type 后加 `!`，如 `feat!: …`。
示例：

```
feat: 新增 present_files 工具与交付卡，支持向用户交付成品文件 / add present_files tool and deliverables card for delivering output files
```

```
fix: 修复交付重复路径时模型反复重试的问题 / fix repeated retries when delivering duplicate paths
```

```
feat: 新增回复完成与等待输入的系统通知 / add system notifications for reply completion and pending input

- 窗口未在前台时，回复完成或需要确认后弹出系统通知 / show a system notification when a reply completes or needs input while the window is in the background
- 点击通知跳转到对应对话 / clicking the notification opens the conversation
```

## 代码组织

以下路径均相对 `apps/desktop/src/`。

- **文件大小**：源文件超过约 800 行时，新功能放进新模块，不再往里追加；i18n 词条等数据表除外。拆分已有大文件要单独提交，不和功能改动混在一起。
- **函数大小**：函数超过约 150 行或包含多个阶段时，按阶段拆成具名函数。
- **共用代码放 `shared/`**：主进程、preload、渲染层共用的类型和逻辑只写一份；对话协议类型统一放在 `shared/chat-protocol.ts`。
- **新增工具**：在 `main/services/tool-catalog.ts` 登记，在 `main/services/tools.ts` 的 `toolHandlers` 里加处理函数；需要在闸门前处理的，加进 `main/services/agent-loop.ts` 的 `loopTools` 表，不要在循环里写 if/else 特判。
- **会话状态**：多个模块共用的放在 `main/services/chat-state.ts`，只有一个模块用的留在那个模块里。
- **改写会话历史的操作**（删轮、压缩、回滚、开始回合）要先检查 `historyLocked()`。
- **配置类文件写盘**用 `writeFileAtomic()`（`main/services/atomic-write.ts`）。
- **渲染层**：外壳的新功能单独建文件放进 `renderer/src/redesign/`，`ChatFirstShell.tsx` 只负责组合；读对话状态时用范围最小的 `useChatActions` / `useChatState` / `useChatStream`。
