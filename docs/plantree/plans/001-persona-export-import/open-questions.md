# Open Questions · P001

原 Q1–Q6 已全部批复：Q1/Q2/Q3/Q5/Q6 → [decisions/001-bundle-basics.md](decisions/001-bundle-basics.md)；Q4 → [decisions/002-bundle-scope.md](decisions/002-bundle-scope.md)。

## 留观项（非阻塞）

1. **Q4 判读纠正窗口**：「从属角色」按「从属于角色的内容」判读（无角色层级机制）。若实意是「打包其他角色/递归子角色」，推翻 [decisions/002-bundle-scope.md](decisions/002-bundle-scope.md) 重议。
2. **知识库字段化联动**：issue#65 的 frontmatter `knowledge` 字段落地后，包格式需同步（manifest 声明 knowledge 目录 ↔ 字段指向），届时随 /llmdoc:update 一起核对。
3. **PR#49 落地联动**：角色默认工作区（`workspace` frontmatter 字段）落地后评估是否在包内记录（机器本地路径大概率仍不打包，只提示失效）。
