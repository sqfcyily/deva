import { ChatFirstShell } from './redesign/ChatFirstShell'

/**
 * 应用根组件：渲染「对话优先」外壳。
 *
 * 旧的 IDE 式外壳（AppShell + 活动栏/侧边面板/底部终端/状态栏等）已整体下线删除，
 * 只保留对话优先形态；相关 store（ui/git）与演示数据一并移除。
 */
export function App(): React.JSX.Element {
  return <ChatFirstShell />
}
