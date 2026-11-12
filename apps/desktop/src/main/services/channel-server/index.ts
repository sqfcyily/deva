import { BrowserWindow, ipcMain, Notification } from 'electron'
import QRCode from 'qrcode'
import type { ChannelState } from '../remote/types'
import { getConfig } from '../config'
import { deleteSecretsByPrefix } from '../secrets'
import { getGeneralServerConfig, patchGeneralServer, removeDevice, renameDevice, setDeviceEnabled } from './config'
import { invalidateTokenCache } from './auth'
import { cancelPairCode, issuePairCode, lanHost, lanHosts } from './pairing'
import { startServer, stopServer } from './server'
import { closeDeviceConnections, dropSession, startEventStream, stopEventStream } from './sse'
import { dropDevice, deviceActivity } from './activity'
import { onSessionPurge } from '../chat'

/**
 * 安卓客户端的入站通道（设计 §3）：把已存在的 chatRuntime / chat-bus 暴露给已配对设备。
 * 生命周期与 IM 通道同形——状态用 ChannelState 同形（off / connecting / connected / error）；
 * 停在出站通道之后（主进程退出时序：stopAllChannels → stopChannelServer）。
 * 桌面「机器人」面板经这里的 IPC 显示配对码 / 设备列表；密钥只写不读。
 */

export interface GeneralDeviceView {
  id: string
  name: string
  pairedAt: number
  /** 单设备启停（审查 F1/F8）：false 即该设备请求一律 401。 */
  enabled: boolean
  /** 进程内活动态（activity.ts）：有存活的 SSE 连接 / 最近一次带鉴权请求时间。 */
  online: boolean
  lastSeenAt: number
}

export interface GeneralServerView {
  enabled: boolean
  host: string
  port: number
  state: ChannelState
  error?: string
  devices: GeneralDeviceView[]
}

let state: ChannelState = 'off'
let stateError: string | undefined
let running = false
const listeners = new Set<() => void>()

/** 渲染层窗口引用（registerChannelServerIpc 注入）：状态变化即推 general:changed。 */
let getWindowFn: () => BrowserWindow | null = () => null

function setState(s: ChannelState, error?: string): void {
  state = s
  stateError = error
  for (const l of listeners) l()
  // 推送到渲染层（机器人面板订阅，替代轮询；审查 F7）
  const w = getWindowFn()
  if (w && !w.isDestroyed()) w.webContents.send('general:changed', getChannelServerState())
}

export function getChannelServerState(): GeneralServerView {
  const cfg = getGeneralServerConfig()
  return {
    enabled: cfg.enabled,
    host: cfg.host,
    port: cfg.port,
    state,
    ...(stateError ? { error: stateError } : {}),
    devices: cfg.devices.map((d) => ({
      enabled: d.enabled,
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      ...deviceActivity(d.id)
    }))
  }
}

export function onChannelServerChange(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * 新设备配对成功的桌面系统通知（对齐 reply-notify 的模式）：窗口在焦点上时用户多半正盯着
 * 机器人面板看设备出现，不打扰；失焦（最小化 / 托盘 / 被盖住）必提醒——新设备接入是安全事件。
 * 点击唤起窗口（落回消息视图，面板列表 5s 轮询自会刷新）。
 */
function notifyDevicePaired(name: string): void {
  const w = getWindowFn()
  if (w && !w.isDestroyed() && w.isFocused()) return
  try {
    if (!Notification.isSupported()) return
    const en = getConfig().locale === 'en'
    const n = new Notification({
      title: 'Deva',
      body: en ? `New device "${name}" has been paired` : `新设备「${name}」已配对接入`
    })
    n.on('click', () => {
      const win = getWindowFn()
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch {
    /* 通知不可用 / 抛错 → 静默降级 */
  }
}

/** 幂等启动；generalServer.enabled=false 时保持 off（不占端口）。 */
export async function startChannelServer(): Promise<void> {
  if (running) return
  const cfg = getGeneralServerConfig()
  if (!cfg.enabled) {
    setState('off')
    return
  }
  running = true
  startEventStream()
  setState('connecting')
  try {
    await startServer({ host: cfg.host, port: cfg.port }, {
      onState: (s, error) => {
        if (s === 'error') running = false
        setState(s, error)
      },
      onDevicePaired: notifyDevicePaired
    })
  } catch (e) {
    running = false
    setState('error', (e as Error)?.message ?? String(e))
  }
}

export async function stopChannelServer(): Promise<void> {
  running = false
  stopEventStream()
  await stopServer()
  setState('off')
}

export function registerChannelServerIpc(getWindow: () => BrowserWindow | null = () => null): void {
  getWindowFn = getWindow
  ipcMain.handle('general:get-state', (): GeneralServerView => getChannelServerState())

  // 生成一次性配对码 + 二维码（内容 deva://pair?host=<host>&port=<port>&code=<code>，设计 §3.2）
  ipcMain.handle(
    'general:pair-code',
    async (): Promise<
      | {
          ok: true
          code: string
          expiresAt: number
          qr: string
          host: string
          hosts: string[]
          port: number
          localOnly: boolean
        }
      | { ok: false; error: string }
    > => {
      const cfg = getGeneralServerConfig()
      if (!cfg.enabled) return { ok: false, error: '通用设备通道未启用。' }
      const { code, expiresAt } = issuePairCode()
      // 仅本机模式：QR 嵌 127.0.0.1 并明示；局域网模式：全部候选地址给 UI 展示（多网卡/VPN 机器第一个未必可达）
      const localOnly = cfg.host === '127.0.0.1'
      const host = localOnly ? '127.0.0.1' : lanHost()
      const hosts = localOnly ? ['127.0.0.1'] : lanHosts()
      const qr = await QRCode.toDataURL(
        `deva://pair?host=${encodeURIComponent(host)}&port=${cfg.port}&code=${code}`,
        { margin: 1, width: 360 }
      )
      return { ok: true, code, expiresAt, qr, host, hosts, port: cfg.port, localOnly }
    }
  )

  // 设备改名：净化 + 全局唯一（config.renameDevice），两端面板实时可见（5s 轮询）
  ipcMain.handle('general:rename-device', (_e, id: string, rawName: string) => renameDevice(id, rawName))

  // 单设备启停（审查 F1/F8）：false 即该设备请求一律 401
  ipcMain.handle('general:set-device-enabled', (_e, id: string, enabled: boolean): { ok: true } => {
    setDeviceEnabled(id, enabled)
    // 启停都失效 token 缓存:停用后旧 token 立即 401;启用后设备 token 立即回到缓存
    // (否则「停用 → 主进程重启 → 启用」序列里缓存可能停留在停用快照,设备被 401 到下次失效为止)
    invalidateTokenCache()
    if (!enabled) closeDeviceConnections(id) // 掐断停用设备的 SSE:鉴权只在建连时做,必须主动断
    return { ok: true }
  })

  // 通道启停开关（设计 §3.1）：enabled=false 即停止监听、不占端口
  ipcMain.handle('general:set-enabled', (_e, enabled: boolean): { ok: true } => {
    patchGeneralServer({ enabled })
    void stopChannelServer()
      .then(() => startChannelServer())
      .catch((e) => console.warn('[channel-server] 重启监听失败：', (e as Error)?.message ?? e))
    return { ok: true }
  })

  ipcMain.handle('general:pair-cancel', (): { ok: true } => {
    cancelPairCode()
    return { ok: true }
  })

  // 吊销设备：删配置 + 删密钥（general:<id>:token）+ 清活动态 + 掐断其全部 SSE 连接，此后请求一律 401
  ipcMain.handle('general:remove-device', async (_e, id: string): Promise<{ ok: true }> => {
    removeDevice(id)
    await deleteSecretsByPrefix(`general:${id}:`)
    dropDevice(id)
    closeDeviceConnections(id)
    invalidateTokenCache()
    return { ok: true }
  })

  // 「仅本机」开关（设计 §3.1）：host 只认 127.0.0.1 / 0.0.0.0 两档；改完重启监听，状态经轮询可见
  ipcMain.handle('general:set-host', (_e, host: string): { ok: true } => {
    patchGeneralServer({ host: host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0' })
    void stopChannelServer()
      .then(() => startChannelServer())
      .catch((e) => console.warn('[channel-server] 重启监听失败：', (e as Error)?.message ?? e))
    return { ok: true }
  })

  // 会话删除 → 回收该会话的事件环形缓冲（审查 P1-4）
  onSessionPurge(dropSession)

  // 随主进程启动（enabled=false 或端口冲突都只置状态、记日志，不阻塞启动）
  void startChannelServer().catch((e) => console.warn('[channel-server] 启动失败：', (e as Error)?.message ?? e))
}
