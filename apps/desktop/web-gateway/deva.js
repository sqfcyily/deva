/**
 * Deva 控制层（CDP over WebSocket，附加到已在运行的 Deva）。
 *
 * 为什么不直读 ~/.deva/data/chats：那只有历史。Deva 的回合由主进程执行，只有渲染层的
 * window.deva.chat 才能起一轮、收流事件、回应交互卡。
 *
 * 为什么是「附加」而不是「启动」：调试接口只在 Deva 启动时开放。故 Deva 平时启动就带
 * --remote-debugging-port=0（系统随机挑一个回环端口，并把端口号写进 <user-data-dir>/DevToolsActivePort）。
 * 网关起来后按这份文件找到端口，接上去——**Deva 是它自己那次启动的，网关只是搭车**，
 * 所以关掉网关不会波及正在用的 Deva。Deva 没带调试接口时，网关没有任何办法接管，只能报错。
 */
'use strict'

const { EventEmitter } = require('node:events')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** 注入页面的桥接脚本：把 chat:event 与 sessions-changed 转给网关。 */
const BRIDGE_SRC = `
(() => {
  if (window.__gwBridge) return 'already';
  const emit = (v) => { try { window.__gwEmit(JSON.stringify(v)) } catch (e) {} };
  window.__gwBridge = emit;
  window.deva.chat.onEvent((p) => emit({ k: 'ev', turnId: p.turnId, sid: p.sessionId, e: p.event }));
  window.deva.chat.onSessionsChanged(() => emit({ k: 'sessions' }));
  emit({ k: 'ready' });
  return 'installed';
})()
`

/** Deva（Electron）的默认 user-data-dir：%APPDATA%\<产品名>。 */
function defaultUserDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '@deva', 'desktop')
}

class DevaControl extends EventEmitter {
  /**
   * @param {{userDataDir?: string, log?: (line: string) => void}} opts
   */
  constructor(opts = {}) {
    super()
    this.userDataDir = opts.userDataDir || process.env.DEVA_GATEWAY_UD || defaultUserDataDir()
    this.log = opts.log || ((l) => console.log(l))
    this.ws = null
    this.alive = false
    this.pageReady = false
    this.targetId = null
    this.sessionId = null
    this.seq = 0
    this.pending = new Map()
    this.retryTimer = null
    this.stopping = false
    this.lastError = ''
  }

  /** DevToolsActivePort：第 1 行端口，第 2 行浏览器 ws 路径。 */
  portFile() {
    return path.join(this.userDataDir, 'DevToolsActivePort')
  }

  _readPort() {
    const file = this.portFile()
    if (!existsSync(file)) {
      throw new Error(
        `没找到 Deva 的调试端口文件：${file}\n` +
          '这说明 Deva 启动时没带调试接口。请用程序目录的「启动 Deva.bat」打开 Deva（它已包含必要参数）。'
      )
    }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    const port = Number(lines[0])
    if (!Number.isInteger(port) || port <= 0) throw new Error(`端口文件内容异常：${file}`)
    return { port, browserPath: (lines[1] || '').trim() }
  }

  /** 找浏览器级 ws 地址；旧版可能没有 DevToolsActivePort，则退回 /json/version 探测。 */
  async _browserWs() {
    const { port, browserPath } = this._readPort()
    if (browserPath.startsWith('/')) return `ws://127.0.0.1:${port}${browserPath}`
    const r = await fetch(`http://127.0.0.1:${port}/json/version`)
    const j = await r.json()
    return j.webSocketDebuggerUrl
  }

  /** 接上已在运行的 Deva。失败时不会自动重试（那是 startWatch 的事）。 */
  async attach() {
    if (this.alive) return
    const url = await this._browserWs()
    await this._connect(url)
    await this._attachPage()
    this.alive = true
    this.lastError = ''
    this.emit('state', { deva: 'running', page: this.pageReady })
  }

  _connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {}
        reject(new Error('连不上 Deva 调试端口（可能 Deva 已退出）'))
      }, 8000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('连不上 Deva 调试端口（可能 Deva 已退出）'))
      }
      ws.onmessage = (m) => {
        let msg
        try {
          msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString())
        } catch {
          return
        }
        this._onMessage(msg)
      }
      ws.onclose = () => {
        const wasAlive = this.alive
        this.alive = false
        this.pageReady = false
        this.ws = null
        this.emit('state', { deva: 'stopped', page: false })
        if (wasAlive && !this.stopping) this.log('[deva] 连接断开（Deva 关掉了？）')
      }
    })
  }

  /** 页面级：开 Runtime、装绑定、注入桥，然后开始收事件。 */
  async _attachPage() {
    let target = null
    for (let i = 0; i < 40; i++) {
      const r = await this._send('Target.getTargets')
      target = (r.targetInfos || []).find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (target) break
      await new Promise((res) => setTimeout(res, 250))
    }
    if (!target) throw new Error('Deva 里没有找到主窗口页面')
    this.targetId = target.targetId

    const att = await this._send('Target.attachToTarget', { targetId: this.targetId, flatten: true })
    this.sessionId = att.sessionId
    await this._send('Runtime.enable', {}, this.sessionId)
    await this._send('Runtime.addBinding', { name: '__gwEmit' }, this.sessionId)
    const r = await this._send('Runtime.evaluate', { expression: BRIDGE_SRC, returnByValue: true }, this.sessionId)
    if (r?.exceptionDetails) throw new Error('注入失败：' + (r.exceptionDetails.text || '未知'))
    if (r?.result?.value === 'already') {
      this.pageReady = true
      this.emit('state', { deva: 'running', page: true })
    }
  }

  /** 断开（Deva 不受影响——它是用户自己启动的）。 */
  async stop() {
    this.stopping = true
    this.alive = false
    this.pageReady = false
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
    }
    this.ws = null
    this.emit('state', { deva: 'stopped', page: false })
  }

  /** 定期确认 Deva 还在、还没换过调试端口（重开 Deva 后端口会变），断了就自己接上。 */
  startWatch(intervalMs = 3000) {
    if (this.retryTimer) return
    this.stopping = false
    this.retryTimer = setInterval(async () => {
      if (this.stopping) return
      if (this.alive && this.ws && this.ws.readyState === 1) return
      try {
        await this.attach()
        this.log('[deva] 已接上 Deva')
      } catch (e) {
        const msg = e.message || String(e)
        if (msg !== this.lastError) {
          this.lastError = msg
          this.log(`[deva] 未接上：${msg.split('\n')[0]}`)
        }
        this.emit('state', { deva: 'stopped', page: false, error: msg })
      }
    }, intervalMs)
    this.retryTimer.unref?.()
  }

  stopWatch() {
    this.stopping = true
    if (this.retryTimer) clearInterval(this.retryTimer)
    this.retryTimer = null
  }

  // ───────── CDP 传输 ─────────

  _onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === '__gwEmit') {
      let v
      try {
        v = JSON.parse(msg.params.payload)
      } catch {
        return
      }
      if (v.k === 'ready') {
        if (!this.pageReady) {
          this.pageReady = true
          this.emit('state', { deva: 'running', page: true })
          this.log('[deva] 渲染层已接管')
        }
        return
      }
      if (v.k === 'ev' || v.k === 'sessions') this.emit('event', v)
    }
  }

  _send(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Deva 未连接'))
    const id = ++this.seq
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(msg))
    })
  }

  /** 在渲染层求值；页面重载/未就绪时重连一次。 */
  async eval(expression, { awaitPromise = true } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.alive || !this.ws) {
        await this.attach()
      }
      try {
        const r = await this._send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise, includeCommandLineAPI: true },
          this.sessionId
        )
        if (r?.exceptionDetails) {
          const d = r.exceptionDetails
          throw new Error(d.exception?.description?.split('\n')[0] || d.text || '渲染层异常')
        }
        return r?.result?.value
      } catch (e) {
        if (attempt === 0 && /Cannot find context|Inspected target navigated|Session with given id not found|Deva 未连接/i.test(e.message)) {
          this.alive = false
          this.sessionId = null
          await this.attach()
          continue
        }
        throw e
      }
    }
  }

  /** 调 window.deva.<path>(...args)，参数走 JSON 传递。 */
  callApi(path, args = []) {
    const a = args.map((x) => JSON.stringify(x === undefined ? null : x)).join(',')
    return this.eval(`window.${path}(${a})`)
  }
}

module.exports = { DevaControl, defaultUserDataDir }
