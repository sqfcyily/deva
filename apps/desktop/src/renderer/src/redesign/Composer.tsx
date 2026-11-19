/**
 * 输入框：草稿、/指令、插话胶囊；模型、思考等级与上下文占用在 ModelPanel.tsx。
 */
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  ChevronDown,
  Clock,
  FolderPlus,
  Paperclip,
  Plus,
  Puzzle,
  RotateCcw,
  Shrink,
  Square,
  X
} from 'lucide-react'
import {
  triggerReplaceEnd,
  useComposerEditor,
  type ComposerKey,
  type ComposerTrigger
} from './composer-editor'
import { AttachmentList } from './attachments'
import type { Persona } from '../mock/extensions'
import { TodoCapsule } from '../features/chat/Todos'
import { BackgroundCapsule } from '../features/chat/BackgroundTasks'
import { BrowserCapsule } from '../features/browser/BrowserCapsule'
import { useDockOrder } from '../features/chat/dockOrder'
import { type AttachKind, type SendAttachment, useChatState, useChatActions } from '../store/chat'
import { rolesAllow, useExtensions } from '../store/extensions'
import { NEW_MEMBER_TOKENS } from '../../../shared/mention'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import {
  COMPOSER_DEFAULT,
  ResizeHandle,
  clampComposer,
  loadLayout,
  saveLayout,
  useViewport
} from './resizable'
import {
  avatarDataUri,
  parseAvatarSpec
} from '../components/humation'
import { samePath, DEFAULT_PERSONA_ID, fill, AvatarStack, Avatar } from './shell-common'
import { GitWidget, WorkspaceMenu } from './GitWidget'
import { leadingQuote, withQuote, quotePlain } from './ConvMessage'
import { ModelPanel } from './ModelPanel'

/**
 * 一次挑选返回的附件（与 preload PickedAttachment 结构一致）；拖入 / 粘贴的文件夹也放这里，kind 为 folder。
 * kind 为 file：内容读不进消息（Word 等格式、超过体积上限），发送时只把位置交给模型。
 */
interface Picked {
  path: string
  name: string
  ext: string
  size: number
  kind: 'image' | 'document' | 'text' | 'folder' | 'file' | 'unsupported'
  supported: boolean
  reason?: string
}

/**
 * 输入框「/ 指令」联想的一个候选项。
 * `command` = 渲染层自有指令（/compact 见 store/chat 的手动压缩分支；/rewind 在 Composer.submit 拦截）；
 * `skill` = 已启用技能，由主进程按 `/name` 匹配并把 SKILL.md 正文预置进本轮消息。
 */
export interface SlashCommand {
  name: string
  desc: string
  /**
   * mention = 「@ 成员 / 角色」联想（光标处的词以 @ 开头时），采纳后写回 `@name `；
   * newMember = 「新建成员」，采纳后写回 `@新建成员 `（name 即此标记，见 shared/mention.ts），接着写需求。
   */
  kind: 'command' | 'skill' | 'mention' | 'newMember'
  /** mention：候选的头像。 */
  persona?: Persona
  /** mention：已是本对话成员（名字后标「成员」）。 */
  member?: boolean
  /** 浮层里显示的名字（缺省按 kind 写成 `@name` / `/name`）。 */
  label?: string
}

/**
 * 各会话未发送的输入（正文 + 待发附件），按会话 id 存在内存里：切走时存下、切回来接着写，也不会把 A 会话
 * 没写完的内容带到 B。只存非空的；不落盘，重启应用后清空。
 * 会话列表据此在其他会话行上显示「[草稿] …」（见 useDraftPreview）：只在进出会话时变动，打字不刷新列表。
 */
type ComposerDraft = { text: string; pending: Picked[]; quote?: string }

/**
 * 输入框预填（一次性、不发送）：nonce 使相同文本也能重复触发。quote=true 时 text 是引用（`> ` 格式），放进引用条；
 * 否则整体替换输入框（开头的引用拆回引用条，见 leadingQuote）。
 */
export type ComposerPrefill = { text: string; nonce: number; quote?: boolean }

const composerDrafts = new Map<string, ComposerDraft>()

const draftListeners = new Set<() => void>()

/** 写入（null = 清除）某会话的草稿，并通知会话列表。 */
function setComposerDraft(id: string, draft: ComposerDraft | null): void {
  if (draft) composerDrafts.set(id, draft)
  else if (!composerDrafts.delete(id)) return
  for (const notify of draftListeners) notify()
}

function subscribeDrafts(onChange: () => void): () => void {
  draftListeners.add(onChange)
  return () => {
    draftListeners.delete(onChange)
  }
}

/**
 * 正在显示的输入框（随会话切换更新）：插入的消息被撤回或退回时，正是这个会话就直接放回输入框，否则并进那个
 * 会话的草稿（见 restoreToComposer）。
 */
let liveComposer: { sessionId: string; restore: (text: string, attachments: Picked[]) => void } | null = null

/** 把放回来的附件并进待发附件：排在已有的之前（同文字），按路径去重。 */
function mergePicked(back: Picked[], cur: Picked[]): Picked[] {
  if (!back.length) return cur
  const seen = new Set(back.map((p) => p.path))
  return [...back, ...cur.filter((p) => !seen.has(p.path))]
}

/**
 * 把文字与附件放回某会话的输入框：文字排在已有内容之前，中间空一行。开头的引用放回引用条；引用条里已有引用时，
 * 这段引用就留在文字里（不覆盖用户新放的引用）。附件（撤回或退回的插入消息带的）放回待发附件。
 */
export function restoreToComposer(sessionId: string, text: string, attachments: SendAttachment[] = []): void {
  if (!text.trim() && !attachments.length) return
  // 这些附件发出去之前就在待发附件里，路径仍是主进程授权过的。
  const back: Picked[] = attachments.map((a) => ({
    path: a.path,
    name: a.name,
    ext: '',
    size: a.size ?? 0,
    kind: a.kind,
    supported: true
  }))
  if (liveComposer?.sessionId === sessionId) {
    liveComposer.restore(text, back)
    return
  }
  const d = composerDrafts.get(sessionId)
  const lq = d?.quote ? null : leadingQuote(text)
  const body = lq ? lq.rest : text
  setComposerDraft(sessionId, {
    text: d?.text.trim() ? (body ? `${body}\n\n${d.text}` : d.text) : body,
    pending: mergePicked(back, d?.pending ?? []),
    quote: lq?.quote ?? d?.quote
  })
}

/**
 * 待送达的插入消息（输入框上方，与待办清单、后台任务胶囊同一排）：回合进行中插入、当前步骤还没结束的消息。
 * 「撤回」把文字与附件放回输入框，可以改完再插入；送达后胶囊消失，消息出现在执行步骤里。多条显示条数，送达时合并成一条。
 * 带附件的在文字后加一枚回形针（多个时带数量），附件名挂在悬停上——胶囊文字最多 160px，写文件名会把正文挤没；
 * 只有附件没有文字时，文字位置写附件名（多个写「N 个附件」）。
 */
function InsertCapsule({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useI18n()
  const { pendingInserts } = useChatState()
  const { withdrawInserts } = useChatActions()
  const [busy, setBusy] = useState(false)
  const order = useDockOrder(pendingInserts.length > 0, sessionId)
  if (pendingInserts.length === 0) return null
  const words = pendingInserts
    .map((p) => p.text)
    .filter(Boolean)
    .join('  ')
  const files = pendingInserts.flatMap((p) => p.attachments)
  const text =
    words || (files.length === 1 ? files[0] : t('cf.insert.files').replace('{n}', String(files.length)))
  const title = [words, ...files.map((name) => `[${name}]`), t('cf.insert.pendingHint')].filter(Boolean).join('\n')
  const withdraw = (): void => {
    setBusy(true)
    void withdrawInserts()
      .then((back) => restoreToComposer(sessionId, back.text, back.attachments))
      .finally(() => setBusy(false))
  }
  return (
    <div className="cf-ins" style={{ order }}>
      {/* 消息文字最多 160px（见 .cf-dock），完整内容挂在悬停上 */}
      <div className="cf-bg__pill cf-ins__pill" title={title}>
        <Clock size={13} className="cf-ins__icon" />
        <span className="cf-bg__label cf-ins__label">{t('cf.insert.pending')}</span>
        <span className="cf-bg__name">{text}</span>
        {files.length > 0 && (
          <span className="cf-ins__files">
            <Paperclip size={12} />
            {/* 没有文字时数量已写在「N 个附件」里，不再重复 */}
            {files.length > 1 && words && files.length}
          </span>
        )}
        {pendingInserts.length > 1 && (
          <span className="cf-ins__count">{t('cf.insert.count').replace('{n}', String(pendingInserts.length))}</span>
        )}
        <button type="button" className="cf-bg__stop" disabled={busy} onClick={withdraw}>
          {t('cf.insert.withdraw')}
        </button>
      </div>
    </div>
  )
}

/**
 * 等主角色汇总的成员进度（对比稿 design/member-chat.html 方案 G1）：对话末尾一条居中的灰底提醒，已完成成员的头像
 * 叠放（最多 3 个，超出同技能「可用角色」的 +N），后面写「前端已完成」；多于一位时只写「2 位成员已完成」，不列名字。
 * 第一位完成前不显示（派发那条回复已写明交给了谁）；全部交回时主进程删去该组，提示随之消失，主角色接着汇总。
 * 出错 / 被停止的交给主角色处理，这里不出现。悬停看每位的状态。
 */
export function MemberProgressNotice({
  ownerName,
  faceOf
}: {
  ownerName: string
  faceOf: (sid: string) => Persona | undefined
}): React.JSX.Element | null {
  const { t } = useI18n()
  const { memberProgress } = useChatState()
  const shown = memberProgress
    .map((g) => ({ g, done: g.items.filter((i) => i.status === 'done') }))
    .filter((x) => x.done.length > 0)
  if (!shown.length) return null
  return (
    <>
      {shown.map(({ g, done }, k) => {
        const faces = done.flatMap((i) => {
          const p = faceOf(i.sid)
          return p ? [p] : []
        })
        const text =
          done.length === 1
            ? fill(t('cf.member.progressOne'), { name: done[0].name })
            : fill(t('cf.member.progressMany'), { n: String(done.length) })
        const title = [
          ...g.items
            .filter((i) => i.status === 'done' || i.status === 'running')
            .map((i) => `${i.name}　${i.status === 'done' ? t('cf.member.progressStDone') : t('cf.member.working')}`),
          fill(t('cf.member.progressHint'), { owner: ownerName })
        ].join('\n')
        return (
          <div key={k} className="cf-mprogress">
            <div className={`cf-mprogress__pill${faces.length ? '' : ' is-noface'}`} title={title}>
              {faces.length > 0 && <AvatarStack personas={faces} size={18} plain />}
              <span className="cf-mprogress__text">{text}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

/** 某会话草稿的一行摘要：正文（空白归一），只有附件时为附件名；没有草稿为 null。 */
export function useDraftPreview(id: string): string | null {
  return useSyncExternalStore(subscribeDrafts, () => {
    const d = composerDrafts.get(id)
    if (!d) return null
    return (
      d.text.replace(/\s+/g, ' ').trim() ||
      d.pending.map((p) => p.name).join(' ') ||
      (d.quote ? quotePlain(d.quote) : '') ||
      null
    )
  })
}

// 包 memo：流式输出时对话流每帧重渲染，输入框的 props 不变就不跟着重渲染（回调见 Conversation 的 useStableCallback）。
export const Composer = memo(function Composer({
  sessionId,
  owner,
  mentionables,
  roleId,
  streaming,
  focusRoot,
  onMount,
  onSend,
  onStop,
  showJump,
  onJump,
  onRewind,
  prefill,
  onPrefillConsumed
}: {
  /** 当前会话：输入框里的草稿按它分开保存（见 composerDrafts）。 */
  sessionId: string
  owner?: Persona
  /** 「@」联想候选：本对话成员与可加入的角色。 */
  mentionables: SlashCommand[]
  /** 技能按哪个角色过滤（缺省 = owner）：成员对话里是成员的设定来源角色。 */
  roleId?: string
  streaming: boolean
  focusRoot: string | null
  onMount: (path: string | null) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<boolean>
  onStop: () => void
  showJump: boolean
  onJump: () => void
  /** 打开检查点回滚面板（/rewind、双击 Esc）；返回 false 表示此刻不可用（未打开）。 */
  onRewind: () => boolean
  prefill: ComposerPrefill | null
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { skills: allSkills } = useExtensions()
  // 本对话角色能用的技能（已启用、且可用角色含该角色；内置恒可用）——同主进程的过滤，/ 联想与上色只认它们。
  const ownerId = roleId ?? owner?.id ?? DEFAULT_PERSONA_ID
  const skills = useMemo(
    () => allSkills.filter((s) => s.enabled && (s.source === 'builtin' || rolesAllow(s.roles, ownerId))),
    [allSkills, ownerId]
  )
  const toast = useToast()
  const { insert: onInsert } = useChatActions()
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<Picked[]>([])
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  /**
   * 输入框顶部的引用条（右键「引用」，同 TG 的回复）：存 `> ` 格式的引用，'' = 没有。一次一条，再引用就替换；
   * 发送时拼在消息开头（见 withQuote），只有引用也能发。随草稿按会话保存。
   */
  const [quote, setQuote] = useState('')
  const quoteRef = useRef(quote)
  quoteRef.current = quote
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  // 输入框高度：固定高、不随内容长高，内容多了框内滚动；只能靠顶边手柄拖动调整。
  // 与侧栏同理，存用户意图值、渲染时按窗口高再夹取。
  const viewport = useViewport()
  const [composerH, setComposerH] = useState(() => loadLayout().composerHeight ?? COMPOSER_DEFAULT)
  const boxH = clampComposer(composerH, viewport.h)
  const boxHRef = useRef(boxH)
  boxHRef.current = boxH
  /** 「/ 指令」联想：当前高亮项下标（随查询词变化复位）。 */
  const [slashSel, setSlashSel] = useState(0)
  /** Esc 收起联想；任何一次输入改动都会复位，重新键入即可再唤出。 */
  const [slashOff, setSlashOff] = useState(false)
  /** 光标处以 / 或 @ 开头的词（开头或正文中间都算，见 composer-editor 的 ComposerTrigger）：据此弹出联想。 */
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  /** 输入框是否持有焦点：失焦即收起联想（采纳项走 mousedown+preventDefault，不会触发失焦）。 */
  const [focused, setFocused] = useState(false)
  const slashRef = useRef<HTMLDivElement>(null)
  /** 上一次「空输入框里按 Esc」的时刻：500ms 内再按一次即打开回滚面板。 */
  const lastEscRef = useRef(0)

  // 预填（不发送）：把父层注入的文本写进输入框，聚焦并将光标移到末尾，交由用户自己发送。
  // 引用只换引用条、不动文字；整体替换时开头的引用拆回引用条（回滚填回带引用的原问题）。
  // nonce 变化触发一次；消费后立即回调置空（父层 prefill→null），guard 防重入与重挂载复活。
  useEffect(() => {
    if (!prefill) return
    if (prefill.quote) {
      setQuote(prefill.text)
      composer.focusEnd()
    } else {
      const lq = leadingQuote(prefill.text)
      setQuote(lq ? lq.quote : '')
      composer.setText(lq ? lq.rest : prefill.text, true)
    }
    onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce])

  // 指令表：渲染层自有的 /compact、/rewind 置顶，其后是本角色可用的技能（停用或不对本角色开放的主进程也不认）。
  // 同名技能会被自有指令遮蔽（渲染层先拦截），按小写名去重、保留先者，不给出点了没反应的候选。
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const out: SlashCommand[] = [
      { name: 'compact', desc: t('cf.slash.compact'), kind: 'command' },
      { name: 'rewind', desc: t('cf.slash.rewind'), kind: 'command' }
    ]
    const seen = new Set(out.map((c) => c.name.toLowerCase()))
    for (const s of skills) {
      if (!s.enabled) continue
      const key = s.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: s.name, desc: s.desc, kind: 'skill' })
    }
    return out
  }, [skills, t])

  // 光标处正在敲的 `/词`、`@词`（开头或正文中间都可以）：「@」联想与「/」共用同一个浮层，@ 时候选换成成员与角色。
  const slashQuery = trigger?.char === '/' ? trigger.query : null
  const mentionQuery = trigger?.char === '@' && mentionables.length > 0 ? trigger.query : null
  const suggestQuery = slashQuery ?? mentionQuery
  // /compact、/rewind 只在输入框里只有这一个词时可选（同 submit 的拦截）；其余情况只列技能。
  const slashAlone = !!trigger?.alone
  // 排序：前缀命中优先于子串命中，组内保持原序（/compact 在前，技能按扩展页顺序）。
  const slashMatches = useMemo<SlashCommand[]>(() => {
    if (suggestQuery === null) return []
    const pool =
      slashQuery === null ? mentionables : slashAlone ? slashCommands : slashCommands.filter((c) => c.kind === 'skill')
    const q = suggestQuery.toLowerCase()
    if (!q) return pool
    const head: SlashCommand[] = []
    const tail: SlashCommand[] = []
    for (const c of pool) {
      const n = c.name.toLowerCase()
      if (n.startsWith(q)) head.push(c)
      else if (n.includes(q)) tail.push(c)
    }
    return [...head, ...tail]
  }, [slashCommands, mentionables, slashQuery, suggestQuery, slashAlone])
  const slashOpen = focused && suggestQuery !== null && slashMatches.length > 0 && !slashOff
  // 高亮下标就地夹紧：命中集随输入收缩时，无需等 effect 落地即为合法值。
  const slashCur = slashOpen ? Math.min(slashSel, slashMatches.length - 1) : -1

  // 查询词一变就回到第一项（最贴合用户刚敲的那几个字母）。
  useEffect(() => {
    setSlashSel(0)
  }, [suggestQuery])
  // 光标移到了另一个 / @ 词上（没打字）：Esc 收起的联想也重新可唤出。
  useEffect(() => {
    setSlashOff(false)
  }, [trigger?.start, trigger?.char])

  // 键盘上下移动时把高亮项滚进可视区（列表超高时才有实际位移）。
  useEffect(() => {
    if (!slashOpen) return
    slashRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [slashCur, slashOpen])

  /**
   * 采纳候选：只把光标处已敲的 `/词`、`@词` 换成 `/name `、`@name `，光标后原有的文字不动（见 triggerReplaceEnd），
   * 光标留在它之后。尾随空格便于接着写、也把名字与后面的文字隔开（发送前会被 trim）；后面本来就是空白则不再加。
   */
  const applySlash = (c: SlashCommand): void => {
    if (!trigger) return
    const token = c.kind === 'mention' || c.kind === 'newMember' ? `@${c.name}` : `/${c.name}`
    const end = triggerReplaceEnd(input, trigger, c.name)
    const next = input.charAt(end)
    composer.replaceRange(trigger.start, end, next && /\s/.test(next) ? token : `${token} `)
  }

  const name = owner?.name ?? t('cf.assistant')
  // 回合进行中：输入框里的文字会插入当前这一轮，占位提示说明送达时机。
  const placeholder =
    (streaming
      ? t('cf.insert.placeholder').replace('{name}', name)
      : locale === 'en'
        ? `Message ${name}…`
        : `跟 ${name} 说点什么…`)
  const supported = pending.filter((p) => p.supported)
  const canSend = Boolean(input.trim()) || supported.length > 0 || Boolean(quote)
  // 回合进行中有文字、引用或附件：唯一的按键是「发送」（插入当前轮），附件随这条消息一并插入。
  const canInsert = streaming && canSend
  /** 上一次插入的时刻：插入后输入框清空、同一位置随即变成停止键，短时间内不认停止，防双击把任务停掉。 */
  const insertedAtRef = useRef(0)
  const stopTurn = (): void => {
    if (Date.now() - insertedAtRef.current < 600) return
    onStop()
  }
  const mounted = Boolean(focusRoot)

  // 挂载工作区（放在输入区工具条，取代原顶部头部的入口）：仅未挂载态的 chip 调用，选了才挂载，取消则保持现状。
  // 已挂载态不提供直接更换（见 WorkspaceMenu），卸载由尾随的 ✕ 图标承担，避免「取消对话框＝卸载」的意外语义。
  const pickWorkspace = (): void => {
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r) onMount(r.path)
    })()
  }

  // 新增附件并入 pending：不支持 / 过大的不加入（加了也发不出去），toast 说明哪些被跳过；按路径去重。
  const addPicked = (picked: Picked[]): void => {
    const bad = picked.filter((p) => !p.supported)
    if (bad.length) {
      const names = bad.map((p) => p.name).join(locale === 'en' ? ', ' : '、')
      toast.show({ variant: 'warning', message: t('cf.attachSkipped').replace('{names}', names) })
    }
    setPending((prev) => {
      const seen = new Set(prev.map((p) => p.path))
      const out = [...prev]
      for (const p of picked) {
        if (!p.supported || seen.has(p.path)) continue
        seen.add(p.path)
        out.push(p)
      }
      return out
    })
  }

  const pickFiles = async (): Promise<void> => {
    addPicked((await window.deva.fs.pickAttachments()) as Picked[])
  }

  // 粘贴 / 拖入的文件：与「附加文件」同一条链路（主进程落盘授权 → pending 附件条）。
  // 只交字节不交路径，渲染层仍无法让主进程读任意路径。文件夹不走这里，见 ingest。
  const addFiles = async (files: File[]): Promise<void> => {
    const results = await Promise.allSettled(
      files.map(async (f) =>
        window.deva.fs.pasteAttachment({
          name: f.name,
          mime: f.type,
          size: f.size,
          // 超过最大附件上限（PDF 20MB）的不读字节，只报体积，主进程据此判「过大」。
          data: f.size > 20 * 1024 * 1024 ? null : new Uint8Array(await f.arrayBuffer())
        })
      )
    )
    // 同一文件多次粘贴 / 拖入只留一份：主进程按内容去重、重复的返回同一路径，addPicked 按路径过滤即可。
    addPicked(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value as Picked] : [])))
  }

  // 挂载 chip 闪一下浅主题色底：拖入的文件夹刚被挂载，或拖入的正是已挂载的那个（表示「已经挂着」）。
  // 刚挂载时 chip 要等 focusRoot 生效才渲染出来，故记下目标路径，等 chip 显示的正是它再闪。
  // className 是静态的，React 不会改写它，手动加的 is-flash 留到动画结束（onAnimationEnd）再摘。
  const wsRef = useRef<HTMLSpanElement>(null)
  const [wsFlash, setWsFlash] = useState<{ path: string } | null>(null)
  useEffect(() => {
    const el = wsRef.current
    if (!wsFlash || !el || !focusRoot || !samePath(focusRoot, wsFlash.path)) return
    el.classList.remove('is-flash')
    void el.offsetWidth // 重排一次，连续两次闪烁时动画才会重新开始
    el.classList.add('is-flash')
    setWsFlash(null)
  }, [wsFlash, focusRoot])

  // 拖入 / 粘贴的文件夹：只记位置，不读内容。未挂载时恰好一个文件夹 → 直接挂载（同「挂载文件夹」）；
  // 一次多个不猜哪个是项目，全部作为文件夹贴片。拖入的正是已挂载的那个 → 不加贴片，挂载 chip 闪一下。
  // 回合进行中不替用户挂载（工作目录在一轮中途换掉，正在跑的步骤会对不上），一律作为文件夹贴片随消息插入。
  const addFolders = (dirs: { path: string; name: string }[]): void => {
    if (!focusRoot && dirs.length === 1 && !streaming) {
      onMount(dirs[0].path)
      setWsFlash({ path: dirs[0].path })
      return
    }
    const refs: Picked[] = []
    for (const d of dirs) {
      if (focusRoot && samePath(d.path, focusRoot)) setWsFlash({ path: d.path })
      else refs.push({ path: d.path, name: d.name, ext: '', size: 0, kind: 'folder', supported: true })
    }
    if (refs.length) addPicked(refs)
  }

  // 粘贴 / 拖入的条目：先交主进程按真实路径认（文件夹、文件同选择框——读不进消息的只交位置），取不到路径的
  // （截图等）照旧交字节。等待期间切走了会话就作罢，免得把这个会话的文件夹挂到别的会话上。
  const ingest = async (files: File[]): Promise<void> => {
    const sid = sessionRef.current
    const entries = await window.deva.fs.droppedEntries(files).catch(() => [])
    if (sessionRef.current !== sid) return
    const folders = entries.flatMap((e) => (e && 'folder' in e ? [e.folder] : []))
    if (folders.length) addFolders(folders)
    const picked = entries.flatMap((e) => (e && 'file' in e ? [e.file as Picked] : []))
    if (picked.length) addPicked(picked)
    const rest = files.filter((_, i) => !entries[i])
    if (rest.length) await addFiles(rest)
  }

  // 剪贴板带纯文本时一律按文本粘贴——Word / Excel 复制内容会顺带一张渲染图，不能把它变成附件。
  const onPaste = (e: ClipboardEvent): boolean => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length || e.clipboardData?.getData('text/plain')) return false
    e.preventDefault()
    void ingest(files)
    return true
  }

  // 拖入文件 / 文件夹：整个窗口都可放下。Chromium 对未拦截的文件拖放默认「打开该文件」
  // （导航离开应用），故凡带文件的 dragover / drop 都 preventDefault。回复中照常附加，随插入的消息发出。
  const ingestRef = useRef(ingest)
  ingestRef.current = ingest
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'))
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) void ingestRef.current(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const removePending = (path: string): void =>
    setPending((prev) => prev.filter((p) => p.path !== path))

  /** 待发附件里能发出去的，换成发送 / 插入用的形状。 */
  const sendable = (): SendAttachment[] =>
    pending
      .filter((p) => p.supported)
      .map((p) => ({
        path: p.path,
        name: p.name,
        kind: p.kind as AttachKind,
        ...(p.kind === 'folder' ? {} : { size: p.size })
      }))

  // 插入当前轮：清空输入框交给主进程，当前步骤结束后送达；没插进去（原因已 toast）就把文字与附件放回（引用回到引用条）。
  const insertNow = (): void => {
    const text = composer.getText()
    const q = quote
    const atts = sendable()
    // /compact、/rewind 是本地指令，回合进行中用不了，也不该当成消息插进去。
    if ((!text.trim() && !q && !atts.length) || (!q && !atts.length && /^\/(compact|rewind)$/i.test(text.trim())))
      return
    const full = withQuote(q, text)
    const sid = sessionId
    insertedAtRef.current = Date.now()
    composer.setText('')
    composer.clearHistory()
    setPending([])
    setQuote('')
    void onInsert(full, atts).then((ok) => {
      if (!ok) restoreToComposer(sid, full, atts)
    })
  }

  const submit = (): void => {
    if (streaming) {
      insertNow()
      return
    }
    const text = composer.getText()
    const q = quote
    const atts = sendable()
    if (!text.trim() && atts.length === 0 && !q) return
    // /rewind 纯渲染层指令：打开回滚面板、不发消息；此刻不可用则原样留在输入框。
    if (text.trim().toLowerCase() === '/rewind' && atts.length === 0) {
      if (onRewind()) composer.setText('')
      return
    }
    const prevPending = pending
    const sid = sessionId
    composer.setText('')
    composer.clearHistory()
    setPending([])
    setQuote('')
    void onSend(withQuote(q, text), atts).then((sent) => {
      // 未发出（未选模型 / 请求失败，原因已 toast）：把草稿放回——但别覆盖用户在此期间新敲的内容；
      // 此间已切到别的会话的，放回原会话的草稿里。
      if (sent) return
      if (sessionRef.current !== sid) {
        if (!composerDrafts.has(sid)) setComposerDraft(sid, { text, pending: prevPending, quote: q })
        return
      }
      if (!composer.getText()) composer.setText(text)
      setPending((cur) => (cur.length ? cur : prevPending))
      setQuote((cur) => cur || q)
    })
  }

  const onKey = (key: ComposerKey, e: KeyboardEvent): boolean => {
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey
    // 「/ 指令」联想打开时这几个键先归联想；其余（含 Shift+Enter 换行）照旧落到输入框。
    if (slashOpen) {
      if (plain && (key === 'down' || key === 'up')) {
        e.preventDefault()
        const d = key === 'down' ? 1 : -1
        setSlashSel((i) => {
          const n = slashMatches.length
          return (Math.min(i, n - 1) + d + n) % n
        })
        return true
      }
      if (key === 'tab' || (plain && key === 'enter')) {
        e.preventDefault()
        const pick = slashMatches[slashCur]
        if (pick) applySlash(pick)
        return true
      }
      if (key === 'escape') {
        e.preventDefault()
        setSlashOff(true)
        return true
      }
    }
    // 双击 Esc（仅空输入框、无待发附件时）打开回滚面板；联想浮层开着时 Esc 已在上面被它吃掉。
    if (key === 'escape' && plain && !input.trim() && pending.length === 0 && !quote && !streaming) {
      const now = Date.now()
      if (now - lastEscRef.current <= 500) {
        lastEscRef.current = 0
        e.preventDefault()
        onRewind()
        return true
      }
      lastEscRef.current = now
      return false
    }
    if (key !== 'enter' || !plain) return false // 其余交给编辑器（Shift+Enter 换行）
    e.preventDefault()
    submit()
    return true
  }

  // 开头 `/name` 会不会生效（决定是否上色）：/compact、/rewind 须整条只有它且无附件（同 submit 与 store 的拦截）；
  // 其余按本角色可用技能的显示名或文件夹名、不分大小写匹配（同主进程 loadSkillInstructionsByName）。
  const noAtts = supported.length === 0
  const isToken = (name: string, whole: string): boolean => {
    const n = name.toLowerCase()
    if ((n === 'compact' || n === 'rewind') && noAtts && whole.toLowerCase() === `/${n}`) return true
    return skills.some((s) => s.enabled && (s.name.toLowerCase() === n || s.id.toLowerCase() === n))
  }
  // 正文里会做成成员标签的 `@名字`：本对话成员、可 @ 的角色，以及「新建成员」的标记（几种写法都认，同主进程
  // handleMentions）。只在主对话里有（成员对话没有 @ 联想，主进程也不认）。
  const mentionNames = useMemo<string[]>(
    () =>
      mentionables.length
        ? [...mentionables.filter((c) => c.kind === 'mention').map((c) => c.name), ...NEW_MEMBER_TOKENS]
        : [],
    [mentionables]
  )
  // 成员标签的头像：按名字找候选的身份；「新建成员」没有头像。
  const mentionFace = (name: string): string | null => {
    const p = mentionables.find((c) => c.kind === 'mention' && c.name === name)?.persona
    return p ? avatarDataUri(p.id, parseAvatarSpec(p.avatar), p.avatarImage) || null : null
  }

  const composer = useComposerEditor({
    onChange: (text) => {
      setInput(text)
      setSlashOff(false) // 又动了输入：Esc 收起的联想重新可唤出
    },
    onTrigger: setTrigger,
    onKey,
    onPaste,
    isToken,
    mentionNames,
    mentionFace
  })

  // 判定依据（技能启停、有无附件、可 @ 的名字）变了而文本没变：重新识别一次要上色的片段。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => composer.refreshToken(), [skills, noAtts, mentionNames.join('\n')])

  // 草稿按会话分开：进入会话（含挂载）换上它的草稿，没有则清空；离开（切换会话或卸载，如进入选择删除）时
  // 把当前内容存到它名下。撤销历史一并清掉，免得撤销把别的会话的内容找回来。用 layout effect，切过去时
  // 不会先闪一下上一个会话的文字。
  useLayoutEffect(() => {
    const draft = composerDrafts.get(sessionId)
    setComposerDraft(sessionId, null)
    composer.setText(draft?.text ?? '')
    composer.clearHistory()
    setPending(draft?.pending ?? [])
    setQuote(draft?.quote ?? '')
    return () => {
      const text = composer.getText()
      const kept = pendingRef.current
      const q = quoteRef.current
      if (text.trim() || kept.length || q) setComposerDraft(sessionId, { text, pending: kept, quote: q || undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 登记为「正在显示的输入框」：撤回或退回的插入消息若属于本会话，直接放回这里（排在已有内容之前）。
  useLayoutEffect(() => {
    const entry = {
      sessionId,
      restore: (text: string, attachments: Picked[]): void => {
        setPending((cur) => mergePicked(attachments, cur))
        if (!text.trim()) return
        // 开头的引用放回引用条；引用条里已有（用户新放的）就留在文字里，不覆盖。
        const lq = quoteRef.current ? null : leadingQuote(text)
        if (lq) setQuote(lq.quote)
        const body = lq ? lq.rest : text
        const cur = composer.getText()
        composer.setText(cur.trim() ? (body ? `${body}\n\n${cur}` : cur) : body, true)
      }
    }
    liveComposer = entry
    return () => {
      if (liveComposer === entry) liveComposer = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div className="cf-composer">
      {/* 回到最新：仅当用户上滚离开底部且已有消息时浮现，锚在输入区正上方居中 */}
      {showJump && (
        <button
          className="cf-jump"
          type="button"
          onClick={onJump}
          title={t('chat.jumpToLatest')}
          aria-label={t('chat.jumpToLatest')}
        >
          <ChevronDown size={18} />
        </button>
      )}
      <div className="cf-composer__inner">
        {slashOpen && (
          <div className="cf-slash" ref={slashRef}>
            <div
              className="cf-slash__list"
              role="listbox"
              aria-label={t(mentionQuery !== null ? 'cf.slash.mentionTitle' : 'cf.slash.title')}
            >
              {slashMatches.map((c, i) => {
                const on = i === slashCur
                return (
                  <button
                    key={`${c.kind}:${c.name}`}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-on={on ? '1' : undefined}
                    className={`cf-slash__item${on ? ' is-on' : ''}`}
                    title={c.desc}
                    // 鼠标按下即采纳：抢在 blur 之前，输入框不失焦、光标不丢。
                    onMouseDown={(e) => {
                      e.preventDefault()
                      applySlash(c)
                    }}
                    onMouseEnter={() => setSlashSel(i)}
                  >
                    {c.kind === 'newMember' ? (
                      // 新建成员：虚线圈加号代替头像，与真实成员一眼分开
                      <span className="cf-slash__newface" aria-hidden="true">
                        <Plus size={11} strokeWidth={2.4} />
                      </span>
                    ) : c.kind === 'mention' ? (
                      <Avatar persona={c.persona} size={18} />
                    ) : c.kind === 'skill' ? (
                      <Puzzle size={14} />
                    ) : c.name === 'rewind' ? (
                      <RotateCcw size={14} />
                    ) : (
                      <Shrink size={14} />
                    )}
                    <span className={`cf-slash__name${c.kind === 'newMember' ? ' is-plain' : ''}`}>
                      {c.label ?? (c.kind === 'mention' ? `@${c.name}` : `/${c.name}`)}
                    </span>
                    {c.member && <span className="cf-slash__tag">{t('cf.member.tag')}</span>}
                    <span className="cf-slash__desc">{c.desc}</span>
                  </button>
                )
              })}
            </div>
            <div className="cf-slash__hint">{t('cf.slash.hint')}</div>
          </div>
        )}
        {/*
         * 输入框上方的胶囊排：待办清单、后台任务、浏览网页、插入对话，各自有内容才出现。
         * 实际先后按出现的先后（新出现的在最右，见 useDockOrder）；这里的书写顺序只在切会话、几枚同时出现时起作用——
         * 越常驻的越靠左，插入对话最短暂、最需要用户留意，放最后。
         */}
        <div className="cf-dock">
          <TodoCapsule />
          <BackgroundCapsule />
          <BrowserCapsule sessionId={sessionId} />
          <InsertCapsule sessionId={sessionId} />
        </div>
        <div className="cf-box">
          {/* 拖拽手柄压在输入框上边框：向上拖加高输入框。 */}
          <ResizeHandle
            axis="y"
            className="cf-resizer--box"
            value={boxH}
            title={t('cf.resizeComposer')}
            onChange={(v) => setComposerH(clampComposer(v, window.innerHeight))}
            onCommit={() => saveLayout({ composerHeight: boxHRef.current })}
            onReset={() => {
              setComposerH(COMPOSER_DEFAULT)
              saveLayout({ composerHeight: undefined })
            }}
          />
          {/* 待发附件：图片缩略图（点开看大图）在前，文件 / 文件夹卡片在后；悬停露出右上角的移除键。 */}
          <AttachmentList
            variant="composer"
            entries={pending.map((p) => ({
              id: p.path,
              name: p.name,
              // 不受支持的进不了 pending（addPicked 已滤掉），兜底按文本卡片画。
              kind: p.kind === 'unsupported' ? 'text' : p.kind,
              size: p.kind === 'folder' ? undefined : p.size,
              title: p.kind === 'folder' || p.kind === 'file' ? p.path : p.reason || p.name,
              src: p.kind === 'image' ? { path: p.path } : undefined
            }))}
            onRemove={removePending}
          />
          {/* 引用条（右键「引用」，同 TG 的回复）：在附件之后、文字之前；左竖线 + 灰字一行，悬停看全文；
              ✕ 取消引用，焦点回到输入框。 */}
          {quote && (
            <div className="cf-quotebar">
              <span className="cf-quotebar__text" title={quotePlain(quote, true)}>
                {quotePlain(quote)}
              </span>
              <button
                type="button"
                className="cf-quotebar__x"
                title={t('cf.quoteRemove')}
                aria-label={t('cf.quoteRemove')}
                onClick={() => {
                  setQuote('')
                  composer.focusEnd()
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {/* 输入区：Lexical 接管的 contentEditable（子节点归编辑器管，React 不渲染内容）；占位提示叠在其上。 */}
          <div className="cf-draft" style={{ height: boxH }}>
            <div
              ref={composer.rootRef}
              className="cf-draft__input"
              contentEditable
              role="textbox"
              aria-multiline
              aria-label={placeholder}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            {composer.empty && <div className="cf-draft__ph">{placeholder}</div>}
          </div>
          <div className="cf-box__bar">
            <button
              className="cf-iconbtn"
              title={t('cf.attach')}
              aria-label={t('cf.attach')}
              onClick={() => void pickFiles()}
            >
              <Paperclip size={16} />
            </button>
            {mounted && focusRoot ? (
              <span
                ref={wsRef}
                className="cf-wschip cf-wschip--mounted is-on"
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget) e.currentTarget.classList.remove('is-flash')
                }}
              >
                <WorkspaceMenu root={focusRoot} />
                <GitWidget root={focusRoot} streaming={streaming} />
                <button
                  type="button"
                  className="cf-wschip__x"
                  title={t('cf.unmountHint')}
                  aria-label={t('cf.unmountHint')}
                  onClick={() => onMount(null)}
                >
                  <X size={13} />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="cf-wschip"
                title={t('cf.mountHint')}
                onClick={pickWorkspace}
              >
                <FolderPlus size={15} />
                {t('cf.mountWorkspace')}
              </button>
            )}
            <ModelPanel />
            {/* 回合进行中只有一枚键：输入框有文字＝「发送」（插入当前轮），空＝「停止」（只放图标，与发送同宽不跳动）。
                有文字时不出停止，要停先清空输入框。 */}
            {streaming ? (
              canInsert ? (
                <button
                  className="cf-send"
                  type="button"
                  title={t('cf.insert.hint').replace('{name}', name)}
                  onClick={insertNow}
                >
                  {t('cf.send')}
                </button>
              ) : (
                <button
                  className="cf-send is-stop"
                  type="button"
                  title={t('chat.stop')}
                  aria-label={t('chat.stop')}
                  onClick={stopTurn}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )
            ) : (
              <button className="cf-send" type="button" disabled={!canSend} onClick={submit}>
                {t('cf.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
