import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, RotateCcw } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import type { ModelDef, Provider } from '../../mock/models'
import {
  CONTEXT_WINDOW_RANGE,
  MAX_OUTPUT_RANGE,
  autoContextWindow,
  autoOutputBudget,
  formatTokens,
  parseTokens,
  validLimit,
  type LimitAdapter
} from '../../../../shared/context'

/**
 * 模型详情页（设置 › 模型 › 服务商 › 模型）：改模型名称、上下文窗口、最大输出长度。
 * 两项上限留「自动」即走内置表 / 引擎默认（shared/context.ts），主进程每次请求现查，改了即对下一次请求生效。
 */

const CONTEXT_PRESETS = [128_000, 200_000, 256_000, 400_000, 512_000, 1_000_000]
const OUTPUT_PRESETS = [8_192, 16_384, 32_000, 64_000, 128_000]

interface Props {
  provider: Provider
  model: ModelDef
  onBack: () => void
  onUpdate: (patch: Partial<Pick<ModelDef, 'name' | 'contextWindow' | 'maxOutput'>>) => void
}

export function ModelDetail({ provider, model, onBack, onUpdate }: Props): React.JSX.Element {
  const { t } = useI18n()
  const adapter = provider.adapter as LimitAdapter
  const autoWindow = autoContextWindow(model.id)
  const autoOutput = autoOutputBudget(adapter, model.id)
  const ctxWindow = model.contextWindow ?? autoWindow
  const output = model.maxOutput ?? autoOutput

  const [nameDraft, setNameDraft] = useState(model.name)
  useEffect(() => setNameDraft(model.name), [model.name])

  const commitName = (): void => {
    const v = nameDraft.trim() || model.id
    if (v !== model.name) onUpdate({ name: v })
    setNameDraft(v)
  }

  const customized =
    model.name !== model.id || model.contextWindow !== undefined || model.maxOutput !== undefined

  return (
    <section className="provider-detail model-detail">
      <div className="provider-detail__topbar">
        <button className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('models.backTo').replace('{name}', provider.name)}
        </button>
      </div>

      <div className="field">
        <label className="field__label">{t('models.displayName')}</label>
        <div className="field__control">
          <input
            className="input"
            type="text"
            value={nameDraft}
            placeholder={model.id}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </div>
        <p className="field__note">{t('models.displayNameHint').replace('{id}', model.id)}</p>
      </div>

      <LimitField
        label={t('models.contextWindow')}
        autoText={formatTokens(autoWindow)}
        value={model.contextWindow}
        presets={CONTEXT_PRESETS}
        range={CONTEXT_WINDOW_RANGE}
        note={t('models.contextWindowHint')}
        check={(n) =>
          output !== undefined && n <= output
            ? t('models.windowTooSmall').replace('{n}', formatTokens(output))
            : null
        }
        onChange={(v) => onUpdate({ contextWindow: v })}
      />

      <LimitField
        label={t('models.maxOutput')}
        autoText={autoOutput !== undefined ? formatTokens(autoOutput) : t('models.providerDefault')}
        value={model.maxOutput}
        presets={OUTPUT_PRESETS}
        range={MAX_OUTPUT_RANGE}
        note={t('models.maxOutputHint')}
        check={(n) =>
          n >= ctxWindow ? t('models.outputTooLarge').replace('{n}', formatTokens(ctxWindow)) : null
        }
        onChange={(v) => onUpdate({ maxOutput: v })}
      />

      {customized && (
        <div className="model-detail__reset">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              onUpdate({ name: model.id, contextWindow: undefined, maxOutput: undefined })
              setNameDraft(model.id)
            }}
          >
            <RotateCcw size={13} />
            {t('models.resetModel')}
          </button>
        </div>
      )}
    </section>
  )
}

interface LimitFieldProps {
  label: string
  /** 「自动」档显示的值（如 1M / 服务商默认）。 */
  autoText: string
  /** 用户填写的值；undefined = 自动。 */
  value: number | undefined
  presets: number[]
  range: { min: number; max: number }
  note: string
  /** 与另一项上限的交叉校验：返回错误文案即拒绝保存。 */
  check: (n: number) => string | null
  onChange: (v: number | undefined) => void
}

/**
 * 一项 token 上限：单个组合输入框。留空即自动（占位文字显示自动值），可直接输入（支持 200K / 1M 写法），
 * 或从右侧下拉选「自动」/ 常用档位；失焦 / 回车保存。展开与否都只占一行，不撑开页面。
 */
function LimitField({
  label,
  autoText,
  value,
  presets,
  range,
  note,
  check,
  onChange
}: LimitFieldProps): React.JSX.Element {
  const { t } = useI18n()
  const show = (n: number | undefined): string => (n === undefined ? '' : n.toLocaleString('en-US'))
  const [draft, setDraft] = useState(show(value))
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  // 下拉用 fixed 定位，不参与设置页滚动区的布局（否则靠底部的一项展开会撑出滚动条）；下方放不下时向上弹出。
  const [menuPos, setMenuPos] = useState<React.CSSProperties | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const box = boxRef.current?.getBoundingClientRect()
    const h = menuRef.current?.offsetHeight ?? 0
    if (!box) return
    const below = window.innerHeight - box.bottom
    const up = below < h + 8 && box.top > below
    setMenuPos({
      left: box.left,
      width: box.width,
      ...(up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 })
    })
  }, [open])

  // fixed 定位不随页面滚动，滚动或缩放窗口时直接收起。
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // 保存后（或「恢复默认」）以存下的值为准：200k 之类的写法回显成规范数字。
  useEffect(() => {
    setDraft(show(value))
    setError('')
  }, [value])

  const commit = (raw: string): void => {
    // 清空即回到自动。
    if (!raw.trim()) {
      setError('')
      setDraft('')
      if (value !== undefined) onChange(undefined)
      return
    }
    const n = parseTokens(raw)
    if (n === null || !validLimit(n, range)) {
      setError(
        t('models.limitInvalid')
          .replace('{min}', formatTokens(range.min))
          .replace('{max}', formatTokens(range.max))
      )
      return
    }
    const msg = check(n)
    if (msg) {
      setError(msg)
      return
    }
    setError('')
    if (n !== value) onChange(n)
    else setDraft(show(n))
  }

  // 下拉项用 onMouseDown + preventDefault：先于 input blur，避免先按草稿保存一次再按所选项保存
  const pick = (e: React.MouseEvent, n: number | undefined): void => {
    e.preventDefault()
    setOpen(false)
    setDraft(show(n))
    commit(n === undefined ? '' : String(n))
  }

  return (
    <div className="field">
      <label className="field__label">
        {label}
        {value !== undefined && <span className="model-limit__badge">{t('models.limitCustom')}</span>}
      </label>
      <div className="model-limit">
        <div className="model-limit__box" ref={boxRef}>
          <input
            className="model-limit__input"
            type="text"
            inputMode="numeric"
            value={draft}
            placeholder={t('models.limitAuto').replace('{v}', autoText)}
            onChange={(e) => {
              setDraft(e.target.value)
              setError('')
            }}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') setOpen(false)
            }}
          />
          <span className="model-limit__unit">tokens</span>
          <button
            type="button"
            className={`model-limit__toggle${open ? ' is-open' : ''}`}
            tabIndex={-1}
            onMouseDown={(e) => {
              e.preventDefault()
              setOpen((o) => !o)
            }}
          >
            <ChevronDown size={14} />
          </button>
        </div>

        {open && (
          <>
            <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
            <div
              ref={menuRef}
              className="model-limit__menu"
              role="menu"
              style={menuPos ?? { visibility: 'hidden' }}
            >
              <button
                type="button"
                className={`model-pick__item${value === undefined ? ' is-active' : ''}`}
                onMouseDown={(e) => pick(e, undefined)}
              >
                <span className="model-pick__name">{t('models.limitAuto').replace('{v}', autoText)}</span>
                {value === undefined && <Check size={14} className="model-pick__check" />}
              </button>
              <div className="model-limit__sep" />
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`model-pick__item${p === value ? ' is-active' : ''}`}
                  onMouseDown={(e) => pick(e, p)}
                >
                  <span className="model-pick__name">
                    {formatTokens(p)}
                    <span className="model-limit__exact">{show(p)}</span>
                  </span>
                  {p === value && <Check size={14} className="model-pick__check" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {error && <div className="field__warn">{error}</div>}
      <p className="field__note">{note}</p>
    </div>
  )
}
