# Deva · 续作入口（next-session）

> 每阶段留「双绿」：`pnpm typecheck && pnpm build`。无测试运行器，验证靠双绿 + 纯函数走查。
> 「免装铁律」：不新增运行时依赖、优先纯 JS（Git 功能对系统 git 的依赖是唯一经确认例外）。

## 当前里程碑：定时任务 / 自动任务（Scheduled / Automated Tasks）——**P0–P4 代码级全部完成，双绿**

计划：`~/.claude/plans/linear-kindling-nest.md`（已批准）。核心铁律：**创建时批准、执行时零交互**
（授权信封在任务创建前一次性议定；触发执行绝不再弹权限框 / `ask_user` / `exit_plan`）。

### 已落地（全部 `pnpm typecheck && pnpm build` 双绿）

- **P0 地基**：`services/schedule.ts`（纯 JS cron 引擎 + `nextRun` + DST 用 `Intl.DateTimeFormat`）、
  `services/tasks.ts`（内存 Map + 懒加载 + 原子回写 + `registerTasksIpc`）、`services/tasks-types.ts`；
  持久化 `~/.deva/tasks.json`；preload `tasks` 命名空间。
- **P1 密封无头执行 + 调度器**：`chat.ts` 加 `interactive:false` 密封轮 + `runScheduledTask`；
  `services/sealed.ts` 的 `sealedDecision`（安全地板 Tier-1/Tier-2/危险命令不可被信封抹除；写入仅限
  非空 `authRoot` 内；未知工具一律 deny-and-report，绝不挂起 / 绝不静默放行）；
  `model-resolve.ts` 的 `resolveDefaultModel()`；`services/scheduler.ts`（30s tick + 串行队列 +
  追赶只补跑最近一次 + 指数退避 + 达阈值自动暂停）。
- **P2 创建时授权**：`tools.ts` 的 `create_task` spec + 零写盘 handler（惰性提议，入 `READ_TOOLS`，
  且从 `buildSubagentTools` 与 `buildSealedTools` 双双排除——任务不得再造任务）；`chat-store.ts` 的
  `autotasks` 边车；`chat.ts` 的 `chat:resolve-autotask` IPC（`create` 即密封授权时刻）；
  渲染层 `autotaskcard` 块 + `features/chat/TaskConfirmCard.tsx` 可编辑信封名片。
- **P3 定时任务标签页**：`store/tasks.tsx`（`TasksProvider`/`useTasks`，订阅 `tasks:changed`）；
  `ChatFirstShell` 第三标签 `tasks` + `TasksPane`/`TaskRow`（按状态分组、日程预览、暂停/恢复/立即运行/
  打开会话/删除）+ 独占会话行 ⏰ 徽标；i18n `tasks.*` 管理串 + `cf.tabTasks`。
- **P4 托盘 + 生命周期 + 通知**（本次）：
  - `services/tray-icon.ts`——**运行期用内置 `zlib` 手写最小 PNG 生成时钟图标 → `nativeImage`**
    （不走 electron-vite `?asset`，规避二进制资产 + 类型声明 + 打包路径问题，纯 JS 合免装铁律）；
    应用窗口与托盘共用。
  - `build/icon.ico`——256×256 PNG 内嵌 ICO 容器（一次性脚本生成，已删脚本）；`electron-builder.yml`
    的 `win.icon` 已解注（`pnpm build`=electron-vite 不读此文件，仅打包 `electron-builder` 用）。
  - `index.ts`——**单实例锁** `requestSingleInstanceLock` + `second-instance` 唤起窗口（无锁 = 双调度器
    = 双触发，正确性要求）；**关窗驻留托盘** `mainWindow.on('close')` + 模块级 `isQuitting`（win32
    `config.closeToTray!==false` 默认驻留，其它平台仅显式 true 才驻留）；`before-quit` 置 `isQuitting`；
    **Tray** 菜单（显示 Deva / 定时任务概览〔发 `tasks:navigate {pane:'tasks'}`〕/ 退出）+ 左键切换可见。
  - `scheduler.ts`——`notify` 已实现 `Notification`；提醒类必弹、简报类按 `allowNotify` 弹、错误自动
    暂停弹一次；点击 → 聚焦窗口 + 发 `tasks:navigate {sessionId}`；`Notification.isSupported()` 假则降级。
  - preload——`tasks.onNavigate(cb)`；渲染层 `ChatFirstShell` 订阅之（`{sessionId}`→选中独占会话回消息视图，
    `{pane:'tasks'}`→切 Tasks 标签）；`GeneralPane` 加 win32-only「关窗驻留托盘」`Toggle`（读写 `config`）+
    i18n `settings.closeToTray{,Desc}`。

### 命名避坑（务必延续）

绝不复用「任务 / Task」（那是 `run_subagent` 的卡）。工具 `create_task`、渲染块 `autotaskcard`、
IPC 命名空间 `tasks:`、UI 文案统一「定时任务 / 自动任务」。`create_task` 从子智能体与密封工具集双双排除。

### 待办（本里程碑剩余）

- **端到端 GUI 真机回归**（需真机 + 真实模型密钥 + 运行应用；本环境无法跑 GUI）：
  1. 对话说「每天 10 点给我发今天的热点新闻」→ 模型调 `create_task` → `autotaskcard` 名片 → 编辑信封 +
     Confirm 才建任务与独占会话；Confirm 前零创建、Dismiss 不留任务。
  2. 建快触发测试任务（recurring `*/1 * * * *` 或 1 分钟后的 once）→ 关窗/隐藏时照常触发、向独占会话追加
     一轮、弹系统通知、点击聚焦并打开该任务会话；全程零弹窗。
  3. 托盘：关窗驻留、左键切换、「定时任务概览」切 Tasks 标签、「退出」彻底退出；单实例锁（二次启动只唤起）。
  4. 密封安全：验证任务执行中触到 Tier-1/Tier-2/危险命令被 deny-and-report（不挂起、不静默放行）。
- 打包侧未在本环境验证：`electron-builder` 实际打包读取 `build/icon.ico`（结构已校验合法：ICONDIR
  type=1 count=1，内嵌 PNG 签名正确）。

## 更早的主线与扩展系统进度

见 `~/.claude` 记忆索引（`deva-feature-phase.md`）：主线 Phase 0–4.13 + 扩展系统 P0–P4 + Phase8
技能创建体验重做均已代码完成双绿，整套 GUI 真机回归与 P5 打磨（自动重连/工具数告警/safeStorage 降级）待做；
主线下一步 Phase 5 数据库（mysql2/ioredis）。
