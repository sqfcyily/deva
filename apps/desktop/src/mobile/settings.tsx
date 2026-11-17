import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Monitor, Plus } from 'lucide-react'
import { WEB_PROTOCOL_VERSION } from '../shared/remote-web'
import type { Store, TextSize } from './App'
import { Dialog } from './dialog'
import { t } from './strings'
import type { ThemePref } from './theme'
import type { DeskCred } from './vault'

/**
 * 设置（抽屉底部进入）：电脑（可连多台）· 提醒与显示 · 这台手机。
 * 电脑分组右上「管理」：每行右侧出现「删除」（微信式），点「完成」收起；管理时点行不切换。
 */
export function Settings({ store }: { store: Store }): React.JSX.Element {
  const via = location.protocol === 'https:' ? t('viaRelay') : t('viaLan')
  const notifyHint =
    store.notify === 'need-install'
      ? t('notifyNeedInstall')
      : store.notify === 'need-https'
        ? t('notifyNeedHttps')
        : store.notify === 'denied'
          ? t('notifyDenied')
          : store.notify === 'unsupported'
            ? t('notifyUnsupported')
            : t('notifyHint')
  const canToggle = store.notify === 'on' || store.notify === 'off'
  const [dialog, setDialog] = useState<'rename' | 'disconnect' | null>(null)
  const [managing, setManaging] = useState(false)
  const [removing, setRemoving] = useState<DeskCred | null>(null)
  const manage = managing && store.desks.length > 0
  const pcName = (d: DeskCred): string => d.computer || t('thisComputer')

  return (
    <div className="page">
      <header className="tb tb--sub">
        <button className="ib" aria-label="back" onClick={store.back}>
          <ChevronLeft size={26} strokeWidth={1.8} />
        </button>
        <h1 className="tb__t">{t('settings')}</h1>
      </header>
      <div className="scroll set">
        <div className="set__cap set__cap--row">
          {t('computers')}
          {store.desks.length > 0 && (
            <button className="set__act" onClick={() => setManaging(!manage)}>
              {manage ? t('done') : t('manage')}
            </button>
          )}
        </div>
        <div className="group">
          {store.desks.length === 0 && (
            <div className="cell">
              <span className="tile">
                <Monitor size={19} />
              </span>
              <span className="cell__k">
                <b>{store.computer}</b>
              </span>
            </div>
          )}
          {store.desks.map((d) => {
            const cur = d.deskId === store.deskId
            const body = (
              <>
                <span className={`tile${cur ? '' : ' is-grey'}`}>
                  <Monitor size={19} />
                </span>
                <span className="cell__k">
                  <b>{pcName(d)}</b>
                  {cur && (
                    <span>
                      <span className={`okdot${store.ready ? '' : ' is-wait'}`} />
                      {store.ready ? t('connected') : store.phase.kind === 'offline' ? t('offlineShort') : t('connectingTitle')} · {via} ·{' '}
                      {t('e2e')}
                    </span>
                  )}
                </span>
              </>
            )
            return manage ? (
              <div key={d.deskId} className="cell">
                {body}
                <button className="cell__del" onClick={() => setRemoving(d)}>
                  {t('delete')}
                </button>
              </div>
            ) : (
              <button key={d.deskId} className="cell" disabled={cur} onClick={() => store.switchDesk(d.deskId)}>
                {body}
                {cur ? <Check size={18} className="cell__v" /> : <ChevronRight size={17} className="cell__v" />}
              </button>
            )
          })}
          {!manage && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && (
            <button className="cell" onClick={() => store.setOverlay('scan')}>
              <span className="tile is-grey">
                <Plus size={19} />
              </span>
              <span className="cell__k">
                <b>{t('addComputer')}</b>
                <span>{t('addComputerHint')}</span>
              </span>
              <ChevronRight size={17} className="cell__v" />
            </button>
          )}
        </div>

        <div className="set__cap">{t('remindDisplay')}</div>
        <div className="group">
          <div className="cell">
            <span className="cell__k">
              <b>{t('notifications')}</b>
              <span>{notifyHint}</span>
            </span>
            <button
              className={`sw${store.notify === 'on' ? ' is-on' : ''}`}
              disabled={!canToggle || !store.ready || !store.vapid}
              aria-pressed={store.notify === 'on'}
              aria-label={t('notifications')}
              onClick={() => void (store.notify === 'on' ? store.disableNotify() : store.enableNotify())}
            />
          </div>
          <div className="cell">
            <span className="cell__k">
              <b>{t('appearance')}</b>
            </span>
            <span className="seg">
              {(['system', 'light', 'dark'] as ThemePref[]).map((v) => (
                <button key={v} className={store.theme === v ? 'is-on' : ''} onClick={() => store.setTheme(v)}>
                  {t(v === 'system' ? 'themeSystem' : v === 'light' ? 'themeLight' : 'themeDark')}
                </button>
              ))}
            </span>
          </div>
          <div className="cell">
            <span className="cell__k">
              <b>{t('textSize')}</b>
            </span>
            <span className="seg">
              {(['sm', 'md', 'lg'] as TextSize[]).map((s) => (
                <button key={s} className={store.textSize === s ? 'is-on' : ''} onClick={() => store.setTextSize(s)}>
                  {t(s === 'sm' ? 'sizeSm' : s === 'md' ? 'sizeMd' : 'sizeLg')}
                </button>
              ))}
            </span>
          </div>
        </div>

        <div className="set__cap">{t('thisPhone')}</div>
        <div className="group">
          <button className="cell" disabled={!store.ready} onClick={() => setDialog('rename')}>
            <span className="cell__k">
              <b>{t('shownAs')}</b>
            </span>
            <span className="cell__v">{store.deviceName}</span>
            <ChevronRight size={17} className="cell__v" />
          </button>
          <button className="cell is-danger" onClick={() => setDialog('disconnect')}>
            <span className="cell__k">
              <b>{t('disconnect')}</b>
              <span>{t('disconnectHint')}</span>
            </span>
          </button>
        </div>
        <div className="ver">{t('version', { v: WEB_PROTOCOL_VERSION })}</div>
      </div>
      {dialog === 'rename' && (
        <Dialog
          title={t('renamePrompt')}
          message={t('renameHint')}
          input={{ value: store.deviceName, placeholder: t('phone'), maxLength: 40 }}
          confirmLabel={t('save')}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null)
            if (name !== store.deviceName) void store.rename(name)
          }}
        />
      )}
      {removing && (
        <Dialog
          title={t('removePcTitle', { pc: pcName(removing) })}
          message={t('disconnectConfirm', { pc: pcName(removing) })}
          confirmLabel={t('delete')}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.deskId
            setRemoving(null)
            void store.removeComputer(id)
          }}
        />
      )}
      {dialog === 'disconnect' && (
        <Dialog
          title={t('disconnect')}
          message={t('disconnectConfirm', { pc: store.computer })}
          confirmLabel={t('disconnectOk')}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void store.disconnect()
          }}
        />
      )}
    </div>
  )
}
