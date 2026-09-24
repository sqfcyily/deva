import DEVA from "./deva-personas"
import XIAOMAJIANG from "./xiaomajiang-personas"

/**
 * 默认角色（首启种子 persona）定义——**各角色及其提示词集中在此、彼此独立**。
 *
 * 每条默认角色是一个自包含的 `DefaultPersona` 常量（含身份、主题色、开场白、提示词等），
 * 由 `DEFAULT_PERSONAS` 数组收拢；`personas.ts` 的 `ensureSeededPersonas()` 首启时逐条种入
 * `~/.deva/personas/<id>.md`（按 id 幂等、防「删除后复活」、支持将来只补种新增的那条）。
 *
 * **新增一个默认角色**：在下方照葫芦画瓢写一个 `const XXX: DefaultPersona`（连同其提示词），
 * 再追加到文末的 `DEFAULT_PERSONAS` 数组即可——无需改动 `personas.ts` 的种入逻辑。
 *
 * 约定：
 * - `id` 稳定不变（文件名 / 启用态键 / 头像确定性种子）；显示名走 `name`，可后续改。
 * - `avatar` 省略（留空）→ 由 id 确定性生成一枚稳定 Humation 头像（用户可在编辑器改）。
 * - `prompt` 只是**附加系统提示词**（性格 / 语气 / 行文风格）；安全与工具铁律恒优先，见 chat.ts。
 */
export interface DefaultPersona {
  /** 文件名（去 .md），稳定身份。 */
  id: string
  /** 显示名。 */
  name: string
  /** 专长，一句话。 */
  description: string
  /** 开场白 / 口头禅。 */
  tagline: string
  /** 首次种入时是否启用（默认角色皆 true，作为可直接对话的身份）。 */
  enabled: boolean
  /** 偏好模型 `"providerId:modelId"`；省略 = 跟随全局默认。 */
  model?: string
  /** 工具白名单（内置 / MCP 名）；省略 = 允许全部内置工具。 */
  tools?: string[]
  /** 头像 spec（Humation AvatarSpec JSON）；省略 → 由 id 确定性生成。 */
  avatar?: string
  /** 追加进主智能体系统提示词的正文（性格 / 语气 / 行文风格）。 */
  prompt: string
}

/**
 * 全部默认角色（首启逐条种入）。数组顺序 = 首次种入顺序（也是新用户花名册的初始默认排序，
 * 用户之后可拖拽 / 置顶改写，见 personas.ts 的 order 机制）。
 */
export const DEFAULT_PERSONAS: DefaultPersona[] = [DEVA, XIAOMAJIANG]
