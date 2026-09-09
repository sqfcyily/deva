import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  seedSkills,
  seedMcp,
  seedSubAgents,
  type ExtKind,
  type Skill,
  type McpServer,
  type SubAgent
} from '../mock/extensions'

/**
 * 扩展配置（全局，与项目无关）：技能 / MCP 服务 / 子智能体。
 * 左侧面板选中某项 → 中央详情页展示与编辑；也可新建自定义项。
 * 外观阶段为内存状态，后续接入真实存储时替换本 Provider 的读写即可。
 */
type AnyExt = Skill | McpServer | SubAgent
type ExtPatch = Partial<Skill & McpServer & SubAgent>

export interface Selection {
  kind: ExtKind
  id: string
}

interface ExtensionsContextValue {
  skills: Skill[]
  mcp: McpServer[]
  subagents: SubAgent[]
  selected: Selection | null
  select: (kind: ExtKind, id: string) => void
  toggle: (kind: ExtKind, id: string) => void
  update: (kind: ExtKind, id: string, patch: ExtPatch) => void
  remove: (kind: ExtKind, id: string) => void
  add: (kind: ExtKind) => void
}

const ExtensionsContext = createContext<ExtensionsContextValue | null>(null)

let seq = 1

export function ExtensionsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>(() => seedSkills.map((s) => ({ ...s })))
  const [mcp, setMcp] = useState<McpServer[]>(() => seedMcp.map((s) => ({ ...s, tools: [...s.tools] })))
  const [subagents, setSubagents] = useState<SubAgent[]>(() =>
    seedSubAgents.map((s) => ({ ...s, tools: [...s.tools] }))
  )
  const [selected, setSelected] = useState<Selection | null>({ kind: 'skill', id: 'code-review' })

  const setterFor = (kind: ExtKind): React.Dispatch<React.SetStateAction<AnyExt[]>> => {
    if (kind === 'skill') return setSkills as React.Dispatch<React.SetStateAction<AnyExt[]>>
    if (kind === 'mcp') return setMcp as React.Dispatch<React.SetStateAction<AnyExt[]>>
    return setSubagents as React.Dispatch<React.SetStateAction<AnyExt[]>>
  }

  const patchList = (kind: ExtKind, id: string, fn: (item: AnyExt) => AnyExt): void =>
    setterFor(kind)((list) => list.map((it) => (it.id === id ? fn(it) : it)))

  const value = useMemo<ExtensionsContextValue>(() => {
    const makeNew = (kind: ExtKind): AnyExt => {
      const id = `${kind}-${seq++}`
      if (kind === 'skill') {
        return {
          id,
          name: '新技能',
          desc: '',
          trigger: '手动',
          instructions: '',
          source: 'custom',
          enabled: false
        } satisfies Skill
      }
      if (kind === 'mcp') {
        return {
          id,
          name: '新 MCP 服务',
          desc: '',
          transport: 'stdio',
          command: '',
          url: '',
          tools: [],
          source: 'custom',
          enabled: false
        } satisfies McpServer
      }
      return {
        id,
        name: '新子智能体',
        desc: '',
        model: 'claude-3-5-haiku',
        tools: [],
        prompt: '',
        source: 'custom',
        enabled: false
      } satisfies SubAgent
    }

    return {
      skills,
      mcp,
      subagents,
      selected,
      select: (kind, id) => setSelected({ kind, id }),
      toggle: (kind, id) =>
        patchList(kind, id, (it) => ({ ...it, enabled: !it.enabled }) as AnyExt),
      update: (kind, id, patch) => patchList(kind, id, (it) => ({ ...it, ...patch }) as AnyExt),
      remove: (kind, id) => {
        setterFor(kind)((list) => list.filter((it) => it.id !== id))
        setSelected((cur) => (cur && cur.kind === kind && cur.id === id ? null : cur))
      },
      add: (kind) => {
        const item = makeNew(kind)
        setterFor(kind)((list) => [...list, item])
        setSelected({ kind, id: item.id })
      }
    }
  }, [skills, mcp, subagents, selected])

  return <ExtensionsContext.Provider value={value}>{children}</ExtensionsContext.Provider>
}

export function useExtensions(): ExtensionsContextValue {
  const ctx = useContext(ExtensionsContext)
  if (!ctx) throw new Error('useExtensions 必须在 ExtensionsProvider 内使用')
  return ctx
}
