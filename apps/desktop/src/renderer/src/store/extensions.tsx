import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { ExtKind, Skill, McpServer, McpKV, SubAgent, Persona } from '../mock/extensions'
import type {
  SkillRecord,
  AgentRecord,
  AgentUpsertInput,
  PersonaRecord,
  PersonaUpsertInput,
  McpServerConfig,
  McpServerInput,
  McpServerView,
  McpValue
} from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'

/**
 * 扩展配置（全局，与项目无关）：技能 / MCP 服务 / 子智能体。
 * 左侧面板选中某项 → 中央详情页展示与编辑；也可新建自定义项。
 *
 * 技能 / MCP / 子智能体均已**文件回填**：挂载时经 `deva.skills.list()` / `deva.mcp.list()` /
 * `deva.agents.list()` 读取 ~/.deva，增删改启停都落盘；MCP 还订阅 `deva.mcp.onStatus`
 * 实时打运行期状态补丁（连接/断开/错误）。子智能体经 `run_subagent` 工具在主进程内递归派生。
 */
type AnyExt = Skill | McpServer | SubAgent | Persona
// 各类各自的部分补丁（并集，非交集）：`tools` 在 McpServer 与 SubAgent 上类型不同
// （McpTool[] vs string[]），交集会退化为不可满足的 `McpTool[] & string[]`，故用并集。
type ExtPatch = Partial<Skill> | Partial<McpServer> | Partial<SubAgent> | Partial<Persona>

export interface Selection {
  kind: ExtKind
  id: string
}

interface ExtensionsContextValue {
  skills: Skill[]
  mcp: McpServer[]
  subagents: SubAgent[]
  personas: Persona[]
  selected: Selection | null
  /**
   * 重新从磁盘拉取全部扩展清单。Provider 仅在挂载时载入一次，而技能等可能经对话 create_skill 工具、
   * 上传或直接改盘在别处新增 —— 进入扩展页时调用本方法即可拿到最新，无需重启。标识稳定（可安全用作
   * effect 依赖），故不会触发刷新循环。
   */
  refresh: () => void
  select: (kind: ExtKind, id: string) => void
  toggle: (kind: ExtKind, id: string) => void
  update: (kind: ExtKind, id: string, patch: ExtPatch) => void
  remove: (kind: ExtKind, id: string) => void
  add: (kind: ExtKind) => void
  /**
   * Persona 直存：整对象 round-trip 到 personas:upsert（→ composePersonaMd）后按 id 增量替换本地列表，
   * 返回落库映射后的 Persona（供角色编辑器「保存即建/改」的确定性路径，避免多次 update 拆分写）。
   */
  upsertPersona: (input: PersonaUpsertInput) => Promise<Persona | undefined>
  /**
   * Persona 花名册手动排序：按传入 id 顺序即时重排本地列表并落盘（拖拽落定 / 置顶）。存 id 顺序而非
   * name，故重命名不打乱顺序（对标 IM 联系人手动排序）。
   */
  reorderPersonas: (ids: string[]) => void
  /** 技能：上传文件（.zip 技能包或单个 SKILL.md）导入并自动启用；失败弹出本地化提示。 */
  importSkill: () => void
  /** MCP：连接（或重连）一个服务（状态经 onStatus 广播回流）。 */
  mcpConnect: (id: string) => void
  /** MCP：断开一个服务。 */
  mcpDisconnect: (id: string) => void
  /** MCP：测试连通（= 连接一次并保持）。 */
  mcpTest: (id: string) => void
  /** MCP：写入某密钥字段（空串即删除）；返回是否成功与加密是否可用（供降级提示）。 */
  mcpSetSecret: (id: string, field: string, value: string) => Promise<{ ok: boolean; available: boolean }>
}

const ExtensionsContext = createContext<ExtensionsContextValue | null>(null)

/** SkillRecord（主进程）→ 渲染层 Skill（desc 别名 + 来源徽标字段）。 */
function recToSkill(rec: SkillRecord): Skill {
  return {
    id: rec.id,
    name: rec.name,
    desc: rec.description,
    trigger: rec.trigger,
    allowedTools: rec.allowedTools,
    instructions: rec.instructions,
    scope: 'global',
    source: rec.source ?? 'custom',
    enabled: rec.enabled
  }
}

/** AgentRecord（主进程）→ 渲染层 SubAgent（description → desc + 全局/自定义徽标字段）。 */
function agentRecToSub(rec: AgentRecord): SubAgent {
  return {
    id: rec.id,
    name: rec.name,
    desc: rec.description,
    model: rec.model,
    tools: rec.tools,
    prompt: rec.prompt,
    scope: 'global',
    source: 'custom',
    enabled: rec.enabled
  }
}

/** SubAgent → upsert 入参（desc → description）。 */
function subToInput(a: SubAgent): AgentUpsertInput {
  return {
    id: a.id,
    name: a.name,
    description: a.desc,
    model: a.model,
    tools: a.tools,
    prompt: a.prompt,
    enabled: a.enabled
  }
}

/** PersonaRecord（主进程）→ 渲染层 Persona（description → desc + 全局/自定义徽标字段）。 */
function personaRecToPersona(rec: PersonaRecord): Persona {
  return {
    id: rec.id,
    name: rec.name,
    desc: rec.description,
    emoji: rec.emoji,
    color: rec.color,
    tagline: rec.tagline,
    model: rec.model,
    tools: rec.tools,
    prompt: rec.prompt,
    scope: 'global',
    source: 'custom',
    enabled: rec.enabled
  }
}

/** Persona → upsert 入参（desc → description）。 */
function personaToInput(p: Persona): PersonaUpsertInput {
  return {
    id: p.id,
    name: p.name,
    description: p.desc,
    emoji: p.emoji,
    color: p.color,
    tagline: p.tagline,
    model: p.model,
    tools: p.tools,
    prompt: p.prompt,
    enabled: p.enabled
  }
}

// ── MCP 类型转换（wire ↔ 渲染层）────────────────────────────────────────────

/** `{secretRef}` / 明文映射 → 编辑行；密钥值写后不回显（value 恒空占位）。 */
function kvFromMap(map: Record<string, McpValue> | undefined): McpKV[] {
  if (!map) return []
  return Object.entries(map).map(([key, v]) =>
    typeof v === 'string' ? { key, value: v, secret: false } : { key, value: '', secret: true }
  )
}

/** 编辑行 → 映射：secret 行写 `{secretRef: key}`（真实值另经 setSecret 加密存储），否则明文。 */
function mapFromKv(rows: McpKV[]): Record<string, McpValue> {
  const out: Record<string, McpValue> = {}
  for (const r of rows) {
    const key = r.key.trim()
    if (!key) continue
    out[key] = r.secret ? { secretRef: key } : r.value
  }
  return out
}

/** 配置公共字段 → 渲染层（不含运行期）。 */
function baseFromConfig(c: McpServerConfig): Omit<
  McpServer,
  'enabled' | 'status' | 'toolCount' | 'lastError' | 'tools'
> {
  return {
    id: c.id,
    name: c.name,
    desc: c.description,
    transport: c.transport,
    command: c.command ?? '',
    args: c.args ?? [],
    url: c.url ?? '',
    env: kvFromMap(c.env),
    headers: kvFromMap(c.headers),
    scope: 'global',
    source: 'custom'
  }
}

/** McpServerView（含运行期）→ 渲染层 McpServer。 */
function viewToMcp(v: McpServerView): McpServer {
  return {
    ...baseFromConfig(v),
    enabled: v.enabled,
    status: v.status,
    toolCount: v.toolCount,
    lastError: v.lastError,
    tools: v.tools
  }
}

/** McpServerConfig（新建返回，无运行期）→ 渲染层 McpServer（运行期取默认）。 */
function configToMcp(c: McpServerConfig, enabled = false): McpServer {
  return {
    ...baseFromConfig(c),
    enabled,
    status: 'disconnected',
    toolCount: 0,
    lastError: null,
    tools: []
  }
}

/** 渲染层 McpServer → upsert 入参（desc → description，编辑行 → 映射）。 */
function mcpToInput(m: McpServer): McpServerInput {
  return {
    id: m.id,
    name: m.name,
    description: m.desc,
    transport: m.transport,
    command: m.command,
    args: m.args,
    env: mapFromKv(m.env),
    url: m.url,
    headers: mapFromKv(m.headers),
    enabled: m.enabled
  }
}

export function ExtensionsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const [skills, setSkills] = useState<Skill[]>([])
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [subagents, setSubagents] = useState<SubAgent[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [selected, setSelected] = useState<Selection | null>(null)

  // 最新 mcp 快照（供 onStatus 回调 / update 合并读取，避免闭包过期）。
  const mcpRef = useRef<McpServer[]>(mcp)
  mcpRef.current = mcp

  // 挂载：从磁盘载入技能。
  useEffect(() => {
    let alive = true
    void window.deva?.skills
      ?.list()
      .then((list) => {
        if (alive) setSkills(list.map(recToSkill))
      })
      .catch(() => {
        /* 读失败 → 保持空态 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 挂载：先订阅 MCP 状态广播，再拉取清单（不漏掉启动期自动连接的中间态）。
  useEffect(() => {
    let alive = true
    const off = window.deva?.mcp?.onStatus?.((view) => {
      // 只打运行期补丁，保留本地正在编辑的配置字段（防广播覆盖键入）。
      setMcp((list) => {
        const idx = list.findIndex((m) => m.id === view.id)
        if (idx < 0) return list // 未知 id（清单尚未返回）→ 由随后的 list() 兜底
        const next = list.slice()
        next[idx] = {
          ...next[idx],
          enabled: view.enabled,
          status: view.status,
          toolCount: view.toolCount,
          lastError: view.lastError,
          tools: view.tools
        }
        return next
      })
    })
    void window.deva?.mcp
      ?.list()
      .then((list) => {
        if (alive) setMcp(list.map(viewToMcp))
      })
      .catch(() => {
        /* 读失败 → 保持空态 */
      })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // 挂载：从磁盘载入子智能体。
  useEffect(() => {
    let alive = true
    void window.deva?.agents
      ?.list()
      .then((list) => {
        if (alive) setSubagents(list.map(agentRecToSub))
      })
      .catch(() => {
        /* 读失败 → 保持空态 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 挂载：从磁盘载入 Agent 提示词（Personas）。
  useEffect(() => {
    let alive = true
    void window.deva?.personas
      ?.list()
      .then((list) => {
        if (alive) setPersonas(list.map(personaRecToPersona))
      })
      .catch(() => {
        /* 读失败 → 保持空态 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 显式刷新：重新从磁盘拉取四类扩展清单（见接口 refresh 注释）。只用稳定的 setter / 模块级转换器 /
  // window.deva，故 useCallback([]) 标识恒稳定，可安全作 effect 依赖而不致刷新循环。Provider 为
  // 应用级、不会卸载，故 .then 里 setState 无卸载竞态，无需 alive 守卫。
  const refresh = useCallback((): void => {
    void window.deva?.skills
      ?.list()
      .then((l) => setSkills(l.map(recToSkill)))
      .catch(() => {})
    void window.deva?.mcp
      ?.list()
      .then((l) => setMcp(l.map(viewToMcp)))
      .catch(() => {})
    void window.deva?.agents
      ?.list()
      .then((l) => setSubagents(l.map(agentRecToSub)))
      .catch(() => {})
    void window.deva?.personas
      ?.list()
      .then((l) => setPersonas(l.map(personaRecToPersona)))
      .catch(() => {})
  }, [])

  const setterFor = (kind: ExtKind): React.Dispatch<React.SetStateAction<AnyExt[]>> => {
    if (kind === 'skill') return setSkills as React.Dispatch<React.SetStateAction<AnyExt[]>>
    if (kind === 'mcp') return setMcp as React.Dispatch<React.SetStateAction<AnyExt[]>>
    if (kind === 'persona') return setPersonas as React.Dispatch<React.SetStateAction<AnyExt[]>>
    return setSubagents as React.Dispatch<React.SetStateAction<AnyExt[]>>
  }

  const patchLocal = (kind: ExtKind, id: string, fn: (item: AnyExt) => AnyExt): void =>
    setterFor(kind)((list) => list.map((it) => (it.id === id ? fn(it) : it)))

  const value = useMemo<ExtensionsContextValue>(() => {
    // 技能导入错误码 → 本地化消息 key。
    const importErrKey = (code: string): string => {
      switch (code) {
        case 'missing-name':
          return 'extensions.importErrMissingName'
        case 'no-skill-md':
          return 'extensions.importErrNoSkillMd'
        case 'unsafe-path':
          return 'extensions.importErrUnsafe'
        case 'too-large':
        case 'too-many-files':
          return 'extensions.importErrTooLarge'
        default:
          return 'extensions.importErrGeneric'
      }
    }

    const importSkill = (): void => {
      void (async () => {
        const res = await window.deva?.skills?.import()
        if (!res) return
        if (res.ok) {
          // 重新拉全表（含内置置顶），并选中导入项。
          const list = await window.deva?.skills?.list().catch(() => undefined)
          if (list) setSkills(list.map(recToSkill))
          if (res.id) setSelected({ kind: 'skill', id: res.id })
          return
        }
        if (res.error === 'cancelled') return // 用户取消，不提示
        await dialog.confirm({
          title: t('extensions.importFailed'),
          message: t(importErrKey(res.error ?? 'import-failed')),
          confirmText: t('common.confirm'),
          cancelText: t('common.close')
        })
      })()
    }

    const addMcp = (): void => {
      void (async () => {
        const cfg = await window.deva?.mcp?.upsert({
          name: '新 MCP 服务',
          description: '',
          transport: 'stdio',
          enabled: true
        })
        if (!cfg) return
        const m = configToMcp(cfg, true)
        setMcp((list) => [...list, m])
        setSelected({ kind: 'mcp', id: m.id })
      })()
    }

    const addSubagent = (): void => {
      void (async () => {
        const rec = await window.deva?.agents?.upsert({
          name: '新子智能体',
          description: '',
          model: '',
          tools: [],
          prompt: '',
          enabled: true
        })
        if (!rec) return
        const a = agentRecToSub(rec)
        setSubagents((list) => [...list, a])
        setSelected({ kind: 'subagent', id: a.id })
      })()
    }

    const addPersona = (): void => {
      void (async () => {
        const rec = await window.deva?.personas?.upsert({
          name: '新角色',
          description: '',
          emoji: '🤖',
          color: '#7c7cf0',
          tagline: '',
          model: '',
          tools: [],
          prompt: '',
          enabled: true
        })
        if (!rec) return
        const p = personaRecToPersona(rec)
        setPersonas((list) => [...list, p])
        setSelected({ kind: 'persona', id: p.id })
      })()
    }

    // 整对象直存：新建（无 id / 未见过的 id → 追加）或改写（已存在 → 替换），返回落库后的 Persona。
    const upsertPersona = async (input: PersonaUpsertInput): Promise<Persona | undefined> => {
      const rec = await window.deva?.personas?.upsert(input)
      if (!rec) return undefined
      const p = personaRecToPersona(rec)
      setPersonas((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]))
      return p
    }

    // 手动排序：乐观按传入 id 顺序重排本地列表（未列出的角色兜底追加末尾，防丢失），并落盘。
    const reorderPersonas = (ids: string[]): void => {
      setPersonas((list) => {
        const byId = new Map(list.map((p) => [p.id, p]))
        const next: Persona[] = []
        for (const id of ids) {
          const p = byId.get(id)
          if (p) {
            next.push(p)
            byId.delete(id)
          }
        }
        for (const p of byId.values()) next.push(p)
        return next
      })
      void window.deva?.personas?.reorder(ids).catch(() => {})
    }

    return {
      skills,
      mcp,
      subagents,
      personas,
      selected,
      refresh,
      select: (kind, id) => setSelected({ kind, id }),
      toggle: (kind, id) => {
        // 内置技能恒启用，不可切换（纵深防御：UI 已隐藏开关）。
        if (kind === 'skill' && skills.find((s) => s.id === id)?.source === 'builtin') return
        patchLocal(kind, id, (it) => ({ ...it, enabled: !it.enabled }) as AnyExt)
        if (kind === 'skill') {
          const cur = skills.find((s) => s.id === id)
          if (cur) void window.deva?.skills?.setEnabled(id, !cur.enabled).catch(() => {})
        } else if (kind === 'mcp') {
          // 启停即连接 / 断开（状态经 onStatus 回流）。
          const cur = mcpRef.current.find((m) => m.id === id)
          if (cur) void window.deva?.mcp?.setEnabled(id, !cur.enabled).catch(() => {})
        } else if (kind === 'persona') {
          const cur = personas.find((p) => p.id === id)
          if (cur) void window.deva?.personas?.setEnabled(id, !cur.enabled).catch(() => {})
        } else {
          const cur = subagents.find((a) => a.id === id)
          if (cur) void window.deva?.agents?.setEnabled(id, !cur.enabled).catch(() => {})
        }
      },
      update: (kind, id, patch) => {
        // 技能已改为只读展示，不再从 UI 落盘（创建仅经上传 / 对话 create_skill）。
        if (kind === 'skill') return
        patchLocal(kind, id, (it) => ({ ...it, ...patch }) as AnyExt)
        if (kind === 'mcp') {
          // 合到最新快照后落盘（配置字段；密钥值不经此路径，另经 mcpSetSecret）。
          const cur = mcpRef.current.find((m) => m.id === id)
          if (cur)
            void window.deva?.mcp
              ?.upsert(mcpToInput({ ...cur, ...(patch as Partial<McpServer>) }))
              .catch(() => {})
        } else if (kind === 'persona') {
          const cur = personas.find((p) => p.id === id)
          if (cur)
            void window.deva?.personas
              ?.upsert(personaToInput({ ...cur, ...(patch as Partial<Persona>) }))
              .catch(() => {})
        } else {
          const cur = subagents.find((a) => a.id === id)
          if (cur)
            void window.deva?.agents
              ?.upsert(subToInput({ ...cur, ...(patch as Partial<SubAgent>) }))
              .catch(() => {})
        }
      },
      remove: (kind, id) => {
        // 内置技能不可删（纵深防御：UI 已隐藏删除入口）。
        if (kind === 'skill' && skills.find((s) => s.id === id)?.source === 'builtin') return
        setterFor(kind)((list) => list.filter((it) => it.id !== id))
        setSelected((cur) => (cur && cur.kind === kind && cur.id === id ? null : cur))
        if (kind === 'skill') void window.deva?.skills?.remove(id).catch(() => {})
        else if (kind === 'mcp') void window.deva?.mcp?.remove(id).catch(() => {})
        else if (kind === 'persona') void window.deva?.personas?.remove(id).catch(() => {})
        else void window.deva?.agents?.remove(id).catch(() => {})
      },
      add: (kind) => {
        // 技能的「+」即上传导入（无手写空建）；MCP / 子智能体 / Agent 提示词为可编辑空建。
        if (kind === 'skill') return importSkill()
        if (kind === 'mcp') return addMcp()
        if (kind === 'persona') return addPersona()
        return addSubagent()
      },
      upsertPersona,
      reorderPersonas,
      importSkill,
      mcpConnect: (id) => void window.deva?.mcp?.connect(id).catch(() => {}),
      mcpDisconnect: (id) => void window.deva?.mcp?.disconnect(id).catch(() => {}),
      mcpTest: (id) => void window.deva?.mcp?.test(id).catch(() => {}),
      mcpSetSecret: async (id, field, value) => {
        try {
          const r = await window.deva?.mcp?.setSecret(id, field, value)
          return r ?? { ok: false, available: true }
        } catch {
          return { ok: false, available: true }
        }
      }
    }
  }, [skills, mcp, subagents, personas, selected, refresh, t, dialog])

  return <ExtensionsContext.Provider value={value}>{children}</ExtensionsContext.Provider>
}

export function useExtensions(): ExtensionsContextValue {
  const ctx = useContext(ExtensionsContext)
  if (!ctx) throw new Error('useExtensions 必须在 ExtensionsProvider 内使用')
  return ctx
}
