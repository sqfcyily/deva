/**
 * 项目成员：标题栏成员条，以及对话末尾等用户处理的成员提问 / 计划 / 挂载 / 网页登录。
 */
import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Loader2,
  MessageSquare,
  Check,
  ChevronDown,
  ClipboardList,
  FolderOpen,
  UserMinus,
  Users
} from 'lucide-react'
import type { Persona } from '../mock/extensions'
import type {
  MemberMeta
} from '../../../preload'
import { type PendingCard, type SessionLiveState } from '../store/chat'
import { useI18n } from '../i18n/i18n'
import { AUTO_SHAPE, isAvatarShape, serializeAvatarSpec } from '../components/humation'
import { BlockView, formatDuration } from '../features/chat/blocks'
import { useRelativeTime, fill, Fold, Avatar } from './shell-common'

/* ============================ 项目成员（见 design/project-members-plan.html） ============================ */

/** 一个成员：名单里的元信息 + 显示用的身份（见 memberPersona）。 */
export interface MemberEntry {
  meta: MemberMeta
  persona?: Persona
}

/** 老成员（2026-11-11 前建的，没存形状）的头像 spec：形状按旧取法现算（冻结，不随形状库变），部件与配色按 seed 生成。 */
const LEGACY_MEMBER_AVATAR = serializeAvatarSpec({ shape: AUTO_SHAPE })

/**
 * 成员的显示身份：用户 @ 加入的角色就用该角色本身（名字、头像不变）；主智能体创建的用成员名与职责，
 * 头像以成员会话 id 为种子生成（同角色没设头像时的做法），每个成员各不相同；形状用创建时存下的 m.shape（老成员没有，按旧取法）。
 */
export function memberPersona(m: MemberMeta, personas: Persona[], fallback?: Persona): Persona | undefined {
  const own = personas.find((p) => p.id === m.personaId)
  if (m.origin === 'mention' && own) return own
  const base = own ?? fallback
  if (!base) return undefined
  const avatar = isAvatarShape(m.shape) ? serializeAvatarSpec({ shape: m.shape }) : LEGACY_MEMBER_AVATAR
  return { ...base, id: m.sessionId, name: m.name, desc: m.duty, avatar, avatarImage: '', model: '' }
}

/**
 * 标题栏角色名后的成员入口（对比稿 design/member-entry.html 方案 A）：只写「👥 N」，不放头像、不亮状态点——尽量不吸引
 * 注意力；成员在等你处理时对话末尾另有胶囊（见 MemberAsks），入口上不再重复。点开下拉出成员列表：顶部一行「N 位成员」，
 * 不写「几位工作中」之类的汇总；每行头像与名字，工作中 / 在等你处理时名字后一枚状态签，第二行是正在做的任务与用时 / 最近一次
 * 的结果 / 职责。点一行直接切到该成员的对话；悬停时行尾出现「移除成员」。没有成员时不占位置。
 */
export function MemberBar({
  members,
  sessionStates,
  waiting,
  onOpen,
  onRemove
}: {
  members: MemberEntry[]
  sessionStates: Record<string, SessionLiveState>
  /** 成员正等用户处理（提问 / 计划 / 选文件夹 / 网页上登录等）：列表里名字后写「在等你处理」。 */
  waiting: (memberSessionId: string) => boolean
  onOpen: (memberSessionId: string) => void
  onRemove: (m: MemberMeta) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const rel = useRelativeTime()
  // 列表开着时记入口按钮的左边，列表对齐它；null = 收起。
  const [at, setAt] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const open = at !== null
  // 点列表外、按 Esc、窗口失焦都收起。标题栏等窗口拖动区（-webkit-app-region: drag）上的点击页面收不到，
  // 开着时给 body 打 cf-pop-open，把拖动区临时改成可点击（见 redesign.css），点那里也能收起。
  useEffect(() => {
    if (!open) return
    const close = (): void => setAt(null)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    document.body.classList.add('cf-pop-open')
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      document.body.classList.remove('cf-pop-open')
    }
  }, [open])
  // 列表开着、有成员在工作时每秒刷新用时。
  const anyBusy = members.some((m) => sessionStates[m.meta.sessionId]?.streaming)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open || !anyBusy) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [open, anyBusy])
  if (!members.length) return null
  const countText = fill(t(members.length === 1 ? 'cf.member.countOne' : 'cf.member.count'), {
    n: String(members.length)
  })
  return (
    <div className="cf-members" ref={ref}>
      <button
        type="button"
        className={`cf-members__entry${open ? ' is-open' : ''}`}
        aria-label={countText}
        aria-expanded={open}
        onClick={(e) => setAt(open ? null : e.currentTarget.offsetLeft)}
      >
        <Users size={15} />
        {members.length}
      </button>
      {open && (
        <div className="cf-members__dd" style={{ left: at }}>
          <div className="cf-members__head">{countText}</div>
          {members.map(({ meta, persona }) => {
            const live = sessionStates[meta.sessionId]
            const wait = waiting(meta.sessionId)
            const busy = !wait && !!live?.streaming
            const last = meta.last
            let sub: React.ReactNode
            if (wait) {
              sub = <span className="cf-members__text">{meta.task || meta.duty}</span>
            } else if (busy) {
              sub = (
                <>
                  <Loader2 size={12} className="spin cf-members__now" />
                  <span className="cf-members__text">{meta.task || t('cf.member.doingUnknown')}</span>
                  {live?.startedAt && (
                    <span className="cf-members__time">
                      {formatDuration(Math.max(0, Math.floor((Date.now() - live.startedAt) / 1000)), t)}
                    </span>
                  )}
                </>
              )
            } else if (last) {
              const done = last.status === 'done'
              const word = done
                ? 'cf.member.recentDone'
                : last.status === 'failed'
                  ? 'cf.member.recentFailed'
                  : 'cf.member.recentStopped'
              sub = (
                <>
                  {done ? (
                    <ClipboardList size={12} className="cf-members__task" />
                  ) : (
                    <AlertCircle size={12} className="cf-members__bad" />
                  )}
                  <span className="cf-members__text">{last.task || meta.task || t(word)}</span>
                  <span className="cf-members__time">{rel(last.at)}</span>
                </>
              )
            } else {
              sub = <span className="cf-members__text">{meta.duty || t('cf.member.neverTasked')}</span>
            }
            return (
              <div key={meta.sessionId} className="cf-members__row">
                <button
                  type="button"
                  className="cf-members__open"
                  onClick={() => {
                    setAt(null)
                    onOpen(meta.sessionId)
                  }}
                >
                  <Avatar persona={persona} size={30} plain />
                  <span className="cf-members__main">
                    <span className="cf-members__line">
                      <span className="cf-members__name">{meta.name}</span>
                      {/* 只标要你处理的；工作中不加标签（第二行已有转圈 + 任务 + 用时） */}
                      {wait && <span className="cf-members__state is-wait">{t('cf.member.waitShort')}</span>}
                    </span>
                    <span className="cf-members__sub">{sub}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="cf-members__del"
                  aria-label={t('cf.member.remove')}
                  onClick={() => {
                    setAt(null)
                    onRemove(meta)
                  }}
                >
                  <UserMinus size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 成员正等你处理的事（对比稿 design/member-ask-inline.html 方案 A）：主对话末尾、「N 位成员已完成」之后，每件一枚居中胶囊
 * 「后端在等你回答」（外观同 MemberProgressNotice），只写谁在等什么，不写问题 / 计划的具体内容。最早的一件在胶囊下面直接
 * 展开卡片（提问 / 计划 / 选文件夹；卡头由胶囊代替，操作行里「打开对话」进成员的对话），其余收成胶囊排在下面，点胶囊收起 /
 * 展开。处理完卡片收起，胶囊换成「✓ 已回答后端」留在原位，下一件自动展开；等这一批全部处理完（没有还在等的）约 1 秒后，
 * 回执一起收起——几位成员同时在等、或主角色连着建几位成员时，不会处理一件就少一行、跳一下。出现、展开、收起、离开都是高度过渡（见 Fold），
 * 贴底时画面跟着平滑移动，不会跳一下。成员请你在网页上登录等（内置浏览器的
 * handoff）只放胶囊，点了打开浏览器窗口到那个网页。
 * 这些卡不进主对话记录、也不经主角色，答复直接回到成员的那一轮（对比稿 design/member-direct.html 的结论）。
 */
/**
 * 一件等你处理的事：成员会话里的提问 / 计划 / 选文件夹（sid = 成员会话），或主角色建成员时为新成员选文件夹
 * （sid = 主对话，isNew：成员还没建，没有头像和对话），或成员请你在网页上登录等（handoff：内置浏览器里等你操作的那个标签）。
 */
export type MemberWait = {
  sid: string
  name: string
  persona?: Persona
  isNew?: boolean
} & ({ card: PendingCard; handoff?: undefined } | { card?: undefined; handoff: BrowserHandoffWait })

/** 成员在内置浏览器里等你操作（同 BrowserUiState.handoff 的一项）。 */
type BrowserHandoffWait = { tab: string; reason: string; message: string }

const BROWSER_WAIT_REASONS = new Set(['login', 'captcha', 'upload', 'confirm', 'other'])

/**
 * 全部处理完（没有还在等的）后，回执「✓ 已回答后端」再停留多久一起收起（毫秒）。也是连着来的下一件的宽限：主角色一步里
 * 建几位成员时，选文件夹的卡是逐张弹出的，选完一张到下一张出现之间这一下不算「全部处理完」。
 */
const MEMBER_RECEIPT_HOLD_MS = 1100

/** 一行（胶囊 + 卡片）收起的时长（毫秒），同 CSS .cf-mask 的 --fold-dur；放完再移除。 */
const MEMBER_ROW_OUT_MS = 300

/** 一件等你处理的事的稳定标识（React key、展开状态都用它）。 */
const memberWaitId = (w: MemberWait): string => (w.handoff ? `ho:${w.sid}` : `${w.sid}:${w.card.key}`)

/**
 * 正在离开的一行：你刚处理完的（text = 回执文案，先停留再收起），或在别处处理掉 / 撤销的（text 为空，直接收起）。
 * 离开期间照旧画在原来的位置（同一个 key、同一个 DOM），收起的过渡才连得上；卡片也还是那张，你的选择不会闪掉。
 */
type MemberAskLeaving = {
  seq: number
  id: string
  wait: MemberWait
  /** 离开时排在第几行：留在原位收起。 */
  index: number
  text: string
  ok: boolean
  /** 整行开始收起。 */
  out: boolean
}

export function MemberAsks({
  waits,
  onAsk,
  onPlan,
  onMountReq,
  onOpenMember
}: {
  waits: MemberWait[]
  onAsk: (key: string, answers: string[], sessionId?: string) => void
  onPlan: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string, sessionId?: string) => void
  onMountReq: (key: string, path: string | null, sessionId?: string) => void
  onOpenMember: (memberSessionId: string) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  // 展开的那件：undefined = 自动（最早一件卡片），null = 用户收起了，字符串 = 用户点开的那件（不在了按自动处理）。
  const [open, setOpen] = useState<string | null | undefined>(undefined)
  const [leaving, setLeaving] = useState<MemberAskLeaving[]>([])
  // 挂载时已在的几件：直接显示，不放进场过渡。
  const [initialIds] = useState(() => new Set(waits.map(memberWaitId)))
  const seq = useRef(0)
  const timers = useRef<number[]>([])
  const scheduled = useRef(new Set<number>())
  useEffect(() => () => timers.current.forEach((h) => window.clearTimeout(h)), [])

  const resolveOpen = (list: MemberWait[]): string | null => {
    const cards = list.filter((w) => !w.handoff)
    if (open === null) return null
    if (open !== undefined && cards.some((w) => memberWaitId(w) === open)) return open
    return cards.length ? memberWaitId(cards[0]) : null
  }

  // 在别处处理掉 / 撤销的（成员对话里答了、网页上登录完了、成员被停止）：同样留在原位收起，不突然少一截。
  const sig = waits.map(memberWaitId).join('\n')
  const [prev, setPrev] = useState(() => ({ sig, waits }))
  if (prev.sig !== sig) {
    const cur = new Set(waits.map(memberWaitId))
    const gone = prev.waits
      .map((w, index) => ({ w, index }))
      .filter(({ w }) => !cur.has(memberWaitId(w)) && !leaving.some((l) => l.id === memberWaitId(w)))
    if (gone.length)
      setLeaving((ls) => [
        ...ls,
        ...gone.map(({ w, index }) => ({
          seq: ++seq.current,
          id: memberWaitId(w),
          wait: w,
          index,
          text: '',
          ok: false,
          out: true
        }))
      ])
    setPrev({ sig, waits })
  }

  // 开始收起的行：放完收起过渡即移除。
  useEffect(() => {
    for (const l of leaving) {
      if (!l.out || scheduled.current.has(l.seq)) continue
      scheduled.current.add(l.seq)
      timers.current.push(window.setTimeout(() => setLeaving((ls) => ls.filter((x) => x.seq !== l.seq)), MEMBER_ROW_OUT_MS))
    }
  }, [leaving])

  // 回执留在原位，直到没有还在等的（含网页上等你操作的）：再停留片刻，一起收起。期间又来了一件就重新等。
  const holding = leaving.some((l) => !l.out)
  // 你刚处理的那件在主进程撤下之前仍在 waits 里，不算还在等。
  const pendingCount = waits.filter((w) => !leaving.some((l) => l.id === memberWaitId(w))).length
  useEffect(() => {
    if (!holding || pendingCount > 0) return
    const h = window.setTimeout(
      () => setLeaving((ls) => ls.map((x) => (x.out ? x : { ...x, out: true }))),
      MEMBER_RECEIPT_HOLD_MS
    )
    return () => window.clearTimeout(h)
  }, [holding, pendingCount])

  // 画的行 = 还在等的 + 正在离开的（插回原位）。
  const leavingIds = new Set(leaving.map((l) => l.id))
  const rows: { w: MemberWait; leave?: MemberAskLeaving }[] = waits
    .filter((w) => !leavingIds.has(memberWaitId(w)))
    .map((w) => ({ w }))
  for (const l of [...leaving].sort((a, b) => a.index - b.index))
    rows.splice(Math.min(l.index, rows.length), 0, { w: l.wait, leave: l })
  if (!rows.length) return null
  // 刚处理的那件不参与：下一件随它收起同时展开，不等主进程撤下它。
  const openId = resolveOpen(waits.filter((w) => !leavingIds.has(memberWaitId(w))))

  // 处理完一件：留回执，卡片收起，下一件自动展开。
  const done = (w: MemberWait, index: number, key: string, ok: boolean): void => {
    setLeaving((ls) => [
      ...ls,
      { seq: ++seq.current, id: memberWaitId(w), wait: w, index, text: fill(t(key), { name: w.name }), ok, out: false }
    ])
    setOpen(undefined)
  }

  return (
    // 几件排成一组：组内行距比消息列小（见 CSS .cf-masks）。
    <div className="cf-masks">
      {rows.map(({ w, leave }, index) => {
        const id = memberWaitId(w)
        const { sid, name, persona, isNew } = w
        const instant = initialIds.has(id)
        const face = isNew ? (
          <span className="cf-mask__icon" aria-hidden="true">
            <FolderOpen size={11} />
          </span>
        ) : (
          <Avatar persona={persona} size={18} plain />
        )
        const receipt = leave?.text ? (
          <span className={`cf-mask__pill is-done${leave.ok ? ' is-ok' : ''}`}>
            <Check size={13} />
            <span className="cf-mask__text">{leave.text}</span>
          </span>
        ) : null

        if (w.handoff) {
          // 网页上等你操作：点胶囊打开浏览器窗口、切到那个标签（窗口里有「完成，继续」「跳过」），不在这里展开。
          const reason = BROWSER_WAIT_REASONS.has(w.handoff.reason) ? w.handoff.reason : 'other'
          const tab = w.handoff.tab
          return (
            <Fold key={id} className="cf-mask" open={!leave?.out} instant={instant}>
              <button
                type="button"
                className="cf-mask__pill"
                title={w.handoff.message || undefined}
                onClick={() => {
                  if (!leave) void window.deva.browser.open({ tab })
                }}
              >
                {face}
                <span className="cf-mask__text">{fill(t(`cf.member.waitBrowser.${reason}`), { name })}</span>
                <span className="cf-mask__go">{t('browser.goHandle')}</span>
              </button>
            </Fold>
          )
        }

        const card = w.card
        const isOpen = !leave && openId === id
        const label =
          card.kind === 'ask'
            ? 'cf.member.waitAsk'
            : card.kind === 'plan'
              ? 'cf.member.waitPlan'
              : isNew
                ? 'cf.member.waitPick'
                : 'cf.member.waitMount'
        // 只有展开着的那张接受操作；收起中 / 离开中的点了也不再提交。
        const live = isOpen
        // 选文件夹卡的说明：「不限」在新建成员时 = 不指定文件夹（不跟随主对话，之后可在成员对话里再选）；成员做到一半
        // 来要时 = 成员改用完整路径。
        const mountHint =
          card.kind !== 'mount'
            ? undefined
            : isNew
              ? t('cf.member.noLimitNone')
              : fill(t('cf.member.noLimitPaths'), { name })
        return (
          <Fold key={id} className="cf-mask" open={!leave?.out} instant={instant}>
            {receipt ?? (
              <button
                type="button"
                className={`cf-mask__pill${isOpen ? ' is-open' : ''}`}
                aria-expanded={isOpen}
                title={isOpen ? t('cf.member.waitFold') : undefined}
                onClick={() => {
                  if (!leave) setOpen(isOpen ? null : id)
                }}
              >
                {face}
                <span className="cf-mask__text">{fill(t(label), { name })}</span>
                <ChevronDown size={13} className="cf-mask__chev" />
              </button>
            )}
            {/* 卡片常驻（收起只是折叠），收起再展开时作答到一半的选择还在。 */}
            <Fold className="cf-mask__fold" open={isOpen} instant={instant}>
              <div className="cf-mask__card">
                <BlockView
                  block={card}
                  thinkingDone
                  bare
                  hint={mountHint}
                  extra={
                    isNew ? undefined : (
                      <button type="button" className="cf-mask__open" onClick={() => live && onOpenMember(sid)}>
                        <MessageSquare size={12} />
                        {t('cf.member.viewLog')}
                      </button>
                    )
                  }
                  onAsk={(k, a) => {
                    if (!live) return
                    onAsk(k, a, sid)
                    const answered = a.some((x) => x.trim())
                    done(w, index, answered ? 'cf.member.doneAsk' : 'cf.member.doneAskSkip', answered)
                  }}
                  onPlan={(k, d, f) => {
                    if (!live) return
                    onPlan(k, d, f, sid)
                    done(
                      w,
                      index,
                      d === 'approve' ? 'cf.member.doneApprove' : d === 'ignore' ? 'cf.member.doneIgnore' : 'cf.member.doneReply',
                      d !== 'ignore'
                    )
                  }}
                  onMountReq={(k, p) => {
                    if (!live) return
                    onMountReq(k, p, sid)
                    done(w, index, p ? 'cf.member.donePick' : isNew ? 'cf.member.doneNoLimit' : 'cf.member.doneNoMount', !!p)
                  }}
                />
              </div>
            </Fold>
          </Fold>
        )
      })}
    </div>
  )
}
