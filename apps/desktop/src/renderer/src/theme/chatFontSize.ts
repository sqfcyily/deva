/**
 * 文字大小（设置 → 通用）：小 / 标准 / 大 / 特大，只缩放对话内容。
 * - 存 ~/.deva/config.json 的 `chatFontSize`；缺省或无效值按「标准」。
 * - 生效方式：写 <html data-chat-fs>，倍率定义在 tokens.css（--chat-scale），
 *   对话区（redesign.css 的 .cf-msgs / .cf-draft）取作 --cs 参与字号计算。
 * 启动时在首帧渲染前调用 applyChatFontSize(readChatFontSize())，避免先按标准字号闪一下。
 */

export type ChatFontSize = 'sm' | 'md' | 'lg' | 'xl'

export const CHAT_FONT_SIZES: readonly ChatFontSize[] = ['sm', 'md', 'lg', 'xl']

function isChatFontSize(v: unknown): v is ChatFontSize {
  return typeof v === 'string' && (CHAT_FONT_SIZES as readonly string[]).includes(v)
}

/** 从 config.json 同步读取（首帧用）；config 不可用（如纯 web 预览）时按标准。 */
export function readChatFontSize(): ChatFontSize {
  try {
    const v = window.deva?.config?.getSync()?.chatFontSize
    if (isChatFontSize(v)) return v
  } catch {
    /* config 不可用时回退标准 */
  }
  return 'md'
}

/** 应用到页面：标准不写属性，其余写 data-chat-fs。 */
export function applyChatFontSize(size: ChatFontSize): void {
  const root = document.documentElement
  if (size === 'md') root.removeAttribute('data-chat-fs')
  else root.setAttribute('data-chat-fs', size)
}

/** 立即生效并落盘。 */
export function saveChatFontSize(size: ChatFontSize): void {
  applyChatFontSize(size)
  void window.deva?.config?.set({ chatFontSize: size })
}
