import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw, SquareTerminal, Undo2 } from 'lucide-react'
import type {
  RewindApplyResult,
  RewindFile,
  RewindMode,
  RewindPreview,
  RewindTurnStat,
  RewindUndoResult
} from '../../../preload'
import { Modal } from '../components/Modal'
import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n/i18n'
import { useChat } from '../store/chat'

/** 列表里的一轮：turn 与渲染层 groupTurns / 主进程 turnRanges 同源（0 基）；text 为提问摘要。 */
export interface RewindTurnItem {
  turn: number
  text: string
}

type RewindError =
  | Extract<RewindApplyResult, { ok: false }>['error']
  | Extract<RewindUndoResult, { ok: false }>['error']

/**
 * 检查点回滚面板（对标 Claude Code /rewind）：列表屏选一轮 → 详情屏看将被撤回的文件（+N −M、冲突、
 * 链接跳过）与无法撤销的命令 → 选「代码和对话 / 仅对话 / 仅代码」。v1 刻意不做 diff，只给行数统计。
 * 预览只是给人看的：主进程执行时按记录重算一遍，不信任这里传回的任何东西（除了勾选覆盖的冲突路径）。
 */
export function RewindModal({
  sessionId,
  turns,
  initialTurn,
  promptOf,
  onClose,
  onPrefill
}: {
  sessionId: string
  turns: RewindTurnItem[]
  /** 直接打开某轮详情（右键「回到此处」）；null = 从列表开始。 */
  initialTurn: number | null
  /** 取某轮提问原文（不含附件）：回滚前调用，回滚后该轮消息已不在了。 */
  promptOf: (turn: number) => string
  onClose: () => void
  /** 恢复了对话后，用该轮原问题预填输入框（交由用户修改后重发）。 */
  onPrefill: (text: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const { rewindApply, rewindUndo } = useChat()
  const [stats, setStats] = useState<{ turns: RewindTurnStat[]; canUndo: boolean } | null>(null)
  const [sel, setSel] = useState<number | null>(initialTurn)
  // 按轮缓存预览结果；preview.turn !== sel 即加载中（免得另设 loading 态与之失同步）。
  const [preview, setPreview] = useState<{ turn: number; data: RewindPreview | null } | null>(
    null
  )
  const [force, setForce] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    window.deva.chat
      .rewindList(sessionId)
      .then((r) => live && setStats(r))
      .catch(() => live && setStats({ turns: [], canUndo: false }))
    return () => {
      live = false
    }
  }, [sessionId])

  useEffect(() => {
    setForce(new Set())
    if (sel === null) return
    let live = true
    window.deva.chat
      .rewindPreview(sessionId, sel)
      .then((data) => live && setPreview({ turn: sel, data }))
      .catch(() => live && setPreview({ turn: sel, data: null }))
    return () => {
      live = false
    }
  }, [sessionId, sel])

  const errText = (e: RewindError | undefined): string =>
    e === 'busy'
      ? t('cf.rewind.busy')
      : e === 'bad-turn'
        ? t('cf.rewind.badTurn')
        : e === 'no-undo'
          ? t('cf.rewind.noUndo')
          : t('cf.rewind.failed')

  const countText = (restored: number, skipped: number): string | undefined => {
    const parts: string[] = []
    if (restored > 0) parts.push(t('cf.rewind.restoredN').replace('{n}', String(restored)))
    if (skipped > 0) parts.push(t('cf.rewind.skippedN').replace('{n}', String(skipped)))
    return parts.length ? parts.join(' · ') : undefined
  }

  // 撤销会从 toast 上触发，那时本面板早已卸载：只用上下文里的稳定引用、不碰本组件状态；
  // 会话 id 钉死为本次回滚的会话，用户中途切走也撤不到别处。
  const undo = async (id: string): Promise<void> => {
    let r: RewindUndoResult | null = null
    try {
      r = await rewindUndo(id)
    } catch {
      r = null
    }
    if (!r?.ok) {
      toast.show({ variant: 'error', message: errText(r?.error) })
      return
    }
    toast.show({
      variant: 'success',
      title: t('cf.rewind.undone'),
      message: countText(0, r.skipped.length)
    })
  }

  const apply = async (mode: RewindMode): Promise<void> => {
    if (sel === null || busy) return
    const turn = sel
    const prompt = mode === 'code' ? '' : promptOf(turn)
    setBusy(true)
    let res: RewindApplyResult | null = null
    try {
      res = await rewindApply(turn, mode, [...force])
    } catch {
      res = null
    } finally {
      setBusy(false)
    }
    if (!res?.ok) {
      toast.show({ variant: 'error', title: t('cf.rewind.failed'), message: errText(res?.error) })
      return
    }
    onClose()
    if (prompt) onPrefill(prompt)
    // 仅恢复代码且一个文件都没写成时主进程不留撤销快照，此时也就不给「撤销」。
    const changed = mode !== 'code' || res.restored.length > 0
    toast.show({
      variant: 'success',
      title: t('cf.rewind.done'),
      message: countText(res.restored.length, res.skipped.length),
      action: changed ? { label: t('cf.rewind.undo'), onClick: () => void undo(sessionId) } : undefined
    })
  }

  const undoFromList = (): void => {
    onClose()
    void undo(sessionId)
  }

  // 新近的轮在上：回滚几乎总是回到刚才那几轮。
  const ordered = useMemo(() => [...turns].reverse(), [turns])
  const current = sel === null ? undefined : turns.find((x) => x.turn === sel)

  const body =
    sel === null ? (
      <>
        <p className="cf-rewind__hint">{t('cf.rewind.listHint')}</p>
        {stats?.canUndo && (
          <button type="button" className="btn btn--ghost cf-rewind__undo" onClick={undoFromList}>
            <Undo2 size={14} />
            {t('cf.rewind.undoLast')}
          </button>
        )}
        {ordered.length === 0 ? (
          <p className="cf-rewind__empty">{t('cf.rewind.empty')}</p>
        ) : (
          <div className="cf-rewind__list">
            {ordered.map((it) => {
              const st = stats?.turns[it.turn]
              return (
                <button
                  key={it.turn}
                  type="button"
                  className="cf-rewind__turn"
                  onClick={() => setSel(it.turn)}
                  title={it.text}
                >
                  <span className="cf-rewind__idx">{it.turn + 1}</span>
                  <span className="cf-rewind__text">{it.text}</span>
                  <span className="cf-rewind__meta">
                    {st?.hasExec && (
                      <span className="cf-rewind__exec" title={t('cf.rewind.hasExec')}>
                        <SquareTerminal size={13} />
                      </span>
                    )}
                    {st && st.fileCount > 0 && (
                      <>
                        <LineStat added={st.added} removed={st.removed} approx={st.approx} />
                        <span>{t('cf.rewind.files').replace('{n}', String(st.fileCount))}</span>
                      </>
                    )}
                  </span>
                  <ChevronRight size={14} className="cf-rewind__chev" />
                </button>
              )
            })}
          </div>
        )}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('cf.cancel')}
          </button>
        </div>
      </>
    ) : (
      <Detail
        text={current?.text ?? ''}
        preview={preview?.turn === sel ? preview.data : undefined}
        force={force}
        busy={busy}
        onToggleForce={(path) =>
          setForce((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
          })
        }
        onBack={() => setSel(null)}
        onApply={(mode) => void apply(mode)}
        onCancel={onClose}
      />
    )

  return (
    <Modal open onClose={onClose} width={540} labelledBy="cf-rewind-title">
      <h2 id="cf-rewind-title" className="modal__title cf-rewind__title">
        <RotateCcw size={15} />
        {t('cf.rewind.title')}
      </h2>
      {body}
    </Modal>
  )
}

function Detail({
  text,
  preview,
  force,
  busy,
  onToggleForce,
  onBack,
  onApply,
  onCancel
}: {
  text: string
  /** undefined = 加载中；null = 该轮已不存在（会话被改写 / 已删）。 */
  preview: RewindPreview | null | undefined
  force: Set<string>
  busy: boolean
  onToggleForce: (path: string) => void
  onBack: () => void
  onApply: (mode: RewindMode) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const files = preview?.files ?? []
  const commands = preview?.commands.length ?? 0
  // 全是「无需改动」时仅恢复代码什么也不会做，涉及代码的两个按钮一并收起。
  const codeable = files.some((f) => f.action !== 'none')

  return (
    <>
      <div className="cf-rewind__head">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          <ChevronLeft size={14} />
          {t('cf.rewind.back')}
        </button>
        <span className="cf-rewind__hint">{t('cf.rewind.detailHint')}</span>
      </div>
      {text && (
        <blockquote className="cf-rewind__quote" title={text}>
          {text}
        </blockquote>
      )}

      {preview === undefined ? (
        <p className="cf-rewind__empty">{t('cf.rewind.loading')}</p>
      ) : preview === null ? (
        <p className="cf-rewind__empty">{t('cf.rewind.badTurn')}</p>
      ) : (
        <>
          <div className="cf-rewind__section">
            <div className="cf-rewind__label">{t('cf.rewind.filesHeading')}</div>
            {files.length === 0 ? (
              <p className="cf-rewind__empty">{t('cf.rewind.noFiles')}</p>
            ) : (
              <ul className="cf-rewind__files">
                {files.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    forced={force.has(f.path)}
                    onToggle={() => onToggleForce(f.path)}
                  />
                ))}
              </ul>
            )}
          </div>
          {/* 命令只给一句提示不逐条列出：一轮常跑几十条，列表会把文件区挤没。 */}
          {commands > 0 && (
            <div className="cf-rewind__label cf-rewind__label--warn">
              <SquareTerminal size={13} />
              {t('cf.rewind.commandsHint').replace('{n}', String(commands))}
            </div>
          )}
        </>
      )}

      <div className="modal__actions cf-rewind__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          {t('cf.cancel')}
        </button>
        {codeable && (
          <button
            type="button"
            className="btn"
            onClick={() => onApply('code')}
            disabled={busy || !preview}
          >
            {t('cf.rewind.code')}
          </button>
        )}
        <button
          type="button"
          className={`btn${codeable ? '' : ' btn--primary'}`}
          onClick={() => onApply('conversation')}
          disabled={busy || !preview}
        >
          {t('cf.rewind.conversation')}
        </button>
        {codeable && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onApply('both')}
            disabled={busy || !preview}
            autoFocus
          >
            {t('cf.rewind.both')}
          </button>
        )}
      </div>
    </>
  )
}

function FileRow({
  file,
  forced,
  onToggle
}: {
  file: RewindFile
  forced: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 冲突之外的非 ok 状态主进程一律给 action=none（根本没算动作），徽标显「跳过」而非误导的「无需改动」。
  const blocked = file.status !== 'ok' && file.status !== 'conflict'
  const skipped = blocked || (file.status === 'conflict' && !forced)
  const badge = blocked ? 'skip' : file.action
  return (
    <li className={`cf-rewind__file${skipped || file.action === 'none' ? ' is-dim' : ''}`}>
      <div className="cf-rewind__fileline">
        <span className={`cf-rewind__badge is-${badge}`}>{t(`cf.rewind.action.${badge}`)}</span>
        <span className="cf-rewind__path" title={file.path}>
          {file.rel}
        </span>
        {file.action !== 'none' &&
          (file.binary ? (
            <span className="cf-rewind__changed">{t('cf.rewind.changed')}</span>
          ) : file.added !== undefined || file.removed !== undefined ? (
            <LineStat added={file.added ?? 0} removed={file.removed ?? 0} approx={file.approx} />
          ) : null)}
      </div>
      {file.status !== 'ok' && (
        <div className="cf-rewind__status">
          <span>{t(`cf.rewind.status.${file.status}`)}</span>
          {file.status === 'conflict' && (
            <label className="cf-rewind__force">
              <input type="checkbox" checked={forced} onChange={onToggle} />
              {t('cf.rewind.force')}
            </label>
          )}
        </div>
      )}
    </li>
  )
}

/** +N −M 行数统计；approx（近似 / 含二进制或过大文件）时前缀 ~。 */
function LineStat({
  added,
  removed,
  approx
}: {
  added: number
  removed: number
  approx?: boolean
}): React.JSX.Element {
  const p = approx ? '~' : ''
  return (
    <span className="cf-rewind__stat">
      <span className="cf-rewind__add">{`${p}+${added}`}</span>
      <span className="cf-rewind__del">{`${p}−${removed}`}</span>
    </span>
  )
}
