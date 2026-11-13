/**
 * 版本控制：分支与变更状态、工作区菜单、提交对话框（含 AI 生成提交信息）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  ArrowRightLeft,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type {
  GitBranch as GitBranchEntry,
  GitFailReason,
  GitGenLocale,
  GitGenModel,
  GitOpResult,
  GitStatus
} from '../../../preload'
import { useChatState } from '../store/chat'
import { findActive, useModels } from '../store/models'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast, type ToastOptions } from '../components/ToastProvider'
import { Modal } from '../components/Modal'
import { basename } from './shell-common'
import { type CtxEntry, ContextMenu } from './ContextMenu'

/* ─────────────────────────── Git 快捷面板（IDEA 式点击浮出） ───────────────────────────
 * 挂载工作区若是 git 仓库，则在挂载 chip 里跟一枚分支 pill，点击浮出常用操作。
 * 后端（services/git.ts + window.deva.git.*）早已齐备；此处只是薄薄一层 renderer UI。
 * 安全：focusRoot 在 fs:open-folder 时已 trustRoot，git:status 内部 assertInside——复用既有受信根，
 * 不新增任何越权面，也不弹权限框（与「全放行 + 静默硬底线」一致）。
 */

/** git 是否可用：全应用只探一次（缓存 Promise），避免每次挂载都 spawn 一次 --version。 */
let gitAvailablePromise: Promise<boolean> | null = null

function probeGitAvailable(): Promise<boolean> {
  if (!gitAvailablePromise) {
    gitAvailablePromise = window.deva.git
      .available()
      .then((r) => r.available)
      .catch(() => false)
  }
  return gitAvailablePromise
}

/** GitFailReason → 本地化文案；缺 key 时回落到通用「操作失败」。 */
function gitReasonText(t: (k: string) => string, reason?: GitFailReason): string {
  const key = `cf.git.err.${reason || 'error'}`
  const s = t(key)
  return s === key ? t('cf.git.err.error') : s
}

/** DOM 侧硬上限：仅防止极端超长输出撑大节点；可见的「最多 5 行 + …」由 CSS line-clamp 负责。 */
const GIT_ERR_DETAIL_MAX = 4000

/** 归一 git 命令输出（stderr）用于展示：去 \r（进度符）、去首尾空白、超长硬截断；空则返回空串。 */
function gitErrorDetail(message?: string): string {
  if (!message) return ''
  const s = message.replace(/\r/g, '').trim()
  if (!s) return ''
  return s.length > GIT_ERR_DETAIL_MAX ? s.slice(0, GIT_ERR_DETAIL_MAX) : s
}

/**
 * 构造 git 失败 toast：标题=归类文案（认证失败/被拒绝…），正文=命令实际输出（截断）。
 * 无输出时退化为仅标题一行；有输出时延长停留时间，便于阅读原因。
 */
function gitErrorToast(
  t: (k: string) => string,
  r: { reason?: GitFailReason; message?: string }
): ToastOptions {
  const title = gitReasonText(t, r.reason)
  const detail = gitErrorDetail(r.message)
  return detail
    ? { variant: 'error', title, message: <span className="cf-giterr">{detail}</span>, duration: 8000 }
    : { variant: 'error', message: title }
}

/**
 * 分支名基础校验（git check-ref-format 的常见规则）：不合规时「创建」按钮置灰，其余细则交给 git 报错。
 * 拒绝前导 `-` 同时杜绝名字被 git 当成命令行选项。
 */
function isValidBranchName(raw: string): boolean {
  const s = raw.trim()
  if (!s || s === '@' || /^[-./]/.test(s) || /[/.]$/.test(s) || s.endsWith('.lock')) return false
  if (s.includes('..') || s.includes('@{') || s.includes('//') || s.includes('/.')) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(s)
}

interface GitState {
  available: boolean
  status: GitStatus | null
  busy: boolean
  refresh: () => Promise<void>
}

/**
 * 读取某工作区的 git 状态。不轮询（status 每次 spawn git 进程，且当前无文件监听）：
 * 只在「挂载 / 开菜单 / 每次写操作后」拉取。用 reqRef 防竞态——快速切换工作区时旧结果不覆盖新。
 */
function useGitStatus(root: string | null): GitState {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++reqRef.current
    if (!root) {
      setAvailable(false)
      setStatus(null)
      return
    }
    const ok = await probeGitAvailable()
    if (seq !== reqRef.current) return
    setAvailable(ok)
    if (!ok) {
      setStatus(null)
      return
    }
    setBusy(true)
    try {
      const st = await window.deva.git.status(root)
      if (seq !== reqRef.current) return
      setStatus(st.isRepo ? st : null)
    } catch {
      if (seq === reqRef.current) setStatus(null)
    } finally {
      if (seq === reqRef.current) setBusy(false)
    }
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { available, status, busy, refresh }
}

/**
 * 挂载 chip 里的分支 pill + 快捷菜单。仅当 git 可用且目标是仓库时渲染，否则返回 null（非仓库 / 没装 git 静默隐藏）。
 * 菜单复用 ContextMenu（视口定位 + 越界夹回），始终只显示一级：点「分支」原地换成分支列表（含合并分支 / 新建分支），
 * 点某个分支再换成它的操作（切换 / 重命名 / 删除）。「提交」开 CommitModal。
 */
type GitMenuView =
  | { kind: 'main' }
  | { kind: 'branches' }
  | { kind: 'merge' }
  | { kind: 'branch'; branch: GitBranchEntry }

export function GitWidget({ root, streaming }: { root: string; streaming: boolean }): React.JSX.Element | null {
  const { t, locale } = useI18n()
  const toast = useToast()
  const dialog = useDialog()
  const { activeModel, providers, hasKey } = useModels()
  const { currentBinding } = useChatState()
  const { available, status, busy, refresh } = useGitStatus(root)

  // 一轮结束（正常完成 / 中断 / 出错，streaming 由 true 落为 false）后刷新一次：
  // 本轮可能改了文件，pill 上的状态与提交框的改动清单随之更新。
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])

  const [menu, setMenu] = useState<{ x: number; y: number; view: GitMenuView } | null>(null)
  const [branches, setBranches] = useState<GitBranchEntry[]>([])
  const [commitOpen, setCommitOpen] = useState(false)
  const [opBusy, setOpBusy] = useState(false)
  const pillRef = useRef<HTMLButtonElement>(null)

  if (!available || !status || !status.isRepo) return null

  const label = status.detached ? t('cf.git.detached') : status.branch || t('cf.git.noBranch')
  const fmt = (key: string, name: string): string => t(key).replace('{name}', name)

  // 锚点取 pill 上边缘（留 4px 间隙）；ContextMenu 以 openUp 把它当底边向上浮出，
  // 避免菜单向下遮挡下方的输入区/角色卡（挂载 chip 贴近视口底部）。
  // 打开前先拉分支列表（本地命令，很快），使「分支」视图点开即有内容。
  const openMenu = async (): Promise<void> => {
    const el = pillRef.current
    if (!el) return
    try {
      setBranches(await window.deva.git.branches(root))
    } catch {
      setBranches([])
    }
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.top - 4, view: { kind: 'main' } })
  }

  // 切换菜单视图：ContextMenu 点击时先 onClose（置 null）再 onClick，故这里直接写入完整状态覆盖之。
  const go = (view: GitMenuView): void => {
    if (menu) setMenu({ x: menu.x, y: menu.y, view })
  }

  // 统一执行一个 git 写操作：置忙 → 调用 → 据结果 toast → 刷新状态。
  const run = async (
    fn: () => Promise<{ ok: boolean; reason?: GitFailReason; message?: string }>,
    okMsg: string
  ): Promise<void> => {
    setOpBusy(true)
    try {
      const r = await fn()
      if (r.ok) toast.show({ variant: 'success', message: okMsg })
      else toast.show(gitErrorToast(t, r))
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setOpBusy(false)
      void refresh()
    }
  }

  // 新建分支：基于当前 HEAD 创建并立即切过去（git checkout -b），未提交的改动随之带到新分支。
  const createBranch = async (): Promise<void> => {
    const name = await dialog.prompt({
      title: t('cf.git.createBranchTitle'),
      message: t('cf.git.createBranchHint'),
      label: t('cf.git.newBranchName'),
      placeholder: 'feature/…',
      confirmText: t('cf.git.createBranchDo'),
      validate: isValidBranchName
    })
    if (!name) return
    await run(() => window.deva.git.createBranch(root, name, true), fmt('cf.git.doneCreateBranch', name))
  }

  // 合并到当前分支：冲突时不当作普通失败——提示去解决或中止，并给「中止合并」快捷按钮。
  const mergeBranch = async (ref: string): Promise<void> => {
    setOpBusy(true)
    try {
      const r = await window.deva.git.merge(root, ref)
      if (r.ok) toast.show({ variant: 'success', message: fmt('cf.git.doneMerge', ref) })
      else if (r.reason === 'conflict')
        toast.show({
          variant: 'warning',
          title: t('cf.git.mergeConflictTitle'),
          message: t('cf.git.mergeConflictHint'),
          action: { label: t('cf.git.abortMerge'), onClick: () => void abortMerge(false) }
        })
      else toast.show(gitErrorToast(t, r))
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setOpBusy(false)
      void refresh()
    }
  }

  // 中止合并会丢弃已做的冲突解决，菜单入口先确认（toast 快捷按钮紧随合并失败，直接执行）。
  const abortMerge = async (confirm: boolean): Promise<void> => {
    if (
      confirm &&
      !(await dialog.confirm({
        title: t('cf.git.abortMergeTitle'),
        message: t('cf.git.abortMergeHint'),
        variant: 'danger',
        confirmText: t('cf.git.abortMerge')
      }))
    )
      return
    await run(() => window.deva.git.mergeAbort(root), t('cf.git.doneAbortMerge'))
  }

  // 删除本地分支：先确认 → -d；未合并则再确认一次（写明会丢失的提交数）→ -D。
  const deleteBranch = async (name: string): Promise<void> => {
    const ok = await dialog.confirm({
      title: fmt('cf.git.deleteBranchTitle', name),
      message: t('cf.git.deleteBranchHint'),
      variant: 'danger',
      confirmText: t('cf.git.delete')
    })
    if (!ok) return
    const done = fmt('cf.git.doneDeleteBranch', name)
    let first: GitOpResult
    try {
      first = await window.deva.git.deleteBranch(root, name, false)
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
      return
    }
    if (!first.ok && first.reason === 'unmerged') {
      const force = await dialog.confirm({
        title: t('cf.git.forceDeleteTitle'),
        message: t('cf.git.forceDeleteHint').replace('{name}', name).replace('{n}', String(first.count ?? 0)),
        variant: 'danger',
        confirmText: t('cf.git.forceDelete')
      })
      if (force) await run(() => window.deva.git.deleteBranch(root, name, true), done)
      return
    }
    await run(async () => first, done)
  }

  const renameBranch = async (oldName: string): Promise<void> => {
    const name = await dialog.prompt({
      title: t('cf.git.renameBranchTitle'),
      label: t('cf.git.newBranchName'),
      defaultValue: oldName,
      confirmText: t('cf.git.rename'),
      validate: (v) => isValidBranchName(v) && v.trim() !== oldName
    })
    if (!name) return
    await run(() => window.deva.git.renameBranch(root, oldName, name), fmt('cf.git.doneRenameBranch', name))
  }

  const deleteRemoteBranch = async (b: GitBranchEntry): Promise<void> => {
    if (!b.remote) return
    const remote = b.remote
    const ok = await dialog.confirm({
      title: fmt('cf.git.deleteRemoteTitle', b.name),
      message: t('cf.git.deleteRemoteHint'),
      variant: 'danger',
      confirmText: t('cf.git.delete')
    })
    if (!ok) return
    await run(
      () => window.deva.git.deleteRemoteBranch(root, remote, b.name.slice(remote.length + 1)),
      fmt('cf.git.doneDeleteBranch', b.name)
    )
  }

  // 切换分支；远程分支：本地已有同名分支则直接切过去，否则建跟踪分支（checkout --track）。
  const checkout = (b: GitBranchEntry): void => {
    const done = t('cf.git.doneCheckout')
    if (!b.remote) {
      void run(() => window.deva.git.checkout(root, b.name), done)
      return
    }
    const short = b.name.slice(b.remote.length + 1)
    if (branches.some((x) => !x.remote && x.name === short))
      void run(() => window.deva.git.checkout(root, short), done)
    else void run(() => window.deva.git.checkoutRemote(root, b.name), done)
  }

  const spacer = <span style={{ width: 14, display: 'inline-block' }} />
  const filterItem: CtxEntry[] =
    branches.length > 8 ? [{ kind: 'filter', placeholder: t('cf.git.filterBranches') }] : []
  // 分支列表（本地 / 远程分组）：onPick 决定点击某分支后做什么（进操作视图 / 直接合并）
  const branchList = (list: GitBranchEntry[], onPick: (b: GitBranchEntry) => void): CtxEntry[] => {
    const local = list.filter((b) => !b.remote)
    const remote = list.filter((b) => b.remote)
    const row = (b: GitBranchEntry): CtxEntry => ({
      label: b.name,
      icon: b.current ? <Check size={14} /> : spacer,
      title: b.upstream ? `↑ ${b.upstream}` : undefined,
      onClick: () => onPick(b)
    })
    return [
      ...(local.length ? [{ kind: 'section' as const, label: t('cf.git.localBranches') }, ...local.map(row)] : []),
      ...(remote.length ? [{ kind: 'section' as const, label: t('cf.git.remoteBranches') }, ...remote.map(row)] : [])
    ]
  }

  const view = menu?.view ?? { kind: 'main' as const }
  let items: CtxEntry[]
  if (view.kind === 'branches') {
    items = [
      ...filterItem,
      { label: t('cf.git.createBranch'), icon: <Plus size={14} />, onClick: () => void createBranch() },
      {
        label: t('cf.git.mergeBranch'),
        icon: <GitMerge size={14} />,
        disabled: status.mergeInProgress,
        title: status.mergeInProgress ? t('cf.git.mergeBusy') : undefined,
        onClick: () => go({ kind: 'merge' })
      },
      ...branchList(branches, (b) => go({ kind: 'branch', branch: b }))
    ]
  } else if (view.kind === 'merge') {
    items = [
      ...filterItem,
      { kind: 'section', label: fmt('cf.git.mergeIntoTitle', label) },
      ...branchList(
        branches.filter((b) => !b.current),
        (b) => void mergeBranch(b.name)
      )
    ]
  } else if (view.kind === 'branch') {
    const b = view.branch
    items = [
      { kind: 'section', label: b.name },
      {
        label: t('cf.git.checkout'),
        icon: <ArrowRightLeft size={14} />,
        disabled: b.current,
        title: b.current ? t('cf.git.currentBranch') : undefined,
        onClick: () => checkout(b)
      },
      ...(b.remote
        ? []
        : [{ label: t('cf.git.renameBranch'), icon: <Pencil size={14} />, onClick: () => void renameBranch(b.name) }]),
      { kind: 'separator' },
      b.remote
        ? { label: t('cf.git.deleteRemoteBranch'), icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteRemoteBranch(b) }
        : {
            label: t('cf.git.deleteBranch'),
            icon: <Trash2 size={14} />,
            danger: true,
            disabled: b.current,
            title: b.current ? t('cf.git.deleteCurrentHint') : undefined,
            onClick: () => void deleteBranch(b.name)
          }
    ]
  } else {
    items = [
      ...(status.mergeInProgress
        ? [
            { label: t('cf.git.abortMerge'), icon: <X size={14} />, danger: true, onClick: () => void abortMerge(true) },
            { kind: 'separator' as const }
          ]
        : []),
      { label: t('cf.git.pull'), icon: <ArrowDownToLine size={14} />, onClick: () => void run(() => window.deva.git.pull(root), t('cf.git.donePull')) },
      { label: t('cf.git.push'), icon: <ArrowUpFromLine size={14} />, onClick: () => void run(() => window.deva.git.push(root, status.upstream ? null : status.branch), t('cf.git.donePush')) },
      { label: t('cf.git.fetch'), icon: <Download size={14} />, onClick: () => void run(() => window.deva.git.fetch(root), t('cf.git.doneFetch')) },
      { label: t('cf.git.commit'), icon: <GitCommitHorizontal size={14} />, onClick: () => setCommitOpen(true) },
      { kind: 'separator' },
      { label: t('cf.git.branches'), icon: <GitBranch size={14} />, onClick: () => go({ kind: 'branches' }) },
      { label: t('cf.git.refresh'), icon: <RefreshCw size={14} />, onClick: () => void refresh() }
    ]
  }

  // 生成提交信息用本对话的生效模型，与发送消息同口径（store/chat.tsx send）：本对话已选 → 否则回落最近使用。
  // 只取最近使用会在本对话绑定了别的模型时用错服务商（如对话走 http 中转、最近使用却是被拦的 https 服务商）。
  const genModel = findActive(providers, currentBinding.model ?? null) ?? activeModel
  const commitModel: GitGenModel | null =
    genModel && hasKey(genModel.provider.id)
      ? {
          // 选择器只列对话模型（已按 purpose 过滤），adapter 必属 LLM 三协议之一。
          adapter: genModel.provider.adapter as GitGenModel['adapter'],
          providerId: genModel.provider.id,
          baseURL: genModel.provider.apiHost,
          model: genModel.model.id
        }
      : null

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        className={`cf-gitchip${opBusy || busy ? ' is-busy' : ''}`}
        title={t('cf.git.menuHint')}
        aria-label={t('cf.git.menuHint')}
        onClick={() => void openMenu()}
        disabled={opBusy}
      >
        <GitBranch size={13} />
        <span className="cf-gitchip__branch" title={label}>
          {label}
        </span>
        {status.mergeInProgress && <span className="cf-gitchip__merge">{t('cf.git.merging')}</span>}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="cf-gitchip__ab">
            {status.ahead > 0 && (
              <span className="cf-gitchip__up">
                <ArrowUpFromLine size={11} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="cf-gitchip__down">
                <ArrowDownToLine size={11} />
                {status.behind}
              </span>
            )}
          </span>
        )}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          openUp
          key={view.kind === 'branch' ? `branch:${view.branch.name}` : view.kind}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
      {commitOpen && (
        <CommitModal
          root={root}
          status={status}
          locale={locale as GitGenLocale}
          model={commitModel}
          onClose={() => setCommitOpen(false)}
          onDone={() => {
            setCommitOpen(false)
            void refresh()
          }}
        />
      )}
    </>
  )
}

/**
 * 已挂载 chip 的文件夹名按钮：点击向上浮出菜单（同 GitWidget 的 openUp 定位）——复制路径 / 在系统文件管理器中打开。
 * 刻意不提供「更换文件夹」：换目录会让系统提示词变化、提示缓存整段失效，不鼓励频繁切换；确需更换就点 ✕ 卸载后重新挂载。
 */
export function WorkspaceMenu({ root }: { root: string }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const openMenu = (): void => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.top - 4 })
  }

  // 优先走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard。
  const copyPath = (): void => {
    void window.deva.clipboard.writeText(root).catch(() => {
      void navigator.clipboard?.writeText(root).catch(() => {})
    })
  }

  const reveal = (): void => {
    void window.deva.fs
      .revealFolder(root)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('cf.ws.revealFailed') })
      })
  }

  const platform = window.deva.platform
  const revealLabel = t(
    platform === 'win32' ? 'cf.ws.revealWin' : platform === 'darwin' ? 'cf.ws.revealMac' : 'cf.ws.revealOther'
  )

  const items = [
    { label: t('cf.ws.copyPath'), icon: <Copy size={14} />, onClick: copyPath },
    { label: revealLabel, icon: <ExternalLink size={14} />, onClick: reveal }
  ]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="cf-wschip__main"
        title={root}
        aria-label={t('cf.ws.menuHint')}
        aria-haspopup="menu"
        onClick={openMenu}
      >
        <FolderOpen size={15} />
        <span className="cf-wschip__name">{basename(root)}</span>
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} openUp items={items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}

/**
 * 流式生成中的展示清洗：模型偶尔用代码块 / 引号包裹整段，边生成边剥掉开头的围栏行与引号、
 * 末尾正在长出来的收尾围栏，免得这些符号先闪出来再消失。结束后以主进程清洗的全文为准。
 */
function cleanStreamingCommit(raw: string): string {
  let s = raw.trimStart()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    if (nl < 0) return ''
    s = s.slice(nl + 1).replace(/\n?`{0,3}$/, '')
  }
  return s.replace(/^["“]/, '')
}

/**
 * 轻量提交框（v1 只做「暂存全部改动 + 提交」，不含逐文件 diff/staging）：
 * 顶部一行改动数量摘要；一个信息 textarea；「AI 生成」按本对话的生效模型（同输入框所选）走 generateCommitMessage（无模型/无密钥则灰掉）。
 * 生成时文字流式填入输入框（只读），按钮变「停止生成」；中断保留已生成部分，关闭提交框也会中断。
 * 有冲突时禁止提交并提示先解决——避免把未合并状态提交进去。
 */
function CommitModal({
  root,
  status: initialStatus,
  locale,
  model,
  onClose,
  onDone
}: {
  root: string
  status: GitStatus
  locale: GitGenLocale
  model: GitGenModel | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [msg, setMsg] = useState('')
  const [gen, setGen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 进行中的生成请求 id：停止生成 / 关闭提交框时据此中断。
  const genIdRef = useRef<string | null>(null)
  const msgRef = useRef<HTMLTextAreaElement>(null)

  // 关闭提交框（卸载）时中断仍在进行的生成，免得主进程白跑到超时。
  useEffect(
    () => () => {
      if (genIdRef.current) void window.deva.git.cancelCommitMessage(genIdRef.current)
    },
    []
  )

  // 流式填入时输入框跟到末尾。
  useEffect(() => {
    const el = msgRef.current
    if (gen && el) el.scrollTop = el.scrollHeight
  }, [gen, msg])

  // 打开即重取一次状态：父级快照可能早于本轮对话 / 用户在外部新建的文件，避免改动数与可提交态过期。
  const [status, setStatus] = useState(initialStatus)
  useEffect(() => {
    let alive = true
    window.deva.git
      .status(root)
      .then((st) => {
        if (alive && st.isRepo) setStatus(st)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root])

  // 变更集：跨 staged/unstaged/conflicts 按路径去重计数。
  const changed = useMemo(() => {
    const set = new Set<string>()
    for (const f of status.staged) set.add(f.path)
    for (const f of status.unstaged) set.add(f.path)
    for (const f of status.conflicts) set.add(f.path)
    return set.size
  }, [status])

  const hasConflicts = status.conflicts.length > 0
  const canCommit = Boolean(msg.trim()) && changed > 0 && !hasConflicts && !busy && !gen

  const stopGenerate = (): void => {
    if (genIdRef.current) void window.deva.git.cancelCommitMessage(genIdRef.current)
  }

  const generate = async (): Promise<void> => {
    if (!model || genIdRef.current) return
    const id = `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const prev = msg
    let raw = ''
    genIdRef.current = id
    setGen(true)
    setMsg('')
    const off = window.deva.git.onCommitMessageDelta((rid, text) => {
      if (rid !== id) return
      raw += text
      setMsg(cleanStreamingCommit(raw))
    })
    try {
      const r = await window.deva.git.generateCommitMessage(root, model, locale, id)
      if (r.ok && r.text) setMsg(r.text)
      else {
        // 失败，或中断时一个字都还没出来：还原生成前的内容；中断不算错误、不提示。
        setMsg(prev)
        if (!r.aborted) toast.show(gitErrorToast(t, r))
      }
    } catch {
      setMsg(prev)
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      off()
      genIdRef.current = null
      setGen(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!canCommit) return
    setBusy(true)
    try {
      // 提交前再取一次最新状态，暂存其中全部未暂存改动（未跟踪文件已含在 unstaged 内），再提交——
      // 弹窗打开期间新增的文件也不会漏。
      const fresh = await window.deva.git.status(root)
      const latest = fresh.isRepo ? fresh : status
      if (latest.conflicts.length > 0) {
        setStatus(latest)
        return
      }
      const toStage = latest.unstaged.map((f) => f.path)
      if (toStage.length > 0) {
        const sres = await window.deva.git.stage(root, toStage)
        if (!sres.ok) {
          toast.show(gitErrorToast(t, sres))
          return
        }
      }
      const cres = await window.deva.git.commit(root, msg.trim())
      if (cres.ok) {
        toast.show({ variant: 'success', message: t('cf.git.doneCommit') })
        onDone()
      } else {
        toast.show(gitErrorToast(t, cres))
      }
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setBusy(false)
    }
  }

  const meta = hasConflicts
    ? t('cf.git.commitConflicts')
    : changed > 0
      ? t('cf.git.commitCount').replace('{n}', String(changed))
      : t('cf.git.commitNone')

  return (
    <Modal open onClose={onClose} width={460} labelledBy="cf-commit-title">
      <h2 id="cf-commit-title" className="modal__title">
        {t('cf.git.commitTitle')}
      </h2>
      <p className="cf-commit__meta">{meta}</p>
      <textarea
        ref={msgRef}
        className="input cf-commit__msg"
        value={msg}
        placeholder={t('cf.git.commitPlaceholder')}
        onChange={(e) => setMsg(e.target.value)}
        readOnly={gen}
        autoFocus
      />
      <div className="cf-commit__bar">
        {gen ? (
          <button type="button" className="btn btn--ghost" onClick={stopGenerate}>
            <Square size={12} fill="currentColor" />
            {t('cf.git.aiStop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void generate()}
            disabled={!model || busy}
            title={model ? t('cf.git.aiHint') : t('cf.git.aiNoModel')}
          >
            <Sparkles size={14} />
            {t('cf.git.aiGenerate')}
          </button>
        )}
        <div className="cf-commit__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {t('cf.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={!canCommit}
          >
            {t('cf.git.commitDo')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
