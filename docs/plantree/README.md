# Plan Tree

Deva 的规划状态根。架构与长效知识（模块契约、不变量、失效语义）的权威在 `llmdoc/`（用 `npx -y @tokenroll/llmdoc search/tree` 检索）；本目录只管**规划状态**：路线图、进行中的方案、决策、未决问题、落地证据。

## 权威顺序

1. 代码事实 → 源码
2. 架构/契约知识 → `llmdoc/`
3. 规划/进行中工作 → 本目录（各 Plan root 自治）
4. 历史/归档 → 各 Plan 的 `history/`

## Baseline

`baseline/README.md` — 模块键映射（Plan 的 Affected Modules 用）与 llmdoc 检索入口。runtime/storage/测试发布门等全局上下文不在此复制，直接链到 llmdoc 对应文档。

## 活跃 Plans

| ID | Plan | Affected Modules | Status | Current Phase | Last Landed | Next Target |
|---|---|---|---|---|---|---|
| P001 | [角色导出/导入](plans/001-persona-export-import/) | main-personas, main-ext-roles, main-avatar-image, preload-ipc, renderer-shell | Implemented | 已提交（c42f180）+ llmdoc 已同步 | 2026-11-19 dfc012b | 用户 GUI 手工回环；推送上游由用户定 |

## 读取路径

新会话接手：读本 README → 目标 Plan 的 `README.md` → `roadmap.md` → 标注的 topic/decisions/open-questions。
