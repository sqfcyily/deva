/**
 * Deva 本地远程网关。
 *
 * 一个零依赖的 HTTP 服务：把网页上的操作翻译成 window.deva.chat 的调用（经 deva.js 的 CDP 通道），
 * 再把主进程推上来的流事件经 SSE 转回网页。手机同局域网打开 http://<IP>:8765/?key=xxx 即可继续对话。
 *
 * 只做「遥控 + 转述」，不另起一套 Agent：回合、权限、落盘全由 Deva 主进程负责，
 * 和桌面端走的是同一个入口（chat:send / chat:ask-response / …）。
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { DevaControl } = require('./deva')

const PAGE = path.join(__dirname, 'web', 'index.html')
const PORT = Number(process.env.DEVA_GATEWAY_PORT || 8765)
const KEY_FILE = path.join(os.homedir(), '.deva', 'remote-key.txt')

let key = ''
let deva = null
/** sessionId → 本轮正在进行中的原始事件（已合并连续 text_delta），供中途接入的页面补看。 */
const inflight = new Map()
/** 本进程已知的「回合正在跑」的会话，用于列表上的运行指示。 */
const running = new Set()
const sseClients = new Set()
const sessionStates = new Map()
const stateVersions = new Map()
let syncPromise = null
let stateSyncedAt = null
let stateError = ''

/** sessionId → 本轮已插入、尚未送到的文字（主进程 inserts 事件），供中途接入的页面补看。 */
const pendingInserts = new Map()

function apiError(status, message) {
  return Object.assign(new Error(message), { status })
}

function sessionState(sid) {
  return sessionStates.get(sid) || { running: false, turnId: null, startedAt: null, completedAt: null }
}

function applyState(sid, turnId, startedAt, completed = false) {
  const old = sessionState(sid)
  const next = {
    running: !!turnId, turnId: turnId || null,
    startedAt: turnId ? (startedAt || (old.turnId === turnId ? old.startedAt : null)) : null,
    completedAt: completed ? Date.now() : old.completedAt
  }
  sessionStates.set(sid, next)
  if (turnId) running.add(sid)
  else { running.delete(sid); inflight.delete(sid) }
  if (old.turnId !== next.turnId || old.completedAt !== next.completedAt) {
    broadcast({ k: 'sessions', sid, ...next })
  }
  return next
}

// IPC 是状态真源；在渲染层归约快照，避免轮询把整个历史传回 CDP。
// 每会话事件版本防止等待中的旧快照覆盖新到达的 start/done。
async function syncSessions() {
  if (syncPromise) return syncPromise
  const versions = new Map(stateVersions)
  syncPromise = (async () => {
    try {
      const rows = await deva.eval(`(async () => {
        const list = await window.deva.chat.listSessions(null);
        const out = [];
        for (const meta of list) {
          const a = await window.deva.chat.attachSession(meta.id);
          out.push({ meta, turnId: a.turnId, startedAt: a.startedAt });
        }
        return out;
      })()`)
      if (!Array.isArray(rows)) throw new Error('会话状态返回格式异常')
      for (const row of rows) {
        const sid = row.meta.id
        if ((stateVersions.get(sid) || 0) !== (versions.get(sid) || 0)) continue
        applyState(sid, row.turnId, row.startedAt, running.has(sid) && !row.turnId)
      }
      const ids = new Set(rows.map(r => r.meta.id))
      for (const sid of sessionStates.keys()) {
        if (!ids.has(sid) && (stateVersions.get(sid) || 0) === (versions.get(sid) || 0)) {
          running.delete(sid); inflight.delete(sid); sessionStates.delete(sid)
        }
      }
      stateSyncedAt = Date.now()
      stateError = ''
      return rows.map(r => r.meta)
    } catch (e) {
      stateError = e.message
      throw apiError(503, `无法确认会话状态：${e.message}`)
    } finally { syncPromise = null }
  })()
  return syncPromise
}

async function attachSession(sid) {
  const version = stateVersions.get(sid) || 0
  const r = await deva.callApi('deva.chat.attachSession', [sid])
  if (!r || !Object.hasOwn(r, 'turnId')) throw apiError(503, '无法确认会话状态')
  if ((stateVersions.get(sid) || 0) === version) {
    applyState(sid, r.turnId, r.startedAt, running.has(sid) && !r.turnId)
  }
  return r
}

function log(line) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${t}] ${line}`)
}

// ───────── 密钥 ─────────

function loadKey() {
  // 环境变量优先：便于隔离测试或临时换一把钥
  const fromEnv = (process.env.DEVA_GATEWAY_KEY || '').trim()
  if (fromEnv) return fromEnv
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim()
    if (k) return k
  } catch {}
  const k = crypto.randomBytes(6).toString('hex')
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
    fs.writeFileSync(KEY_FILE, k + '\n', 'utf8')
  } catch (e) {
    log(`写入密钥文件失败（用临时密钥继续）：${e.message}`)
  }
  return k
}

function authorized(req, url) {
  const given =
    url.searchParams.get('key') ||
    req.headers['x-gateway-key'] ||
    (req.headers.cookie || '').match(/(?:^|;\s*)deva_gw=([^;]+)/)?.[1] ||
    ''
  if (!given || given.length !== key.length) return false
  // 定长比较，避免时序侧信道（局域网场景不必过度紧张，但成本为零）
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))
}

// ───────── SSE ─────────

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcast(payload) {
  for (const res of sseClients) {
    try {
      sseSend(res, payload)
    } catch {}
  }
}

// ───────── 事件整形 ─────────

/** 连续 text_delta 合并成一条，免得半屏中文被切成几百条事件来回传。 */
function pushEvent(sid, ev) {
  const list = inflight.get(sid) || []
  const last = list[list.length - 1]
  if (ev.type === 'text_delta' && last?.type === 'text_delta') {
    list[list.length - 1] = { type: 'text_delta', text: last.text + ev.text }
  } else {
    list.push(ev)
  }
  inflight.set(sid, list)
}

function onDevaEvent(v) {
  if (v.k === 'sessions') {
    broadcast({ k: 'sessions' })
    return
  }
  const { sid, turnId, e } = v
  if (!sid || !e) return

  if (e.type === 'turn_start' && turnId) {
    stateVersions.set(sid, (stateVersions.get(sid) || 0) + 1)
    inflight.set(sid, [e])
    pendingInserts.delete(sid)
    applyState(sid, turnId, e.startedAt || Date.now())
  } else if (e.type === 'done') {
    const current = sessionState(sid)
    // 迟到的上一轮 done 不能清掉新一轮。
    if (!current.turnId || !turnId || current.turnId === turnId) {
      stateVersions.set(sid, (stateVersions.get(sid) || 0) + 1)
      pendingInserts.delete(sid)
      applyState(sid, null, null, current.running || current.completedAt === null)
    }
  } else if (e.type === 'inserts') {
    // 主进程是「当前这一轮还有哪几条插入没送到」的真源，记下来给页面重连后补看。
    pendingInserts.set(sid, Array.isArray(e.pending) ? e.pending.slice() : [])
  } else if (running.has(sid) && (!turnId || sessionState(sid).turnId === turnId)) {
    pushEvent(sid, e)
  }
  broadcast({ k: 'ev', sid, turnId, e })
}

// ───────── 模型解析 ─────────

/** config.json 里的模型清单 → 网页下拉用；同时给出可解析的 provider 信息。 */
async function modelsPayload() {
  const cfg = await deva.eval('window.deva.config.get()')
  const models = cfg?.models || {}
  const providers = (models.providers || [])
    .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
    .map((p) => ({
      id: p.id,
      name: p.name,
      accent: p.accent || null,
      models: (p.models || []).filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name || m.id }))
    }))
    .filter((p) => p.models.length > 0)
  return {
    providers,
    activeModelId: models.activeModelId || null,
    activeEffort: models.activeEffort || 'default'
  }
}

/** `providerId:modelId` → chat.send 需要的 model 对象（按首个冒号切，模型 id 自身可带冒号）。 */
async function resolveModel(modelRef) {
  const cfg = await deva.eval('window.deva.config.get()')
  const models = cfg?.models || {}
  const ref = modelRef || models.activeModelId || ''
  if (!ref) throw new Error('还没有选择模型：请先在设置里选一个')
  const i = ref.indexOf(':')
  if (i <= 0) throw new Error(`模型标识无效：${ref}`)
  const pid = ref.slice(0, i)
  const mid = ref.slice(i + 1)
  const provider = (models.providers || []).find((p) => p.id === pid)
  if (!provider) throw new Error(`找不到服务商：${pid}`)
  const def = (provider.models || []).find((m) => m.id === mid)
  if (!def) throw new Error(`该服务商下没有模型：${mid}`)
  return {
    model: { adapter: provider.adapter, providerId: pid, baseURL: provider.apiHost, model: mid },
    modelRef: ref,
    effort: models.activeEffort || 'default'
  }
}

/** 新建会话用的 id：与 Deva 自己的 `sess_<base36 时间>_<序号>` 同形。 */
function newSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.floor(Math.random() * 1296).toString(36)}`
}

// ───────── 角色头像 ─────────

/**
 * 头像缓存：personaId → data URI。
 *
 * Deva 的头像由 Humation 引擎按 persona.id 确定性生成（同一 id 恒同一张脸），画法在渲染层里。
 * 网关不重画那套引擎，而是请渲染层把它算出来的 SVG 序列化过来——这样手机上和桌面上是同一张脸，
 * 而不是我另捏一个近似的。算一次缓存起来，之后只当静态资源发。
 */
const avatarCache = new Map()

/**
 * 从渲染层取某角色的头像（无自定义图时）。
 * 入参既接受 persona id 也接受角色名——调用方未必知道对方，按 id 查花名册拿到名字再去匹配
 * `<title>名字 · 描述`，两个都给就不会因为只给了一个而漏。
 *
 * 输出分两种：
 *  - 自定义头像 → data URI，原样用；
 *  - 生成头像 → **返回结构化 SVG**（底色 + 人物 + 底板路径 d），由前端按「闲置=圆 / 生成中=星芒」
 *    自己画底板。Deva 里底板会随忙碌状态在圆与转动的星芒之间变形（humation.tsx 的 useBusyMorph），
 *    这里把底板数据单独交出来，前端才能照同一套形状规则画，而不是把静态图当死图用。
 */
async function personaAvatar(key) {
  if (avatarCache.has(key)) return avatarCache.get(key)

  const expr = `(async () => {
    const want = ${JSON.stringify(key)};
    const list = await window.deva.personas.list();
    const p = list.find((x) => x.id === want) || list.find((x) => x.name === want);
    if (!p) return null;
    if (p.avatarImage) return { kind: 'image', data: p.avatarImage };

    const svg = [...document.querySelectorAll('svg.hm-ava')]
      .find((s) => (s.querySelector('title')?.textContent || '').startsWith(p.name + ' · '));
    if (!svg) return { kind: 'miss', name: p.name };

    const c = svg.cloneNode(true);
    c.setAttribute('class', 'hm-ava');
    c.setAttribute('width', '100%');
    c.setAttribute('height', '100%');

    // 底板 = 第一枚实心 path（fill 不是 none）：它的 d 就是当前形状轮廓。
    // 同一条 d 也用在裁切与描边上，所以这里取一次，前端拿去生成圆/星芒都行。
    const plate = [...c.querySelectorAll(':scope > path')].find(
      (x) => (x.getAttribute('fill') || '').toLowerCase() !== 'none'
    );
    return {
      kind: 'svg',
      name: p.name,
      background: plate ? plate.getAttribute('fill') : null,
      plateD: plate ? plate.getAttribute('d') : null,
      viewBox: c.getAttribute('viewBox'),
      svg: c.outerHTML
    };
  })()`

  const r = await deva.eval(expr)
  if (!r) return null
  if (r.kind === 'image') {
    avatarCache.set(key, r.data)
    return r.data
  }
  if (r.kind !== 'svg') return null

  // 同页多个头像的 clipPath id 会互相覆盖：把 id 前缀换成按角色唯一的，避免串味
  const salt = Math.abs([...r.name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)
  const svg = r.svg.replace(/hm(r[a-z0-9]+)/g, (m) => `gw${salt}${m.slice(2)}`)

  const out = {
    kind: 'svg',
    // 没有自定义底板色时退回主题色块，避免透明看穿
    background: r.background || '#8a8a94',
    plateD: r.plateD,
    viewBox: r.viewBox || '4 12 72 72',
    svg
  }
  avatarCache.set(key, out)
  return out
}

// ───────── 图片附件 ─────────

/**
 * 手机/网页传附件落盘。
 *
 * chat.send 的 attachments 要的是**绝对路径**，正文由主进程自己读（见 preload 的 ChatSendRequest
 * 注释：base64 不经渲染层）。所以网页这边把文件传上来，网关存到临时目录，再把路径交给 Deva——
 * 走的是和桌面端选文件 / 拖进来完全相同的通路，类型识别（图片 / PDF / 文本）也由 Deva 自己做。
 */
function uploadDir() {
  const dir = path.join(os.tmpdir(), 'deva-gateway-uploads')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 只保留安全字符，避免把奇怪的名字写进路径。 */
function safeName(name, fallback) {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return base || fallback
}

/** 从 dataURL 落到磁盘，返回 { path, name, size }。 */
function saveDataUrl(dataUrl, fileName) {
  const m = /^data:([^;,]*);base64,(.+)$/s.exec(String(dataUrl || ''))
  if (!m) throw new Error('文件格式不对（需要 base64 dataURL）')
  const mime = m[1] || 'application/octet-stream'
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 32 * 1024 * 1024) throw new Error('文件太大（上限 32MB）')

  const fromMime =
    {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'application/pdf': '.pdf',
      'text/plain': '.txt',
      'text/markdown': '.md',
      'application/json': '.json'
    }[mime] || ''
  const wanted = safeName(fileName, '')
  const ext = path.extname(wanted) || fromMime
  const stem = wanted ? path.basename(wanted, path.extname(wanted)) : `file-${Date.now().toString(36)}`
  // 加随机后缀避免同名覆盖
  const name = `${stem}-${Math.random().toString(36).slice(2, 7)}${ext}`
  const full = path.join(uploadDir(), name)
  fs.writeFileSync(full, buf)
  return { path: full, name, size: buf.length }
}

// ───────── 交付文件 ─────────

/** 能直接在网页里显示的类型。 */
const INLINE_TEXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat',
  '.ps1', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.log', '.csv', '.sql', '.xml', '.svg'
])
const INLINE_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
INLINE_TEXT.add('.mjs')
INLINE_TEXT.add('.cjs')
const TEXT_LIMIT = 512 * 1024
const IMAGE_LIMIT = 8 * 1024 * 1024
const RAW_LIMIT = 64 * 1024 * 1024
const FILE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
}
const FILE_MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }
let activeFileRequests = 0
const fileRates = new Map()

// 总并发与每地址窗口限流同时覆盖 inspect、预览和流式下载。
function fileRequestSlot(req, res) {
  const now = Date.now()
  for (const [ip, entry] of fileRates) if (now - entry.at >= 60000) fileRates.delete(ip)
  const ip = req.socket.remoteAddress || 'local'
  const entry = fileRates.get(ip) || { at: now, count: 0 }
  if (activeFileRequests >= 4 || entry.count >= 60 || fileRates.size >= 1024 && !fileRates.has(ip)) {
    res.setHeader('Retry-After', '60')
    throw apiError(429, '交付文件请求过于频繁，请稍后重试')
  }
  entry.count++
  fileRates.set(ip, entry)
  activeFileRequests++
  let released = false
  const release = () => { if (!released) { released = true; activeFileRequests-- } }
  res.once('finish', release)
  res.once('close', release)
}

function deliverableRefs(messages) {
  const refs = new Map()
  for (const message of messages || []) {
    for (const b of [...(message.blocks || []), ...(Array.isArray(message.content) ? message.content : [])]) {
      const delivered = b.kind === 'deliverable' ||
        (b.kind === 'tool' && b.name === 'present_files') ||
        (b.type === 'tool_use' && b.name === 'present_files')
      const id = b.toolUseId || b.id
      if (delivered && typeof id === 'string') refs.set(id, { toolUseId: id, tool: id, status: b.status || null })
    }
  }
  return [...refs.values()]
}

function fileQuery(url) {
  const sid = url.searchParams.get('sid')
  const tool = url.searchParams.get('tool')
  const raw = url.searchParams.get('index') ?? url.searchParams.get('i') ?? '0'
  if (!sid || !tool || sid.length > 256 || tool.length > 256) throw apiError(400, '缺少或无效 sid / tool')
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw apiError(400, 'index 必须是非负整数')
  return { sid, tool, index: Number(raw) }
}

async function inspectDeliverables(sid, tool) {
  // 不从 HTTP 路径参数或 args.paths 读取：主进程的 delivered 边车/原始工具历史负责授权。
  const list = await deva.callApi('deva.deliverables.inspect', [sid, tool])
  if (!Array.isArray(list)) throw apiError(502, '交付文件信息格式异常')
  return list
}

async function openDelivered(item) {
  if (!item) throw apiError(404, '没有这个交付文件')
  if (item.size === null) throw apiError(410, '文件已不存在')
  if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw apiError(403, '交付路径无效')
  let handle
  try {
    // 拒绝交付后被改成符号链接的文件；文件句柄固定后所有读操作用同一个句柄。
    // Windows TEMP 可能是 ADMINI~1 这样的短路径，realpath 字符串不等并不等于链接。
    for (let p = path.resolve(item.path); ; p = path.dirname(p)) {
      if ((await fsp.lstat(p)).isSymbolicLink()) throw apiError(403, '交付文件已重定向，拒绝读取')
      if (path.dirname(p) === p) break
    }
    const real = await fsp.realpath(item.path)
    handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (!stat.isFile()) throw apiError(403, '交付目标不是普通文件')
    return { handle, size: stat.size }
  } catch (e) {
    await handle?.close()
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw apiError(410, '文件已不存在')
    throw e
  }
}

async function readDeliverable(item) {
  const { handle, size } = await openDelivered(item)
  try {
    const ext = path.extname(item.path).toLowerCase()
    const base = { name: item.name, path: item.path, size, ext: ext.slice(1) }
    if (INLINE_IMAGE.has(ext)) {
      if (size > IMAGE_LIMIT) throw apiError(413, '图片预览上限 8MB，请下载查看')
      const buf = Buffer.alloc(Math.min(size, IMAGE_LIMIT))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      return { ...base, kind: 'image', dataUri: `data:${FILE_MIME[ext]};base64,${buf.subarray(0, bytesRead).toString('base64')}` }
    }
    if (ext === '.pdf') return { ...base, kind: 'pdf' }
    if (INLINE_TEXT.has(ext)) {
      const buf = Buffer.alloc(Math.min(size, TEXT_LIMIT))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      return { ...base, kind: 'text', text: buf.subarray(0, bytesRead).toString('utf8'), truncated: size > TEXT_LIMIT }
    }
    return { ...base, kind: 'other' }
  } finally { await handle.close() }
}

async function streamDeliverable(req, res, url, item) {
  const { handle, size } = await openDelivered(item)
  let handedOff = false
  try {
    if (size > RAW_LIMIT) throw apiError(413, '下载或 PDF 预览上限 64MB')
    const ext = path.extname(item.path).toLowerCase()
    const inline = url.searchParams.get('download') !== '1' && (ext === '.pdf' || INLINE_IMAGE.has(ext))
    const headers = {
      ...FILE_HEADERS, 'Content-Type': inline ? FILE_MIME[ext] : 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="download${/^[.a-z0-9]+$/.test(ext) ? ext : ''}"; filename*=UTF-8''${encodeURIComponent(item.name || 'download').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`
    }
    let start = 0, end = size - 1, code = 200
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      if (!m || (!m[1] && !m[2])) throw apiError(416, '不支持这个 Range')
      start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.setHeader('Content-Range', `bytes */${size}`)
        throw apiError(416, 'Range 超出文件范围')
      }
      code = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    headers['Content-Length'] = Math.max(0, end - start + 1)
    res.writeHead(code, headers)
    if (!size) return res.end()
    const stream = handle.createReadStream({ start, end, autoClose: true })
    handedOff = true
    res.once('close', () => stream.destroy())
    stream.once('error', e => res.destroy(e))
    stream.pipe(res)
  } finally { if (!handedOff) await handle.close() }
}

// ───────── 目录浏览（挂载工作区用） ─────────
function listDrives() {
  const out = []
  for (let c = 65; c <= 90; c++) {
    const p = `${String.fromCharCode(c)}:\\`
    try {
      if (fs.existsSync(p)) out.push({ name: p, path: p })
    } catch {}
  }
  return out
}

async function listDirs(target) {
  if (!target) return { path: '', parent: null, dirs: listDrives() }
  const abs = path.resolve(target)
  const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => [])
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('$'))
    .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const parent = path.dirname(abs)
  const isRoot = parent === abs
  return { path: abs, parent: isRoot ? '' : parent, dirs }
}

// ───────── HTTP ─────────

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 32 * 1024 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function handleApi(req, res, url, sub) {
  const b = req.method === 'POST' ? await readBody(req) : {}

  switch (`${req.method} ${sub}`) {
    case 'GET /api/state': {
      await syncSessions().catch(() => {})
      return send(res, 200, {
        deva: deva.alive ? 'running' : 'stopped',
        page: deva.pageReady,
        error: stateError || deva.lastError || '',
        stateKnown: !stateError && stateSyncedAt !== null,
        stateSyncedAt,
        runningSessions: [...running],
        sessionStates: Object.fromEntries(sessionStates)
      })
    }
    case 'GET /api/models':
      return send(res, 200, await modelsPayload())

    case 'GET /api/personas': {
      const list = await deva.eval('window.deva.personas.list()')
      return send(
        res,
        200,
        (list || [])
          .filter((p) => p.enabled !== false)
          .map((p) => ({
            id: p.id,
            name: p.name,
            desc: p.description || '',
            model: p.model || '',
            // 有自定义图（用户上传）就直接给图；否则让前端来取 Humation 头像
            image: p.avatarImage || ''
          }))
      )
    }

    case 'GET /api/avatar': {
      // 同时接受 persona id 和角色名：前端未必知道哪个
      const name = url.searchParams.get('name') || url.searchParams.get('id') || ''
      if (!name) return send(res, 400, { error: '缺少 name' })
      const r = await personaAvatar(name)
      if (!r) return send(res, 404, { error: '取不到这个角色的头像' })
      // 自定义图是 data URI 字符串，直接回；生成头像是结构化对象，交给前端画底板
      if (typeof r === 'string') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end(r)
      }
      return send(res, 200, r)
    }

    case 'POST /api/upload': {
      // { files: [{ name, data }] } 或 { images: [dataURL] } → 落盘的绝对路径
      const items = Array.isArray(b.files)
        ? b.files
        : (Array.isArray(b.images) ? b.images : []).map((d, i) => ({ name: `image-${i + 1}`, data: d }))
      if (!items.length) return send(res, 400, { error: '没有附件' })
      const saved = []
      for (const it of items) saved.push(saveDataUrl(it.data ?? it, it.name))
      log(`[upload] 收到 ${saved.length} 个附件：${saved.map((s) => s.name).join('、')}`)
      return send(res, 200, { ok: true, paths: saved.map((s) => s.path), files: saved })
    }

    case 'GET /api/sessions': {
      const list = await syncSessions()
      return send(
        res,
        200,
        (list || []).map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
          personaId: s.personaId || null,
          model: s.model || null,
          // 会话级思考强度：不返回它，前端每次都会回退到全局默认（桌面配置里是 xhigh），
          // 表现为「选了高、刷新又变回极高」
          effort: s.effort || null,
          focusRoot: s.focusRoot ?? null,
          archived: !!s.archived,
          ...sessionState(s.id)
        }))
      )
    }

    case 'POST /api/rename': {
      // 重命名对话；title 传空 = 恢复默认标题（由 Deva 按首条用户消息派生）
      if (!b.sessionId) return send(res, 400, { error: '缺少 sessionId' })
      const out = await deva.callApi('deva.chat.renameSession', [
        { sessionId: b.sessionId, title: typeof b.title === 'string' ? b.title : '' }
      ])
      return send(res, 200, { ok: true, title: out?.title || '' })
    }

    case 'POST /api/archive': {
      if (typeof b.sessionId !== 'string' || !b.sessionId) throw apiError(400, '缺少 sessionId')
      if (b.archived !== undefined && typeof b.archived !== 'boolean') throw apiError(400, 'archived 必须是布尔值')
      const archived = b.archived !== false
      const out = await deva.callApi('deva.chat.setArchived', [{ sessionId: b.sessionId, archived }])
      if (out?.ok !== true) throw apiError(404, '会话不存在或归档失败')
      broadcast({ k: 'sessions', sid: b.sessionId, archived })
      return send(res, 200, { ok: true, archived })
    }

    case 'POST /api/delete': {
      if (typeof b.sessionId !== 'string' || !b.sessionId) throw apiError(400, '缺少 sessionId')
      const list = await syncSessions()
      const meta = list.find(s => s.id === b.sessionId)
      if (!meta) throw apiError(404, '会话不存在')
      const snapshot = await attachSession(b.sessionId)
      const backgroundRunning = (snapshot.messages || []).some(m =>
        (m.blocks || []).some(block => block.kind === 'tool' && block.status === 'running'))
      if (running.has(b.sessionId) || backgroundRunning) throw apiError(409, '会话正在运行，请先停止再删除')
      const out = await deva.callApi('deva.chat.deleteSession', [b.sessionId, meta.focusRoot ?? null])
      if (out?.ok !== true) throw apiError(502, '删除失败')
      running.delete(b.sessionId)
      inflight.delete(b.sessionId)
      sessionStates.delete(b.sessionId)
      stateVersions.set(b.sessionId, (stateVersions.get(b.sessionId) || 0) + 1)
      broadcast({ k: 'sessions', sid: b.sessionId, deleted: true })
      return send(res, 200, { ok: true })
    }

    case 'GET /api/deliverables':
    case 'GET /api/deliverable-raw':
    case 'GET /api/deliverable-content': {
      const { sid, tool, index } = fileQuery(url)
      fileRequestSlot(req, res)
      const list = await inspectDeliverables(sid, tool)
      if (sub === '/api/deliverables') {
        return send(res, 200, list.map((item, i) => ({ ...item, index: i, toolUseId: tool })), FILE_HEADERS)
      }
      const item = list[index]
      if (sub === '/api/deliverable-raw') return streamDeliverable(req, res, url, item)
      return send(res, 200, await readDeliverable(item), FILE_HEADERS)
    }

    case 'GET /api/message-image': {
      // 历史用户消息里的图片：{name, kind:'image', ref}。ref 是 Deva 自己记录的位置键，
      // 由它去取原图（和桌面端点开缩略图同一条路），网关不猜路径。
      const sid = url.searchParams.get('sid')
      const ref = url.searchParams.get('ref')
      const full = url.searchParams.get('full') === '1'
      if (!sid || !ref) return send(res, 400, { error: '缺少 sid / ref' })
      const data = await deva.callApi('deva.chat.attachmentImage', [sid, ref, full])
      if (!data || typeof data !== 'string') return send(res, 404, { error: '图片取不到' })
      // 主进程回的是 data URI；直接当图片发回去，让 <img> 原生渲染
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(data)
      if (!m) return send(res, 502, { error: '图片内容异常' })
      const buf = Buffer.from(m[2], 'base64')
      res.writeHead(200, {
        'Content-Type': m[1],
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      })
      return res.end(buf)
    }

    case 'POST /api/withdraw-inserts': {
      // 撤回本轮还没送达的插入，原文还回输入框（照桌面端 chat:withdraw-inserts）
      const sid = b.sessionId
      if (!sid) return send(res, 400, { error: '缺少 sessionId' })
      const out = await deva.callApi('deva.chat.withdrawInserts', [sid])
      pendingInserts.delete(sid)
      broadcast({ k: 'ev', sid, e: { type: 'inserts', pending: [] } })
      return send(res, 200, { ok: true, text: out?.text || '' })
    }

    case 'POST /api/asset-stage': {
      // 网页（浏览器）里没有 window.deva，必须由网关替它去 Deva 渲染层调 pasteAttachment：
      // 主进程落盘并完成授权，附件才不会被当成「未授权文件」丢掉。
      const files = Array.isArray(b.files) ? b.files : []
      if (!files.length) return send(res, 400, { error: '没有附件' })
      const staged = []
      for (const f of files) {
        const picked = await deva.eval(
          `(async () => {
            const m = /^data:([^;,]*);base64,(.*)$/s.exec(${JSON.stringify(f.data || '')});
            if (!m) return { supported: false, reason: '数据格式不对' };
            const bin = atob(m[2]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const out = await window.deva.fs.pasteAttachment({
              name: ${JSON.stringify(f.name || 'file')},
              mime: m[1] || ${JSON.stringify(f.mime || '')},
              size: bytes.length,
              data: bytes
            });
            return out;
          })()`
        )
        if (!picked || !picked.supported) {
          return send(res, 400, { error: `${f.name || '附件'}：${picked?.reason || '这个类型不支持'}` })
        }
        staged.push(picked.path)
      }
      log(`[asset] 授权 ${staged.length} 个附件`)
      return send(res, 200, { ok: true, paths: staged })
    }

    case 'GET /api/session': {
      const sid = url.searchParams.get('id')
      if (!sid) return send(res, 400, { error: '缺少 id' })
      const r = await attachSession(sid)
      return send(res, 200, {
        messages: r.messages || [],
        inflight: inflight.get(sid) || [],
        pendingInserts: pendingInserts.get(sid) || [],
        ...sessionState(sid),
        deliverables: deliverableRefs(r.messages)
      })
    }

    case 'POST /api/send': {
      const { sessionId, text, attachments } = b
      const hasText = typeof text === 'string' && text.trim().length > 0
      const hasFiles = Array.isArray(attachments) && attachments.length > 0
      if (!sessionId || (!hasText && !hasFiles)) {
        return send(res, 400, { error: '缺少 sessionId 或正文' })
      }
      const r = await deva.callApi('deva.chat.attachSession', [sessionId]).catch(() => null)
      // 运行中的会话不能 send（主进程会抛「这个对话正在进行中」）：提前给个能看懂的 409，
      // 并指明该用插入或先停止，省得手机端只看到一句笼统的失败。
      if (r?.turnId) {
        throw apiError(409, '这个对话正在进行中：要补充就插入到当前轮，要重来先停止这一轮')
      }
      const meta = (await deva.eval('window.deva.chat.listSessions(null)')).find((s) => s.id === sessionId)
      const ref = b.modelRef || meta?.model || null
      const resolved = await resolveModel(ref)
      const payload = {
        sessionId,
        text: text || '',
        model: resolved.model,
        workspaceRoot: meta?.focusRoot ?? null,
        // 附件走绝对路径：主进程自己读文件，和桌面端拖图进来是同一条通路
        ...(hasFiles ? { attachments } : {}),
        personaId: meta?.personaId || undefined,
        focusRoot: meta?.focusRoot ?? null,
        modelRef: resolved.modelRef,
        effort: b.effort || meta?.effort || resolved.effort
      }
      const out = await deva.callApi('deva.chat.send', [payload])
      return send(res, 200, { ok: true, turnId: out?.turnId || null, attached: !!r })
    }

    case 'POST /api/abort': {
      // 停的是「某一会话当前正在跑的那一轮」。turnId 由服务端向主进程现取（attachSession），
      // 不拿页面上的值当命令——页面可能落后一两秒；用真实当前 turnId 才不会停错东西。
      // 会话必须给：没有 sessionId 就不知道要核对哪个会话，宁可不做也不乱停。
      if (typeof b.turnId !== 'string' || !b.turnId) throw apiError(400, '缺少 turnId')
      if (b.turnId === 'pending') throw apiError(409, '这一轮还没拿到真实 turnId，稍等再停止')
      const sid = typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : ''
      if (!sid) throw apiError(400, '缺少 sessionId：无法确认要停止哪个会话的这一轮')
      const snapshot = await attachSession(sid)
      const current = snapshot?.turnId || null
      if (!current) {
        // 已经结束了：不调用 abort（那会是一次空操作），直接告诉页面「本来就停了」
        return send(res, 200, { ok: true, alreadyEnded: true, sessionId: sid, turnId: b.turnId })
      }
      const out = await deva.callApi('deva.chat.abort', [current])
      if (out && out.ok === false) throw apiError(502, '主进程拒绝停止这一轮')
      return send(res, 200, {
        ok: true, sessionId: sid, turnId: current,
        // 页面上那一轮已经过期（比如别处又发了一轮）：照实说，让用户知道停的是当前这一轮
        ...(b.turnId !== current ? { stale: true, requestedTurnId: b.turnId } : {})
      })
    }

    case 'POST /api/insert': {
      // 回合进行中插一条话（chat:insert）。主进程语义（app.asar 的 insertMessage / takeInserts）：
      //   · 只接受「正在跑的那一轮」，push 进该会话的待送达队列，并回发 inserts 事件；
      //   · 内容会在下一次工具步骤随工具结果交给模型；整轮没有工具步骤时，在本轮收尾后
      //     以同一会话接着跑（不丢），被停止 / 出错则用 inserts_returned 把原文还给页面；
      //   · 空闲回 reason:'idle'，这一轮还没进 insertableTurns 回 reason:'busy'。
      // 网关只做核对与转述：turnId 一律取主进程当前的，附件不支持（插入没有附件通路）。
      const sid = typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : ''
      if (!sid) throw apiError(400, '缺少 sessionId')
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text) throw apiError(400, '插入需要正文')
      if (Array.isArray(b.attachments) && b.attachments.length) {
        throw apiError(400, '插入不支持附件：请等这一轮结束后再随消息发送')
      }
      const snapshot = await attachSession(sid)
      const turnId = snapshot?.turnId || null
      if (!turnId) {
        return send(res, 200, { ok: false, reason: 'idle', error: '这一轮已经结束，直接发送就会开新一轮' })
      }
      const meta = (await deva.eval('window.deva.chat.listSessions(null)')).find((s) => s.id === sid)
      const ref = b.modelRef || meta?.model || null
      const resolved = await resolveModel(ref)
      const out = await deva.callApi('deva.chat.insert', [{ sessionId: sid, text, model: resolved.model }])
      const stale = typeof b.turnId === 'string' && b.turnId && b.turnId !== turnId
      if (out?.ok === true) {
        return send(res, 200, {
          ok: true, sessionId: sid, turnId,
          ...(stale ? { stale: true, requestedTurnId: b.turnId } : {})
        })
      }
      const reason = out?.reason || 'unknown'
      const error =
        reason === 'idle'
          ? '这一轮刚刚结束，直接发送就会开新一轮'
          : reason === 'busy'
            ? '这一轮还在准备，暂时不能插入（等它开始输出再试）'
            : reason === 'empty'
              ? '插入需要正文'
              : `插入被拒绝（${reason}）`
      return send(res, 200, { ok: false, reason, error, turnId })
    }

    case 'POST /api/answer': {
      if (!b.key) return send(res, 400, { error: '缺少 key' })
      const ok = await deva.callApi('deva.chat.respondAsk', [{ key: b.key, answers: b.answers ?? null }])
      return send(res, 200, { ok: ok !== false })
    }

    case 'POST /api/plan': {
      if (!b.key || !b.decision) return send(res, 400, { error: '缺少 key / decision' })
      const ok = await deva.callApi('deva.chat.respondPlan', [
        { key: b.key, decision: b.decision, feedback: b.feedback || undefined }
      ])
      return send(res, 200, { ok: ok !== false })
    }

    case 'POST /api/mount-response': {
      if (!b.key) return send(res, 400, { error: '缺少 key' })
      const ok = await deva.callApi('deva.chat.respondMount', [{ key: b.key, path: b.path || null }])
      return send(res, 200, { ok: ok !== false })
    }

    case 'POST /api/new-session': {
      const sessionId = newSessionId()
      const personaId = b.personaId || undefined
      const focusRoot = b.focusRoot || null
      const modelRef = b.modelRef || undefined
      await deva.callApi('deva.chat.createSession', [{ sessionId, workspaceRoot: focusRoot, personaId, focusRoot, modelRef }])
      return send(res, 200, { ok: true, sessionId })
    }

    case 'POST /api/set-model': {
      if (!b.sessionId || !b.modelRef) return send(res, 400, { error: '缺少 sessionId / modelRef' })
      await deva.callApi('deva.chat.setModel', [{ sessionId: b.sessionId, modelRef: b.modelRef }])
      return send(res, 200, { ok: true })
    }

    case 'POST /api/set-effort': {
      if (!b.sessionId || !b.effort) return send(res, 400, { error: '缺少 sessionId / effort' })
      await deva.callApi('deva.chat.setEffort', [{ sessionId: b.sessionId, effort: b.effort }])
      return send(res, 200, { ok: true })
    }

    case 'POST /api/set-focus': {
      if (!b.sessionId) return send(res, 400, { error: '缺少 sessionId' })
      await deva.callApi('deva.chat.setFocus', [{ sessionId: b.sessionId, focusRoot: b.focusRoot || null }])
      return send(res, 200, { ok: true })
    }

    case 'GET /api/dirs': {
      const target = url.searchParams.get('path') || ''
      return send(res, 200, await listDirs(target))
    }

    default:
      return send(res, 404, { error: '没有这个接口' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // 首页：没带正确密钥就只回一个极简登录页（口令就是密钥），不暴露任何内容
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!authorized(req, url)) {
      return send(
        res,
        401,
        `<!doctype html><meta charset="utf-8"><title>Deva 网关</title>
<body style="font:15px/1.6 system-ui;padding:32px;max-width:420px;margin:auto">
<h2>Deva 网关</h2>
<p>需要访问密钥。地址形如 <code>/?key=你的密钥</code>。</p>
<form method="get"><input name="key" placeholder="粘贴密钥" style="width:100%;padding:10px;font-size:16px" autofocus></form>
<p style="color:#888">密钥在电脑上：网关窗口里能看到，或 <code>~/.deva/remote-key.txt</code>。</p></body>`
      )
    }
    // 带上有效密钥访问首页时种一个 cookie，之后页面内的接口调用就不必每次附 key
    const body = await fsp.readFile(PAGE, 'utf8')
    return send(res, 200, body, { 'Set-Cookie': `deva_gw=${key}; Path=/; Max-Age=2592000; SameSite=Lax` })
  }

  if (!authorized(req, url)) return send(res, 401, { error: '密钥无效' })

  // SSE：网页只开一条长连接，所有上行/下行都走这里
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    void syncSessions().then(() => {
      if (!res.destroyed) sseSend(res, { k: 'sessions', snapshot: true, stateSyncedAt, sessionStates: Object.fromEntries(sessionStates), runningSessions: [...running] })
    }).catch(e => {
      if (!res.destroyed) sseSend(res, { k: 'state', stateKnown: false, error: e.message })
    })
    // 心跳：手机网络会掐掉长时间静默的连接
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {}
    }, 20000)
    req.on('close', () => {
      clearInterval(beat)
      sseClients.delete(res)
    })
    return
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url, url.pathname)
    } catch (e) {
      log(`[api] ${url.pathname} 失败：${e.message}`)
      if (res.headersSent) return res.destroy(e)
      return send(res, e.status || 500, { error: e.message || String(e) })
    }
  }

  return send(res, 404, { error: '没找到' })
})

// ───────── 启动 ─────────

/**
 * Deva 是否正在运行。
 *
 * 这是硬前提：网关只能「附加」到已经在跑的 Deva（调试端口只在其启动时开放）。
 * 故在拉起 HTTP 服务之前就要确认，没有 Deva 就直接退出——不留下一个空转的网关进程。
 */
function devaIsRunning() {
  const { execFileSync } = require('node:child_process')
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Deva.exe', '/NH'], {
      windowsHide: true,
      encoding: 'utf8'
    })
    return /Deva\.exe/i.test(out)
  } catch {
    return false
  }
}

async function main() {
  key = loadKey()

  if (!devaIsRunning()) {
    console.error('\n[deva] 没有检测到正在运行的 Deva。\n')
    console.error('网关只能接管「已经启动」的 Deva——调试接口是 Deva 启动时开放的，事后无法补上。\n')
    console.error('请先：')
    console.error('  1. 用程序目录的「启动 Deva.bat」打开 Deva（它带上了必要参数）')
    console.error('  2. 等 Deva 窗口出来，再启动网关\n')
    process.exit(2)
  }

  deva = new DevaControl({ log })
  deva.on('event', onDevaEvent)
  deva.on('state', (s) => {
    if (s.deva === 'stopped') stateError = 'Deva 连接断开，状态待同步'
    broadcast({ k: 'state', ...s, stateKnown: false })
    if (s.deva === 'running' && s.page && deva.alive) void syncSessions().catch(() => {})
  })

  // 先确认真的连得上，再对外开服务：避免网页能打开、却什么也做不了
  try {
    await deva.attach()
    log('[deva] 已接到正在运行的 Deva')
  } catch (e) {
    console.error(`\n[deva] 接不上正在运行的 Deva：${String(e.message || e).split('\n')[0]}\n`)
    console.error('多半是 Deva 启动时没带 --remote-debugging-port=0。')
    console.error('请关掉 Deva，改用程序目录的「启动 Deva.bat」重新打开。\n')
    process.exit(3)
  }
  deva.startWatch()
  await syncSessions().catch(e => log(e.message))
  const stateTimer = setInterval(() => {
    if (deva.alive) void syncSessions().catch(() => {})
  }, 5000)
  stateTimer.unref?.()

  server.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address)
    log(`网关已启动：http://127.0.0.1:${PORT}/?key=${key}`)
    for (const ip of ips) log(`  局域网： http://${ip}:${PORT}/?key=${key}`)
  })

  startParentWatchdog()
}

/**
 * 父进程看门狗。
 *
 * Windows 上父进程退出不会带走子进程：启动器被强杀 / 崩溃后，这个 node 会变成孤儿继续跑，
 * 连带它拉起的 Deva 也留着——用户看到的就是「关了程序，Deva 还在，而且再启动会撞端口」。
 * 故由启动器把自身 pid 传进来（DEVA_GATEWAY_PARENT），这里定期确认它还活着，不在就自己收摊。
 */
function startParentWatchdog() {
  const raw = process.env.DEVA_GATEWAY_PARENT
  if (!raw) return
  const parentPid = Number(raw)
  if (!Number.isInteger(parentPid) || parentPid <= 0) return

  const alive = () => {
    try {
      process.kill(parentPid, 0)
      return true
    } catch (e) {
      // EPERM = 进程在但没权限（不可能发生在同一用户）；其余一律当作已退出
      return e.code === 'EPERM'
    }
  }

  const timer = setInterval(async () => {
    if (alive()) return
    clearInterval(timer)
    log('[gateway] 启动器已退出，网关随之关闭')
    try {
      await deva.stop()
    } catch {}
    process.exit(0)
  }, 2000)
  timer.unref?.()
}

if (require.main === module) {
  process.on('SIGINT', () => {
    log('收到退出信号')
    void deva?.stop().finally(() => process.exit(0))
  })
  process.on('uncaughtException', (e) => log(`[fatal] ${e.stack || e.message}`))
  process.on('unhandledRejection', (e) => log(`[fatal] ${e?.stack || e}`))
  main().catch((e) => {
    log(`启动失败：${e.message}`)
    process.exit(1)
  })
}

// 后端测试注入假桥；require 本文件不会连接 Deva 或监听端口。
module.exports = {
  server, onDevaEvent, syncSessions, deliverableRefs,
  configureForTest(control, testKey = 'test-key') {
    deva = control; key = testKey
    running.clear(); inflight.clear(); sessionStates.clear(); stateVersions.clear(); fileRates.clear(); pendingInserts.clear()
    stateSyncedAt = null; stateError = ''; syncPromise = null
  }
}
