/**
 * 内置浏览器的界面状态（主进程 host.ts 推送，主窗口的胶囊与「Deva 浏览器」窗口的外框共用）。
 */

/** 请用户在网页上亲自操作的原因。 */
export type BrowserHandoffReason = 'login' | 'captcha' | 'upload' | 'confirm' | 'other'

export interface BrowserUiTab {
  id: string
  /** 打开它的对话。 */
  sessionId: string
  /** 该对话的角色（标签上显示其头像）。 */
  personaId?: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface BrowserUiState {
  /** 窗口是否展开在屏幕上（收起时在屏幕外继续运行）。 */
  open: boolean
  pinned: boolean
  /** 窗口里当前显示的标签。 */
  active: string | null
  tabs: BrowserUiTab[]
  /** 各对话的当前标签。 */
  current: Record<string, string>
  /** Deva 正在操作：对话 → 标签、动作（同 browser 工具的 action）、对象（网址 / 元素名）。 */
  operating: Record<string, { tab: string; action: string; label?: string }>
  /** 等用户在网页上操作：对话 → 标签、原因、模型给的说明。 */
  handoff: Record<string, { tab: string; reason: BrowserHandoffReason; message: string }>
}

/** 预览卡实时画面的一帧（主进程经 browser:live-frame 推给主窗口）。 */
export interface BrowserLiveFrame {
  tab: string
  /** JPEG 的 base64。 */
  data: string
}

/** 浏览器外框各部分高度（主进程按它摆放网页视图，外框 CSS 须一致）。不显示网址，所以没有地址栏。 */
export const BROWSER_CHROME = {
  tabBar: 40,
  statusBar: 36,
  /** 网页四周留出的边距：Deva 操作时外框在这里画主题色边框。 */
  frame: 2
} as const
