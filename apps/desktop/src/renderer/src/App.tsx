import { AppShell } from './layout/AppShell'
import { ChatFirstShell } from './redesign/ChatFirstShell'

/**
 * 应用根组件。
 *
 * 正在预览「对话优先」新外壳原型（redesign/，纯界面无后端）。
 * 旧的 IDE 式外壳 AppShell 原封保留，把开关改成 false 即可一键还原。
 */
const PREVIEW_CHAT_FIRST = true

export function App(): React.JSX.Element {
  return PREVIEW_CHAT_FIRST ? <ChatFirstShell /> : <AppShell />
}
