# Deva Web 网关（网页端）

用手机或其他电脑的浏览器，继续桌面端 Deva 里正在进行的对话。

> 这是「合并进桌面端之前」用来验证网页交互的独立实现。桌面端将来自己做 Web 通道时，
> `web/index.html` 这一套界面与交互可以直接搬过去（见文末「与桌面端的关系」）。

## 它做什么

```
手机浏览器 ──HTTP(带密钥)──> 本网关 ──CDP(回环)──> 已运行的 Deva 渲染层 window.deva.chat
                                                        │
                                                  主进程跑回合 / 落盘
```

Deva 的回合由主进程执行，只读 `~/.deva/data/chats/*.json` 只能看历史、发不出消息。所以这里把渲染层的
`window.deva.chat` 当控制面板：权限闸门、工具、检查点、落盘全走原有那一套，和你在桌面敲字发出去是同一条路。

## 界面能力

| 能做 | 说明 |
|---|---|
| 会话列表 | 角色头像、右上角角色名、未读完成红点、正在跑的会话 |
| 继续对话 | 流式回复、实时秒数、当前执行步骤 |
| 交互卡 | 问答卡（单选/多选/必答/可跳过）、计划审批、挂载请求 |
| 编辑区 | 新建会话、切模型、切思考强度、挂载工作目录 |
| 附件 | 图片/文件上传（走 Deva 自己的授权通道）、历史图片查看 |
| 交付文件 | 文件卡、文本/图片/PDF 预览、下载 |
| 管理 | 长按（或右键）：新建、重命名、归档、删除 |

## 启动

```bash
# 1. 先用带调试参数的方式启动 Deva（调试接口只在启动时开放）
#    Windows:  Deva.exe --remote-debugging-port=0
#    端口会写进 %APPDATA%\@deva\desktop\DevToolsActivePort

# 2. 启动网关
node apps/desktop/web-gateway/server.js
# 打印 http://<局域网IP>:8765/?key=<密钥>
```

密钥存 `~/.deva/remote-key.txt`（不存在会自动生成）。

## 为什么用 CDP 驱动渲染层

这是独立实现阶段的取舍，不是最终形态：

- 好处：完全复用桌面端行为，不需要在 Deva 里新开服务，交互和桌面一致
- 代价：需要带调试参数启动、依赖渲染层内部 API（Deva 大改 IPC 会失效）、要单独维护一个常驻进程

进桌面端后这些代价都没有了，见下文。

## 与桌面端的关系

这套东西的价值主要在 `web/index.html`（一套完整的手机端界面）：渲染块结构、问答卡状态机、
处理条与实时计时、手机端布局、附件与交付文件预览。这些和「从哪个通道进来」无关——
换成桌面端内部的 IPC 调用，界面层可以原样复用。

`server.js` / `deva.js` 是外部驱动层（CDP 附加、端口发现、断线重连、SSE 转发），
进桌面端后应由内部通道替代。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 网页（`?key=` 校验，成功后种 cookie） |
| GET | `/api/events` | SSE：回合事件、会话状态、连接状态 |
| GET | `/api/sessions` | 会话列表（含 `effort`、`running`、`completedAt`） |
| GET | `/api/session?id=` | 会话详情（消息、turnId、startedAt、inflight、交付引用） |
| POST | `/api/send` | 发消息（`text` + `attachments` 绝对路径） |
| POST | `/api/abort` | 停止当前轮 |
| POST | `/api/insert` | 插入当前轮（排队，模型下一步读到） |
| POST | `/api/withdraw-inserts` | 撤回未送达的插入 |
| POST | `/api/answer` | 回应问答卡 |
| POST | `/api/plan` | 计划审批 |
| POST | `/api/mount-response` | 挂载请求应答 |
| POST | `/api/new-session` | 新建会话 |
| POST | `/api/set-model` `/api/set-effort` `/api/set-focus` | 改模型 / 思考强度 / 工作目录 |
| POST | `/api/rename` `/api/archive` `/api/delete` | 重命名 / 归档 / 删除 |
| POST | `/api/asset-stage` | 附件授权（转调渲染层 `fs.pasteAttachment`） |
| GET | `/api/message-image` | 历史消息里的图片 |
| GET | `/api/deliverables` `/api/deliverable-content` `/api/deliverable-raw` | 交付文件 |
| GET | `/api/dirs` | 目录浏览（挂载用） |
| GET | `/api/models` `/api/personas` `/api/avatar` | 模型 / 角色 / 角色头像 |

## 已知限制

- 需要 Deva 带 `--remote-debugging-port=0` 启动（或等价参数），否则接不上
- 依赖渲染层暴露的 `window.deva.chat`，Deva 改内部接口可能失效
- Word / Excel / PowerPoint 只能下载，不能在线预览
- 插入不支持附件（Deva 本身没有这条通路）
- 头像来自渲染层已渲染的 Humation SVG，未渲染过的角色显示首字占位
