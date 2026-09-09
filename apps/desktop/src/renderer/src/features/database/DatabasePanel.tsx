import { useState } from 'react'
import { Plus, Database, Table2, ChevronDown, ChevronRight } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useUI } from '../../store/ui'
import { dbConnections } from '../../mock/data'

/** 数据库导航（参考 IDEA 数据源）。点击表 → 中央数据/结构视图。 */
export function DatabasePanel(): React.JSX.Element {
  const { t } = useI18n()
  const { selectedTable, selectTable } = useUI()
  const [open, setOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(dbConnections.map((c) => [c.id, c.open]))
  )

  return (
    <>
      <PanelHeader
        title={t('database.title')}
        badge={t('common.global')}
        actions={
          <button className="icon-btn" title={t('database.addConnection')}>
            <Plus size={16} />
          </button>
        }
      />
      <div className="sidepanel__body">
        {dbConnections.map((c) => (
          <div key={c.id}>
            <div
              className="list-row"
              onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}
            >
              <span className="list-row__icon">
                {open[c.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <span className="list-row__icon" style={{ color: 'var(--accent)' }}>
                <Database size={14} />
              </span>
              <span className="list-row__label">{c.name}</span>
            </div>
            {open[c.id] &&
              c.tables.map((tb) => (
                <div
                  key={tb.id}
                  className={`list-row${tb.id === selectedTable ? ' is-selected' : ''}`}
                  style={{ paddingLeft: 36 }}
                  onClick={() => selectTable(tb.id)}
                >
                  <span className="list-row__icon">
                    <Table2 size={14} />
                  </span>
                  <span className="list-row__label">{tb.name}</span>
                  <span className="list-row__meta">{tb.rows.length}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </>
  )
}
