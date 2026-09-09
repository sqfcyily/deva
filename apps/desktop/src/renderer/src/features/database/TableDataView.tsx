import { useState } from 'react'
import { Database, Play, Table2 } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useUI } from '../../store/ui'
import { dbConnections, type DbTable } from '../../mock/data'

function findTable(id: string | null): DbTable | undefined {
  if (!id) return undefined
  for (const c of dbConnections) {
    const t = c.tables.find((x) => x.id === id)
    if (t) return t
  }
  return undefined
}

/**
 * 中央数据表视图：Data / Structure 双段签 + 顶部查询条（演示数据）。
 */
export function TableDataView(): React.JSX.Element {
  const { t } = useI18n()
  const { selectedTable } = useUI()
  const [tab, setTab] = useState<'data' | 'structure'>('data')
  const table = findTable(selectedTable)

  if (!table) {
    return (
      <div className="placeholder">
        <Database size={40} className="placeholder__icon" />
        <div className="placeholder__hint">{t('database.selectHint')}</div>
      </div>
    )
  }

  return (
    <div className="contentview">
      <div className="contentview__header">
        <span className="list-row__icon">
          <Table2 size={14} />
        </span>
        <span className="contentview__path">
          <b>{table.name}</b>
        </span>
        <span className="contentview__spacer" />
        <div className="subtabs">
          <button
            className={`subtab${tab === 'data' ? ' is-active' : ''}`}
            onClick={() => setTab('data')}
          >
            {t('database.data')}
          </button>
          <button
            className={`subtab${tab === 'structure' ? ' is-active' : ''}`}
            onClick={() => setTab('structure')}
          >
            {t('database.structure')}
          </button>
        </div>
      </div>

      {tab === 'data' && (
        <div className="querybar">
          <input
            className="querybar__input"
            defaultValue={`SELECT * FROM ${table.name} LIMIT 100;`}
            spellCheck={false}
          />
          <button className="btn btn--primary btn--sm">
            <Play size={13} />
            {t('database.run')}
          </button>
        </div>
      )}

      <div className="contentview__body">
        {tab === 'data' ? (
          <table className="grid">
            <thead>
              <tr>
                <th className="num">#</th>
                {table.columns.map((c) => (
                  <th key={c.name}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>
                  <td className="num">{i + 1}</td>
                  {table.columns.map((c) => (
                    <td key={c.name}>{row[c.name]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>{t('database.colName')}</th>
                <th>{t('database.colType')}</th>
                <th>{t('database.colNullable')}</th>
                <th>{t('database.colKey')}</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((c, i) => (
                <tr key={c.name}>
                  <td className="num">{i + 1}</td>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.nullable ? 'YES' : 'NO'}</td>
                  <td>{c.key && <span className="tag-key">{c.key}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
