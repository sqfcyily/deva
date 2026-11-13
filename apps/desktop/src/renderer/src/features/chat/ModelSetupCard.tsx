import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  Plug,
  Search
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useModels } from '../../store/models'
import { useChatActions } from '../../store/chat'
import { useToast } from '../../components/ToastProvider'
import { Select } from '../../components/Select'

/**
 * 对话区「接入模型」引导卡：一个可用模型都没有时（首次安装的常态）显示在对话区，三步完成配置——
 * 选服务商 → 拿密钥（官网直达 + 白话步骤；本机 Ollama 改为「检测本机模型」）→ 从拉到的清单里选模型。
 * 没有模型就没有 AI 可用，故这是应用内置的固定流程而非模型对话；不落盘、不进对话记录，
 * 接入完成（出现可用模型）即随显示条件消失。写入的是设置页同一份配置（store/models），密钥照旧只经主进程加密保存。
 * 「拉取模型清单」兼作密钥/连通校验：auth 判密钥无效、network 判连不上，其余（如服务不支持 /models）退回手填模型名。
 */

type Adapter = 'anthropic' | 'openai' | 'responses'
type Phase = 'pick' | 'key' | 'model'

const CUSTOM = 'custom'
const OLLAMA = 'ollama'
const OLLAMA_DOWNLOAD = 'https://ollama.com/download'
const CUSTOM_ACCENT = '#8a8a94'

/** 平铺顺序：国内服务在前、海外其次、本机 Ollama 最后（其后是「自定义地址」）；未列出的排末尾。 */
const ORDER = ['deepseek', 'moonshot', 'qwen', 'zhipu', 'openai', 'anthropic', 'gemini', 'ollama']
const rank = (id: string): number => {
  const i = ORDER.indexOf(id)
  return i < 0 ? ORDER.length : i
}

/**
 * 推荐模型：按优先级的匹配规则，命中多个取版本最新的。只在拉到的真实清单里标「推荐」、不替用户选；
 * 不写死具体型号（各家改名频繁），匹配不上就不标。
 */
const RECOMMEND: Record<string, RegExp[]> = {
  deepseek: [/^deepseek-chat$/],
  moonshot: [/^kimi-latest$/, /^kimi-k\d/],
  qwen: [/^qwen-plus$/, /^qwen-max$/],
  zhipu: [/^glm-\d+(\.\d+)?$/],
  openai: [/^gpt-\d+(\.\d+)?$/],
  anthropic: [/^claude-sonnet-/, /^claude-/],
  gemini: [/^(models\/)?gemini-[\d.]+-flash$/, /^(models\/)?gemini-[\d.]+-pro$/]
}

/** 明显不是对话模型的（向量/语音/绘图/审核等）：默认收起，免得在几十个 ID 里迷路；全被滤掉时照常全列。 */
const NON_CHAT_RE = /embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcri|rerank|speech/i

/** 版本感知倒序：去掉日期后缀（-20250929）后按数字感知比较，较新的版本排前。 */
const byVersionDesc = (a: string, b: string): number =>
  b.replace(/-\d{8}$/, '').localeCompare(a.replace(/-\d{8}$/, ''), undefined, { numeric: true }) ||
  b.localeCompare(a)

/** 接口地址的主机名（含端口）：自定义服务默认以此命名，接多个中转也不重名；解析不了返回空串。 */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host
  } catch {
    return ''
  }
}

function recommendOf(pid: string, ids: string[]): string | null {
  for (const re of RECOMMEND[pid] ?? []) {
    const hits = ids.filter((id) => re.test(id))
    if (hits.length) return [...hits].sort(byVersionDesc)[0]
  }
  return null
}

export function ModelSetupCard(): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const {
    providers,
    secretsAvailable,
    hasKey,
    setApiKey,
    updateProvider,
    addCustomProvider,
    removeProvider,
    addModels,
    toggleModel,
    setActiveModel
  } = useModels()
  const { setSessionModel } = useChatActions()

  const [phase, setPhase] = useState<Phase>('pick')
  /** 选中的服务商：官方预置的 id，或 CUSTOM（自定义地址）。 */
  const [pid, setPid] = useState('')
  const [key, setKey] = useState('')
  const [host, setHost] = useState('https://')
  const [adapter, setAdapter] = useState<Adapter>('openai')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 连不上时允许跳去手填模型名（/models 被拦但对话接口可用的中转并不少见）。 */
  const [canManual, setCanManual] = useState(false)
  /** 实际写入的服务商 id（官方 = 预置 id；自定义 = 新建的 custom-*）。 */
  const [targetId, setTargetId] = useState<string | null>(null)
  /** 拉到的模型清单；null = 手填模式。 */
  const [list, setList] = useState<string[] | null>(null)
  const [model, setModel] = useState('')
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

  // 本引导新建、尚未接入完成的自定义服务商：退回选服务商或引导卸载时删掉，不在设置页留空壳。
  const customIdRef = useRef<string | null>(null)
  const removeRef = useRef(removeProvider)
  removeRef.current = removeProvider
  useEffect(
    () => () => {
      if (customIdRef.current) removeRef.current(customIdRef.current)
    },
    []
  )

  const presets = useMemo(
    () =>
      providers
        .filter(
          (p) =>
            p.kind === 'official' &&
            (p.purpose ?? 'llm') === 'llm' &&
            // 仅协议不同的变体与小众订阅网关不进引导卡，设置页仍可选。
            p.id !== 'openai-responses' &&
            p.id !== 'opencode-go'
        )
        .sort((a, b) => rank(a.id) - rank(b.id)),
    [providers]
  )

  const chosen = pid === CUSTOM ? undefined : providers.find((p) => p.id === pid)
  // 自定义服务：填地址时仍叫「自定义服务」，验证后（选模型步）显示实际命名（主机名）。
  const customName = hostOf(host) || t('chat.setup.customName')
  const chosenName =
    pid === CUSTOM
      ? phase === 'model'
        ? customName
        : t('chat.setup.customName')
      : (chosen?.name ?? '')
  const chosenAccent = chosen?.accent ?? CUSTOM_ACCENT
  const isLocal = pid === OLLAMA

  const rec = list ? recommendOf(pid, list) : null
  const chatLike = useMemo(() => (list ?? []).filter((id) => !NON_CHAT_RE.test(id)), [list])
  const visible = useMemo(() => {
    if (!list) return []
    const pool = showAll || chatLike.length === 0 ? list : chatLike
    const q = query.trim().toLowerCase()
    const hits = q ? pool.filter((id) => id.toLowerCase().includes(q)) : pool
    // 推荐项置顶（仍需用户点选）。
    return rec && hits.includes(rec) ? [rec, ...hits.filter((id) => id !== rec)] : hits
  }, [list, chatLike, showAll, query, rec])
  const hiddenCount = list && !showAll && chatLike.length > 0 ? list.length - chatLike.length : 0

  const descOf = (id: string): string => {
    const k = `chat.setup.desc.${id}`
    const v = t(k)
    return v === k ? '' : v
  }

  const dropCustom = (): void => {
    if (customIdRef.current) {
      removeProvider(customIdRef.current)
      customIdRef.current = null
    }
  }

  const choose = (id: string): void => {
    setPid(id)
    setKey('')
    setErr(null)
    setCanManual(false)
    setPhase('key')
  }

  const backToPick = (): void => {
    dropCustom()
    setPid('')
    setErr(null)
    setCanManual(false)
    setPhase('pick')
  }

  const goManual = (): void => {
    setList(null)
    setModel('')
    setErr(null)
    setPhase('model')
  }

  /** 确定写入目标：官方直接用预置（含用户在设置页改过的地址）；自定义按需新建一次，之后重试复用。 */
  const resolveTarget = (): { id: string; adapter: Adapter; host: string } | null => {
    if (pid === CUSTOM) {
      const h = host.trim().replace(/\/+$/, '')
      if (!/^https?:\/\/[^/\s]+/i.test(h)) {
        setErr(t('chat.setup.errHost'))
        return null
      }
      let id = customIdRef.current
      if (!id) {
        id = addCustomProvider(customName)
        customIdRef.current = id
      }
      // 重试前可能改过地址：名称随地址的主机名一起更新。
      updateProvider(id, { name: customName, apiHost: h, adapter })
      return { id, adapter, host: h }
    }
    if (!chosen) return null
    return { id: chosen.id, adapter: chosen.adapter as Adapter, host: chosen.apiHost }
  }

  const canVerify =
    !busy &&
    (isLocal || (secretsAvailable && key.trim().length > 0)) &&
    (pid !== CUSTOM || host.trim().length > 'https://'.length)

  const verify = async (): Promise<void> => {
    if (!canVerify) return
    setErr(null)
    setCanManual(false)
    const tg = resolveTarget()
    if (!tg) return
    // 写密钥会顺带启用服务商；密钥被判无效时据此撤回，别在设置页留下「已启用、带坏密钥、无模型」的服务商。
    const hadKey = hasKey(tg.id)
    const wasEnabled = providers.find((p) => p.id === tg.id)?.enabled ?? false
    setBusy(true)
    try {
      if (!isLocal) {
        const r = await setApiKey(tg.id, key.trim())
        if (!r.ok) {
          setErr(r.available ? t('chat.setup.errSave') : t('models.secretsUnavailable'))
          return
        }
      }
      const res = await window.deva.provider.listModels({
        adapter: tg.adapter,
        providerId: tg.id,
        baseURL: tg.host
      })
      setTargetId(tg.id)
      if (isLocal && res.ok && (res.models ?? []).every((id) => NON_CHAT_RE.test(id))) {
        // 本机 Ollama 一个模型都没有，或只有向量等非对话模型：选了也聊不了，同按「还没有模型」提示。
        setErr(t('chat.setup.errOllamaEmpty'))
      } else if (res.ok && res.models && res.models.length > 0) {
        setList(res.models)
        setModel('')
        setQuery('')
        setShowAll(false)
        setPhase('model')
      } else if (res.ok) {
        // 清单为空（本机 Ollama 已在上面处理）：退回手填。
        goManual()
      } else if (res.kind === 'auth') {
        if (!hadKey) void setApiKey(tg.id, '')
        if (!wasEnabled) updateProvider(tg.id, { enabled: false })
        setErr(t('chat.setup.errAuth'))
      } else if (res.kind === 'network') {
        setErr(t(isLocal ? 'chat.setup.errOllama' : 'chat.setup.errNetwork'))
        setCanManual(!isLocal)
      } else {
        goManual()
      }
    } catch {
      setErr(t(isLocal ? 'chat.setup.errOllama' : 'chat.setup.errNetwork'))
    } finally {
      setBusy(false)
    }
  }

  // 完成：写入模型并设为本对话 + 最近使用（与输入框模型选择器同一组动作）。出现可用模型后本卡随条件卸载。
  const finish = (): void => {
    const mid = model.trim()
    if (!mid || !targetId) return
    const prov = providers.find((p) => p.id === targetId)
    const existing = prov?.models.find((m) => m.id === mid)
    if (existing) {
      // 已有同名模型（如之前在设置页加过又停用）：addModels 会跳过，这里补上启用。
      if (!existing.enabled) toggleModel(targetId, mid)
      if (!prov?.enabled) updateProvider(targetId, { enabled: true })
    } else {
      addModels(targetId, [mid])
    }
    setSessionModel(`${targetId}:${mid}`)
    setActiveModel(targetId, mid)
    customIdRef.current = null
    toast.show({ variant: 'success', message: `${t('chat.setup.done')}${chosenName} · ${mid}` })
  }

  const step = phase === 'pick' ? 1 : phase === 'key' ? 2 : 3
  const chosenRow = (
    <div className="setup__chosen">
      <span className="setup__dot" style={{ background: chosenAccent }} />
      <span className="setup__chosen-name">{chosenName}</span>
    </div>
  )

  return (
    <div className="setup">
      <div className="setup__head">
        <span className="setup__head-icon">
          <Plug size={15} />
        </span>
        {t('chat.setup.title')}
        <span className="setup__progress">{step} / 3</span>
      </div>

      {phase === 'pick' && (
        <>
          <div className="setup__hint">{t('chat.setup.intro')}</div>
          <div className="setup__grid">
            {presets.map((p) => (
              <button key={p.id} type="button" className="setup__tile" onClick={() => choose(p.id)}>
                <span className="setup__dot" style={{ background: p.accent }} />
                <span className="setup__tile-body">
                  <span className="setup__tile-name">{p.name}</span>
                  {descOf(p.id) && <span className="setup__tile-desc">{descOf(p.id)}</span>}
                </span>
              </button>
            ))}
            <button type="button" className="setup__tile" onClick={() => choose(CUSTOM)}>
              <span className="setup__dot" style={{ background: CUSTOM_ACCENT }} />
              <span className="setup__tile-body">
                <span className="setup__tile-name">{t('chat.setup.customName')}</span>
                <span className="setup__tile-desc">{descOf(CUSTOM)}</span>
              </span>
            </button>
          </div>
        </>
      )}

      {phase === 'key' && (
        <>
          {chosenRow}
          {isLocal ? (
            <>
              <ol className="setup__steps">
                <li>{t('chat.setup.ollamaStep1')}</li>
                <li>{t('chat.setup.ollamaStep2')}</li>
                <li>{t('chat.setup.ollamaStep3')}</li>
              </ol>
              <a className="setup__link" href={OLLAMA_DOWNLOAD} target="_blank" rel="noreferrer">
                {t('chat.setup.ollamaSite')}
                <ExternalLink size={12} />
              </a>
            </>
          ) : pid === CUSTOM ? (
            <>
              <div className="setup__hint">{t('chat.setup.customHint')}</div>
              <label className="setup__field">
                <span className="setup__label">{t('chat.setup.host')}</span>
                <input
                  className="input"
                  value={host}
                  autoFocus
                  onChange={(e) => setHost(e.target.value)}
                />
              </label>
              <div className="setup__field">
                <span className="setup__label">{t('chat.setup.protocol')}</span>
                <Select<Adapter>
                  aria-label={t('chat.setup.protocol')}
                  value={adapter}
                  onChange={setAdapter}
                  items={[
                    { value: 'openai', label: t('models.adapterOpenAI'), sub: t('models.adapterSub.openai') },
                    { value: 'responses', label: t('models.adapterResponses'), sub: t('models.adapterSub.responses') },
                    { value: 'anthropic', label: t('models.adapterAnthropic'), sub: t('models.adapterSub.anthropic') }
                  ]}
                />
              </div>
            </>
          ) : (
            <>
              <ol className="setup__steps">
                <li>{t('chat.setup.stepOpen')}</li>
                <li>{t('chat.setup.stepCreate')}</li>
                <li>{t('chat.setup.stepPaste')}</li>
              </ol>
              {chosen?.docUrl && (
                <a className="setup__link" href={chosen.docUrl} target="_blank" rel="noreferrer">
                  {t('chat.setup.openSite')}
                  <ExternalLink size={12} />
                </a>
              )}
            </>
          )}
          {!isLocal && (
            <label className="setup__field">
              <span className="setup__label">{t('chat.setup.apiKey')}</span>
              <input
                className="input"
                type="password"
                value={key}
                placeholder={t('chat.setup.keyPlaceholder')}
                disabled={!secretsAvailable}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void verify()
                }}
              />
            </label>
          )}
          {!isLocal && !secretsAvailable && (
            <div className="setup__err">
              <AlertTriangle size={13} />
              <span>{t('models.secretsUnavailable')}</span>
            </div>
          )}
          {err && (
            <div className="setup__err">
              <AlertTriangle size={13} />
              <span>
                {err}
                {canManual && (
                  <button type="button" className="setup__textbtn" onClick={goManual}>
                    {t('chat.setup.manual')}
                  </button>
                )}
              </span>
            </div>
          )}
          <div className="setup__actions">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={backToPick}>
              {t('chat.setup.back')}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!canVerify}
              onClick={() => void verify()}
            >
              {busy ? (
                <>
                  <Loader2 size={13} className="spin" /> {t('chat.setup.verifying')}
                </>
              ) : isLocal ? (
                t('chat.setup.detect')
              ) : (
                t('chat.setup.verify')
              )}
            </button>
          </div>
        </>
      )}

      {phase === 'model' && (
        <>
          {chosenRow}
          {list ? (
            <>
              <div className="setup__hint">
                {t(isLocal ? 'chat.setup.pickLocal' : 'chat.setup.pickModel')}
              </div>
              {list.length > 8 && (
                <div className="setup__search">
                  <Search size={13} />
                  <input
                    value={query}
                    placeholder={t('chat.setup.search')}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              )}
              <div className="setup__models" role="radiogroup">
                {visible.map((id) => {
                  const on = id === model
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`setup__model${on ? ' is-on' : ''}`}
                      onClick={() => setModel(id)}
                    >
                      {on ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                      <span className="setup__model-id">{id}</span>
                      {id === rec && <span className="ask__reco">{t('chat.ask.recommended')}</span>}
                    </button>
                  )
                })}
                {visible.length === 0 && <div className="setup__empty">{t('chat.setup.noMatch')}</div>}
              </div>
              {hiddenCount > 0 && (
                <button type="button" className="setup__textbtn" onClick={() => setShowAll(true)}>
                  {t('chat.setup.showAll')} ({list.length})
                </button>
              )}
            </>
          ) : (
            <>
              <div className="setup__hint">{t('chat.setup.manualHint')}</div>
              <input
                className="input setup__manual"
                value={model}
                placeholder={t('chat.setup.manualPlaceholder')}
                autoFocus
                onChange={(e) => setModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish()
                }}
              />
            </>
          )}
          <div className="setup__actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setErr(null)
                setPhase('key')
              }}
            >
              {t('chat.setup.back')}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!model.trim()}
              onClick={finish}
            >
              <Check size={13} /> {t('chat.setup.finish')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
