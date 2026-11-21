import { useState } from 'react'
import { ChevronLeft, Plus, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import type { Provider } from '../../mock/models'
import {
  headerIssue,
  sanitizeHeaders,
  MAX_CUSTOM_HEADERS
} from '../../../../shared/provider-headers'

/**
 * 服务商高级设置页（设置 › 模型 › 服务商 › 高级设置）。收纳非常用项，不占服务商详情页的版面：详情页顶部工具条
 * 只放一个扳手图标，点开钻入本页，进出方式同模型详情页（ModelDetail）。
 * 目前只有「自定义请求头」一项，所以页面内不另设「高级设置」标题（入口图标的提示仍写「高级设置」）；
 * 以后的非常用设置也加在这里（每项一个 .field），届时再把页面标题加上。
 */

/** 本页可改的服务商字段。 */
export type AdvancedPatch = Partial<Pick<Provider, 'headers'>>

interface Props {
  provider: Provider
  onBack: () => void
  onUpdate: (patch: AdvancedPatch) => void
}

export function ProviderAdvanced({ provider, onBack, onUpdate }: Props): React.JSX.Element {
  const { t } = useI18n()
  return (
    <section className="provider-detail">
      <div className="provider-detail__topbar">
        <button className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('models.backTo').replace('{name}', provider.name)}
        </button>
      </div>

      <HeadersField headers={provider.headers} onChange={(headers) => onUpdate({ headers })} />
    </section>
  )
}

interface Row {
  name: string
  value: string
}

/**
 * 「自定义请求头」一项。清单与服务商详情的「模型」一栏同款：未设置时显示空态文字，设置后每条占一行
 *（名称 / 值两个输入框 + 行尾删除），随改随存。
 * 行草稿留在本组件（填到一半的行——只有名字、或名字不合法——存不进配置），每次改动把其中可用的行整理成表
 * 交给 onChange；不可用的行在行下注明原因，不会被发送。
 */
function HeadersField({
  headers,
  onChange
}: {
  /** 已保存的请求头（头名小写 → 值）。 */
  headers: Record<string, string> | undefined
  /** 可用的行有变化时回调；全部清空时传 undefined。 */
  onChange: (headers: Record<string, string> | undefined) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
  )

  const commit = (next: Row[]): void => {
    setRows(next)
    const clean = sanitizeHeaders(Object.fromEntries(next.map((r) => [r.name, r.value])))
    onChange(Object.keys(clean).length > 0 ? clean : undefined)
  }
  const setRow = (i: number, patch: Partial<Row>): void =>
    commit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  return (
    <div className="field">
      <div className="field__row-between">
        <label className="field__label">{t('models.headers')}</label>
        {rows.length < MAX_CUSTOM_HEADERS && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setRows([...rows, { name: '', value: '' }])}
          >
            <Plus size={14} />
            {t('models.addHeader')}
          </button>
        )}
      </div>
      <div className="model-list">
        {rows.length === 0 && <div className="model-list__empty">{t('models.noHeaders')}</div>}
        {rows.map((r, i) => {
          const issue = headerIssue(r.name, r.value)
          return (
            <div className="header-item" key={i}>
              <div className="model-row">
                <input
                  className="input header-item__name"
                  type="text"
                  placeholder={t('models.headerName')}
                  aria-label={t('models.headerName')}
                  spellCheck={false}
                  // 新加的空行直接聚焦名称，接着就能填。
                  autoFocus={!r.name && !r.value}
                  value={r.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                />
                <input
                  className="input"
                  type="text"
                  placeholder={t('models.headerValue')}
                  aria-label={t('models.headerValue')}
                  spellCheck={false}
                  value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                />
                <button
                  className="icon-btn model-row__act"
                  title={t('models.removeHeader')}
                  aria-label={t('models.removeHeader')}
                  onClick={() => commit(rows.filter((_, idx) => idx !== i))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {issue && <div className="field__warn">{t(`models.headerIssue.${issue}`)}</div>}
            </div>
          )
        })}
      </div>
      <p className="field__note">{t('models.headersHint')}</p>
    </div>
  )
}
