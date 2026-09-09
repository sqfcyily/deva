import {
  MessagesSquare,
  Files,
  GitBranch,
  Database,
  Server,
  Blocks,
  Settings,
  type LucideIcon
} from 'lucide-react'

// 中央工作区视图
import { ChatView } from './chat/ChatView'
import { EditorView } from './explorer/EditorView'
import { GitDiffView } from './git/GitDiffView'
import { TableDataView } from './database/TableDataView'
import { SshSessionView } from './ssh/SshSessionView'
import { ExtensionsView } from './extensions/ExtensionsView'
import { SettingsView } from './settings/SettingsView'
// 侧栏导航
import { ChatSessionsPanel } from './chat/ChatSessionsPanel'
import { ExplorerPanel } from './explorer/ExplorerPanel'
import { GitPanel } from './git/GitPanel'
import { DatabasePanel } from './database/DatabasePanel'
import { SshPanel } from './ssh/SshPanel'
import { ExtensionsPanel } from './extensions/ExtensionsPanel'

export type FeatureScope = 'project' | 'global'
export type FeaturePlacement = 'top' | 'bottom'

/**
 * 一个「功能贡献」——左侧活动栏的一项及其侧栏/中央视图。
 * 这是 Deva 的内部可插拔接缝：布局层只认这份契约，不认具体功能。
 */
export interface FeatureContribution {
  /** 唯一标识，同时作为 UI 的 activeView 取值 */
  id: string
  /** 活动栏图标 */
  icon: LucideIcon
  /** 标题的 i18n key（tooltip / aria-label） */
  titleKey: string
  /** 活动栏排序，升序 */
  order: number
  /** 活动栏位置：顶部（默认）或底部（如设置） */
  placement?: FeaturePlacement
  /**
   * 作用域：project 随项目切换，global 全局共享（切项目不变）。
   * 目前是声明式元数据，供后续「项目切换」逻辑与未来插件系统消费。
   */
  scope: FeatureScope
  /** 侧栏导航组件；省略则该视图无侧栏（侧栏折叠） */
  Sidebar?: React.FC
  /** 中央工作区组件 */
  Center: React.FC
}

/**
 * 功能贡献注册表 —— 左侧活动栏的每个功能在此登记。
 *
 * 新增功能 = 加一条目（+其组件 import）；删除 = 删一条目。
 * ActivityBar / SidePanel / CenterView 全部从本表渲染，不再硬编码 switch。
 * 为将来的第三方插件系统预留了「贡献点」形状，见 docs/next-session.md。
 */
export const featureContributions: FeatureContribution[] = [
  {
    id: 'chat',
    icon: MessagesSquare,
    titleKey: 'activity.chat',
    order: 10,
    scope: 'project',
    Sidebar: ChatSessionsPanel,
    Center: ChatView
  },
  {
    id: 'explorer',
    icon: Files,
    titleKey: 'activity.explorer',
    order: 20,
    scope: 'project',
    Sidebar: ExplorerPanel,
    Center: EditorView
  },
  {
    id: 'git',
    icon: GitBranch,
    titleKey: 'activity.git',
    order: 30,
    scope: 'project',
    Sidebar: GitPanel,
    Center: GitDiffView
  },
  {
    id: 'database',
    icon: Database,
    titleKey: 'activity.database',
    order: 40,
    scope: 'global',
    Sidebar: DatabasePanel,
    Center: TableDataView
  },
  {
    id: 'ssh',
    icon: Server,
    titleKey: 'activity.ssh',
    order: 50,
    scope: 'global',
    Sidebar: SshPanel,
    Center: SshSessionView
  },
  {
    id: 'extensions',
    icon: Blocks,
    titleKey: 'activity.extensions',
    order: 60,
    scope: 'global',
    Sidebar: ExtensionsPanel,
    Center: ExtensionsView
  },
  {
    id: 'settings',
    icon: Settings,
    titleKey: 'activity.settings',
    order: 100,
    placement: 'bottom',
    scope: 'global',
    Center: SettingsView
  }
]

const byId = new Map(featureContributions.map((c) => [c.id, c]))

/** 按 id 取贡献 */
export function getContribution(id: string): FeatureContribution | undefined {
  return byId.get(id)
}

const ordered = [...featureContributions].sort((a, b) => a.order - b.order)

/** 活动栏顶部项（升序） */
export const topContributions = ordered.filter((c) => (c.placement ?? 'top') === 'top')
/** 活动栏底部项（升序），如「设置」 */
export const bottomContributions = ordered.filter((c) => c.placement === 'bottom')
/** 默认视图 id（首个贡献） */
export const defaultViewId = ordered[0]?.id ?? 'chat'
