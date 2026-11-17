import { useEffect, useState } from 'react'
import { AlarmClock, Archive, ArchiveRestore, Check, ChevronLeft, ChevronRight, Folder, Trash2, Users } from 'lucide-react'
import type { WebModel, WebSession } from '../shared/remote-web'
import type { Store } from './App'
import { Avatar, SessionFace } from './avatar'
import { DeleteConfirm } from './session-ops'
import { t } from './strings'

/**
 * 对话页右上角「更多」：角色、成员、文件夹、定时任务等对话信息（标题栏里不再放），切换模型，归档 / 删除。
 * 切换模型同电脑端输入框：记在这个对话上，之后从手机、电脑发的消息都用它（电脑上已打开的对话以那边选的为准）。
 */
export function ChatMenu({ store, s, onClose }: { store: Store; s: WebSession; onClose: () => void }): React.JSX.Element {
  const [view, setView] = useState<'main' | 'models' | 'delete'>('main')
  const persona = store.personas.get(s.personaId ?? 'general')
  const tasks = store.tasks.filter((x) => x.owner?.sid === s.id || x.sessionId === s.id)
  const run = (fn: () => void): void => {
    onClose()
    fn()
  }
  return (
    <div className="dim" onClick={onClose}>
      <div className="sheet sheet--menu" onClick={(e) => e.stopPropagation()}>
        {view === 'models' ? (
          <ModelPicker store={store} s={s} onBack={() => setView('main')} />
        ) : (
          <>
            <div className="sheet__who">
              <SessionFace s={s} personas={store.personas} size={44} still />
              <span className="sheet__whok">
                <b>{s.title}</b>
                <span>{persona?.name ?? 'Deva'}</span>
              </span>
            </div>
            {view === 'delete' ? (
              <DeleteConfirm
                onCancel={() => setView('main')}
                onDelete={() =>
                  run(() => {
                    store.back()
                    void store.ops.remove(s.id)
                  })
                }
              />
            ) : (
              <div className="sheet__list">
                <div className="info">
                  <div className="info__r">
                    <span className="info__k">{t('persona')}</span>
                    <span className="info__v">
                      <Avatar persona={persona} seed={s.personaId} size={22} />
                      {persona?.name ?? 'Deva'}
                    </span>
                  </div>
                  {!!s.members?.length && (
                    <div className="info__r">
                      <span className="info__k">{t('members')}</span>
                      <span className="info__v">
                        <Users size={16} />
                        {s.members.map((m) => m.name).join('、')}
                      </span>
                    </div>
                  )}
                  {s.folder && (
                    <div className="info__r">
                      <span className="info__k">{t('folder')}</span>
                      <span className="info__v">
                        <Folder size={16} />
                        {s.folder}
                      </span>
                    </div>
                  )}
                  {/* 这个对话里运行的定时任务（或这就是任务自己的对话）：点开进任务详情。任务列表还没到时只列名字。 */}
                  {tasks.length
                    ? tasks.map((x) => (
                        <button key={x.id} className="info__r" onClick={() => run(() => store.open({ name: 'task', id: x.id }))}>
                          <span className="info__k">{t('tasks')}</span>
                          <span className="info__v">
                            <AlarmClock size={16} />
                            {x.title}
                          </span>
                          <ChevronRight size={17} className="info__go" />
                        </button>
                      ))
                    : !!s.tasks?.length && (
                        <div className="info__r">
                          <span className="info__k">{t('tasks')}</span>
                          <span className="info__v">
                            <AlarmClock size={16} />
                            {s.tasks.join('、')}
                          </span>
                        </div>
                      )}
                  <button className="info__r" disabled={!store.ready} onClick={() => setView('models')}>
                    <span className="info__k">{t('model')}</span>
                    <span className="info__v">{s.modelName ?? t('noModel')}</span>
                    <ChevronRight size={17} className="info__go" />
                  </button>
                </div>
                {s.archived ? (
                  <button className="act" disabled={!store.ready} onClick={() => run(() => void store.ops.archive(s.id, false))}>
                    <ArchiveRestore size={22} strokeWidth={1.8} />
                    {t('unarchive')}
                  </button>
                ) : (
                  <button
                    className={`act${s.busy ? ' is-off' : ''}`}
                    disabled={!store.ready}
                    onClick={() =>
                      run(() => {
                        if (s.busy) return store.toast(t('archiveBusy'), false)
                        store.back()
                        void store.ops.archive(s.id, true)
                      })
                    }
                  >
                    <Archive size={22} strokeWidth={1.8} />
                    {t('archive')}
                    {s.busy && <small>{t('archiveBusyShort')}</small>}
                  </button>
                )}
                <button className="act is-danger" disabled={!store.ready} onClick={() => setView('delete')}>
                  <Trash2 size={22} strokeWidth={1.8} />
                  {t('deleteChat')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 模型列表（按服务商分组），当前用的打勾；点一个立即切换。 */
function ModelPicker({ store, s, onBack }: { store: Store; s: WebSession; onBack: () => void }): React.JSX.Element {
  const [list, setList] = useState<WebModel[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const { ops } = store
  useEffect(() => {
    let alive = true
    void ops.loadModels().then((l) => {
      if (!alive) return
      setList(l)
      setFailed(!l)
    })
    return () => {
      alive = false
    }
  }, [ops])
  const groups = new Map<string, WebModel[]>()
  for (const m of list ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m])
  const pick = async (ref: string): Promise<void> => {
    if (busy || ref === s.model) return onBack()
    setBusy(ref)
    const ok = await ops.setModel(s.id, ref)
    setBusy(null)
    if (ok) onBack()
  }
  return (
    <>
      <div className="sheet__nav">
        <button className="ib" aria-label={t('cancel')} onClick={onBack}>
          <ChevronLeft size={24} strokeWidth={1.8} />
        </button>
        <b>{t('pickModel')}</b>
      </div>
      <div className="sheet__list">
        {!list && !failed && (
          <div className="sheet__wait">
            <span className="spin" />
          </div>
        )}
        {failed && <div className="sheet__wait">{t('timeout')}</div>}
        {list && !list.length && <div className="sheet__wait">{t('noModel')}</div>}
        {[...groups].map(([provider, models]) => (
          <div key={provider}>
            <div className="sheet__sec">{provider}</div>
            {models.map((m) => (
              <button key={m.ref} className="mrow" disabled={!!busy} onClick={() => void pick(m.ref)}>
                <span className="mrow__name">{m.name}</span>
                {busy === m.ref ? <span className="spin" /> : m.ref === s.model ? <Check size={19} className="mrow__on" /> : null}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
