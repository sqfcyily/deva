# Topic · 导出/导入设计（v2 能力包，已定稿）

依据：[decisions/001-bundle-basics.md](../decisions/001-bundle-basics.md)（D1–D5）+ [decisions/002-bundle-scope.md](../decisions/002-bundle-scope.md)（Q4 判读）。实现前若这两份决策被推翻，先改决策再改本文。

## 包格式（deva-persona-bundle，format 1）

```
<name>.devapersona.zip
├─ manifest.json
├─ persona.md                     ← ~/.deva/personas/<id>.md 磁盘原文（字节同构）
├─ avatar.webp|png|jpg            ← 可选；有自定义头像才打进来
├─ knowledge/<originalId>/…       ← 可选；知识库整目录（issue#65 档 0 约定）
├─ skills/<skillId>/…             ← 专属技能整目录（SKILL.md + 参考文档/脚本）
└─ mcp.json                       ← 专属 MCP 条目 + 解密后秘密值（见下）
```

manifest.json：

```json
{
  "kind": "deva-persona-bundle",
  "format": 1,
  "exportedAt": "2026-11-19T…",
  "appVersion": "0.1.16",
  "originalId": "<导出方文件 id>",
  "contents": { "skills": ["<skillId>…"], "mcp": ["<mcpId>…"], "knowledge": true|false }
}
```

- persona.md **保持现有工件格式不变**，frontmatter 不加键（D5）。
- mcp.json 为包内私有形态（非 `~/.deva/mcp.json` 原样拷贝）：每条目含原配置字段，`{secretRef}` 占位替换为解密明文值（`secrets.json → mcp:<id>:<field>` 经 getSecret 解出）。**明文秘密进包是用户明示接受的风险**；导入后立即重加密进本机 secrets.json，包内不落残留。
- zip 用 fflate `zipSync`（已有依赖）；限额：总量 30MB / 单文件 10MB / 文件数 500（技能目录可能带多文件；头像硬上限 2MB 已在 avatar-image.ts）。

## 导出流程（persona-port.ts）

1. 入口 `personas:export(id)`：`getPersona(id)`；**内置 id（general/xiaomajiang）直接拒绝**（D2）。
2. 收集从属内容（002 决策）：
   - 技能：遍历 `listSkills()`，`getRoles('skills', skillId)` 含该 id 者 → 整目录 `cpSync` 进包；
   - MCP：`getRoles('mcp', mcpId)` 含该 id 者 → 配置条目 + 逐字段解密秘密 → 包内 mcp.json；
   - 知识库：`existsSync(knowledge/<id>/)` → 整目录进包；
   - 头像：`readAvatarImage(avatarsDir(), id)` → 还原字节与扩展名。
3. 组 manifest → `dialog.showSaveDialog`（默认文件名 `<name>.devapersona.zip`）→ 写盘。
4. 只读操作全程；导出不改任何本地状态。

## 导入流程（persona-port.ts）

1. `personas:import(paths)`：解包校验 kind/format、zip-slip 段守卫、限额；manifest.contents 声明哪些从属内容在包里。
2. **id 判定序（D1+D3）**：
   - `<originalId>.md` 不存在且 isSafeId 通过 → **沿用原 id 新建**，记簿记；
   - 存在且 `config.json → personas.imports[该id].originalId === originalId`（或该 id 本身相等即视为同源）→ **就地更新**，UI 先提示「将更新已导入的角色」；
   - 存在但簿记不匹配（撞了别的角色）→ `makeId(name)` 铸新 id 新建，记簿记；
   - originalId 不过 isSafeId（外来/手改包）→ 直接铸新 id。
   - 内置 id 永远走铸新 id 分支（D2 兜底，即便簿记异常也不可能落到 general/xiaomajiang）。
3. 落盘顺序：`upsertPersona`（默认关，D5 不动 enabled）→ 头像 `writeAvatarImage(新id)` → 知识库目录落 `knowledge/<最终id>/`（铸了新 id 则整目录改名）。
4. 随包技能：整目录落 `~/.deva/skills/`；id 冲突 → 按技能模块的 id 规则铸新目录名；`setRoles('skills', 最终skillId, [最终角色id])`（导入后仅该角色可用，不保留原多角色分配）。
5. 随包 MCP：条目合并进 `~/.deva/mcp.json`；秘密字段明文 → 走既有 setSecret 重加密进 secrets.json；id 冲突 → 铸新 id；`setRoles('mcp', …, [最终角色id])`；**enabled=true**（002 决策：导入即显式意图）。
6. 结果摘要回渲染层：`{ persona, idMap: {skills, mcp}, updated: bool, warnings[] }`（秘密明文绝不进摘要与日志）。
7. 簿记：`setConfig({ personas: { imports: { [finalId]: { originalId, bundleHash } } } })`，读-合并式写入（config 顶层浅合并，别清空既有子对象——R3 教训在 personas.ts 种子逻辑有先例）。

## 实现落位（AGENTS.md 约定）

- **新模块** `apps/desktop/src/main/services/persona-port.ts`（personas.ts 已 515 行，端口逻辑约 300+ 行会破 800 红线）。personas.ts 需把私有 `personasDir()/avatarsDir()` 改导出——这是硬编码目录的**收拢**（全仓库只此一处拼路径），不是新增字面量。
- skills.ts 的导入限额/zip-slip 守卫函数若可复用则抽到共享位置（同是 `~/.deva` 下的 zip 入口，两处维护一份）；复用不动技能行为。
- IPC：`personas:export(id)`、`personas:import(paths)` 注册进 personas.ts `registerPersonasIpc` 或 persona-port 自己注册；preload `personas` 桥补两个方法。
- UI：Rail 右键菜单「导出…」（内置灰显）+ BotsPane「导入…」（D4）；i18n 中英文案。
- 知识库目录名 `<id>` 在 personas/knowledge/ 下——与角色扫描互不干扰（目录扫描只认顶层 *.md，已有约定）。

## 验证路径

1. `pnpm typecheck`
2. **回环**：造带专属技能（多文件）+ 专属 MCP（带 secret）+ 知识库的角色 → 导出 → 删除 → 导入 → id 不变（簿记删了？注意：删除角色时应同步删 imports 簿记，纳入 deletePersona 级联）→ 全部内容一致、MCP 可连接、技能仅该角色可见、手机端可见。
3. **跨机模拟**：`DEVA_HOME=<新临时目录>` 启动 → 导入 → 原 id 新建、秘密重加密、ext-roles 指向新角色。
4. **更新路径**：同包改 persona.md 再导出 → 再导入 → 提示更新 → 内容覆盖、无重复角色。
5. **冲突路径**：先手建同 id 假角色 → 导入 → 铸新 id，假角色不动。
6. **坏包**：截断 zip / 假 manifest / zip-slip / 超限 → 结构化报错，无半写。
7. 内置角色：导出被拒；手改包内 originalId=general → 导入铸新 id，种子文件原样。
