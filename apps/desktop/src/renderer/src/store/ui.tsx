import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * 全局 UI 状态。
 * - activeView：左侧活动栏选中项，决定中央区显示什么内容。
 * - 各视图的当前选中项（数据表 / 主机），由侧边导航设置、中央区消费。
 * 项目与文件（真实数据）已迁移至 store/workspace；Git 选中态已迁至 store/git。
 * DB/SSH 仍为演示数据，待后续阶段接入。
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
  // 各视图选中项（演示数据）
  selectedTable: string | null
  selectTable: (id: string) => void
  selectedHost: string | null
  selectHost: (id: string) => void
}

const UIContext = createContext<UIContextValue | null>(null)

export function UIProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [activeView, setActiveView] = useState<ActivityView>('chat')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [panelVisible, setPanelVisible] = useState(false)

  const [selectedTable, setSelectedTable] = useState<string | null>('users')
  const [selectedHost, setSelectedHost] = useState<string | null>('prod-web-01')

  const value = useMemo<UIContextValue>(
    () => ({
      activeView,
      setActiveView,
      sidebarVisible,
      toggleSidebar: () => setSidebarVisible((v) => !v),
      panelVisible,
      togglePanel: () => setPanelVisible((v) => !v),
      selectedTable,
      selectTable: setSelectedTable,
      selectedHost,
      selectHost: setSelectedHost
    }),
    [activeView, sidebarVisible, panelVisible, selectedTable, selectedHost]
  )

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>
}

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext)
  if (!ctx) throw new Error('useUI 必须在 UIProvider 内使用')
  return ctx
}
