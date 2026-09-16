import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * 全局 UI 状态：活动栏选中项与面板显隐。
 * 项目与文件（真实数据）在 store/workspace；Git 选中态在 store/git。
 */

/**
 * 活动视图 id。取值由功能贡献注册表（features/registry）登记，
 * 故此处用 string 而非写死联合类型——保持 store 与具体功能解耦、避免导入环。
 */
export type ActivityView = string

interface UIContextValue {
  // 视图
  activeView: ActivityView
  setActiveView: (v: ActivityView) => void
  // 面板显隐
  sidebarVisible: boolean
  toggleSidebar: () => void
  panelVisible: boolean
  togglePanel: () => void
}

const UIContext = createContext<UIContextValue | null>(null)

export function UIProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [activeView, setActiveView] = useState<ActivityView>('chat')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [panelVisible, setPanelVisible] = useState(false)

  const value = useMemo<UIContextValue>(
    () => ({
      activeView,
      setActiveView,
      sidebarVisible,
      toggleSidebar: () => setSidebarVisible((v) => !v),
      panelVisible,
      togglePanel: () => setPanelVisible((v) => !v)
    }),
    [activeView, sidebarVisible, panelVisible]
  )

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>
}

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext)
  if (!ctx) throw new Error('useUI 必须在 UIProvider 内使用')
  return ctx
}
