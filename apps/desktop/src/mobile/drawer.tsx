import { AlarmClock, Archive, ChevronRight, MessageCircle, Monitor, Settings2 } from 'lucide-react'
import type { Filter, Store } from './App'
import { Avatar } from './avatar'
import { matchFilter } from './home'
import { fmtListTime, t } from './strings'

/**
 * 抽屉（左上角按钮打开，点遮罩关闭；网页版不做边缘滑动打开——Safari 后退与安卓返回手势占着屏幕边缘）。
 * 电脑 · 全部对话 · 定时任务 · 按角色看对话 · 已归档 · 设置。
 */
export function Drawer({ store, onClose }: { store: Store; onClose: () => void }): React.JSX.Element {
  const sessions = [...store.sessions.values()]
  const count = (f: Filter): number => sessions.filter((s) => matchFilter(s, f)).length
  const pick = (f: Filter): void => {
    store.setFilter(f)
    onClose()
  }
  const is = (f: Filter): boolean =>
    store.filter.kind === f.kind && (f.kind !== 'persona' || (store.filter.kind === 'persona' && store.filter.id === f.id))
  const tasks = store.tasks.length
  const all = count({ kind: 'all' })
  const archived = count({ kind: 'archived' })
  const personas = [...store.personas.values()].filter((p) => p.enabled || count({ kind: 'persona', id: p.id }) > 0)
  const ok = store.phase.kind === 'ready'

  return (
    <div className="dim dim--drawer" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__in">
          <button className="pc" onClick={() => store.open({ name: 'settings' })}>
            <span className="pc__tile">
              <Monitor size={22} strokeWidth={1.8} />
            </span>
            <span className="pc__k">
              <b>{store.computer}</b>
              <span>
                <span className={`okdot${ok ? '' : store.phase.kind === 'offline' ? ' is-off' : ' is-wait'}`} />
                {ok ? t('connected') : store.phase.kind === 'offline' ? t('offlineShort') : t('connectingTitle')}
                {/* 不在线时看到的是缓存：注明什么时候同步的。 */}
                {store.phase.kind === 'offline' && store.syncedAt ? ` · ${t('syncedAt', { t: fmtListTime(store.syncedAt) })}` : ''}
              </span>
            </span>
          </button>
          <button className={`nav${is({ kind: 'all' }) ? ' is-on' : ''}`} onClick={() => pick({ kind: 'all' })}>
            <MessageCircle size={21} strokeWidth={1.8} />
            {t('allChats')}
            <span className="nav__n">{all || ''}</span>
          </button>
          {tasks > 0 && (
            <button className={`nav${is({ kind: 'tasks' }) ? ' is-on' : ''}`} onClick={() => pick({ kind: 'tasks' })}>
              <AlarmClock size={21} strokeWidth={1.8} />
              {t('tasks')}
              <span className="nav__n">{tasks}</span>
            </button>
          )}
          {personas.length > 0 && <div className="sec">{t('personas')}</div>}
          <div className="drawer__list">
            {personas.map((p) => {
              const f: Filter = { kind: 'persona', id: p.id }
              const n = count(f)
              return (
                <button key={p.id} className={`nav${is(f) ? ' is-on' : ''}`} onClick={() => pick(f)}>
                  <Avatar persona={p} size={28} />
                  <span className="nav__name">{p.name}</span>
                  <span className="nav__n">{n || ''}</span>
                </button>
              )
            })}
          </div>
          {archived > 0 && (
            <button className={`nav${is({ kind: 'archived' }) ? ' is-on' : ''}`} onClick={() => pick({ kind: 'archived' })}>
              <Archive size={21} strokeWidth={1.8} />
              {t('archivedTitle')}
              <span className="nav__n">{archived}</span>
            </button>
          )}
        </div>
        <div className="drawer__foot">
          <button className="nav" onClick={() => store.open({ name: 'settings' })}>
            <Settings2 size={21} strokeWidth={1.8} />
            {t('settings')}
            <ChevronRight size={16} className="nav__n" />
          </button>
        </div>
      </aside>
    </div>
  )
}
