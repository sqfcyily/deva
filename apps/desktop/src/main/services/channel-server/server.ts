import { randomBytes, randomInt } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { hostname } from 'node:os'
import { lanHosts } from './pairing'
import { basename, extname, isAbsolute } from 'node:path'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app } from 'electron'
import { getChatRuntime, parseAskQuestions, renameSessionTitle, deleteSessionFully } from '../chat'
import { acceptExternalAttachment } from '../attachments'
import { isTaskNotification } from '../compaction'
import { ensureSession, getSession, listSessions, save as saveProject, setSessionArchived } from '../chat-store'
import type { StoredSession } from '../chat-store'
import { activeModelRef, listEnabledModels, resolveDefaultEffort, resolveModelRefForSend } from '../model-resolve'
import { isAutoNudge, isCompactionSummary } from '../model-view'
import { getPersona, listPersonas } from '../personas'
import { listTasks, previewSchedule } from '../tasks'
import { getConfig } from '../config'
import { deleteSecretsByPrefix, setSecret } from '../secrets'
import type { Message } from '../../providers/types'
import { isEffortLevel } from '../../../shared/effort'
import type { ChannelState } from '../remote/types'
import { deviceIdForToken, invalidateTokenCache } from './auth'
import { noteDeviceSeen, noteDeviceStream, dropDevice } from './activity'
import { addDevice, getGeneralServerConfig, removeDevice, sanitizeDeviceName, type GeneralServerConfig } from './config'
import { consumePairCodeIfMatch, notePairFailure, pairAttemptAllowed, restorePairCode } from './pairing'
import { WEB_CONSOLE_HTML } from './web-console'
import { canAdmit, closeDeviceConnections, openSessionStream, openTurnStream, turnRegistered } from './sse'

/**
 * 入站 HTTP 服务器（node:http，REST + SSE 同一监听，设计 §3.1/3.3）。
 * 只做转发：列会话调 chat-store 的既有函数、busy 调 chatRuntime——不复制业务规则，
 * 不新增任何会话语义。异常只回 500 / 上报状态，不抛给 chatRuntime（设计 §3.5）。
 */

export interface ServerHooks {
  onState(state: ChannelState, error?: string): void
  /** 新设备配对成功（对齐回复提醒的通知模式；index.ts 实现桌面系统通知）。 */
  onDevicePaired?(name: string): void
}

let server: Server | null = null
/** startServer 注入的钩子（route 是模块级函数，配对成功通知经此转发给 index.ts）。 */
let hooksRef: ServerHooks | null = null

const errText = (e: unknown): string => (e as Error)?.message ?? String(e)

// 通道请求日志（DEVA_CHANNEL_LOG=1 时启用）：wedge 排查用，落 stdout 供 electron 日志对账
const CH_LOG = process.env.DEVA_CHANNEL_LOG === '1'
const chLog = (line: string) => { if (CH_LOG) console.log('[ch]', new Date().toISOString().slice(11, 23), line) }

function json(res: ServerResponse, status: number, body: unknown): void {
  chLog(`${res.req?.method} ${res.req?.url} → ${status}`)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 读 JSON 请求体（超限 / 非法 JSON 返回 null）。 */
function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as T) : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** 读原始字节请求体（附件上传）。超限返回 null（调用方回 413），不落盘。 */
function readRaw(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

/** 协议版本与能力集：/api/info 与 pair 响应携带，设备端据此协商（设计 §3.3 版本化）。 */
const PROTOCOL_VERSION = 1
const PROTOCOL_CAPABILITIES = [
  'turn-stream',
  'session-stream',
  'answers',
  'deliveries',
  'files',
  'set-host',
  'set-enabled',
  'rename-device',
  'self-revoke',
  'session-archive',
  'attachments',
  'personas',
  'session-delete',
  'session-rename',
  'tasks',
  'models'
] as const

/** 附件上传的传输上限（读字节缓冲的硬顶；类型/体积的细口径在 attachments.inspect 里，超限降级为位置注入）。 */
const ATTACHMENT_UPLOAD_MAX = 24 * 1024 * 1024

function genDeviceId(): string {
  return `dev_${Date.now().toString(36)}_${randomInt(0, 36 ** 4).toString(36)}`
}

/** 路径段解码：畸形百分号编码返回 null（调用方回 404/400，而非落进 500）。 */
function decodeSegment(v: string): string | null {
  try {
    return decodeURIComponent(v)
  } catch {
    return null
  }
}

/** 回填给手机端的展示条目（不含工具输出/思考等模型上下文细节，见 projectMessages）。 */
interface BackfillItem {
  i: number
  role: 'user' | 'assistant'
  text?: string
  /** 工具调用名列表（assistant 消息；手机端折叠成一行「正在…」）。 */
  tools?: string[]
  /** 图片 / 文档附件个数（正文之外的内容块）。 */
  attachments?: number
  /**
   * 未决交互卡（ask_user / exit_plan）：仅当边车（asks / plans）无该 toolUseId 终态时才回填——
   * 已答过的卡手机端按普通工具行折叠。挂载请求卡不入历史（权限闸门内存产物，见设计 §3.3）。
   */
  card?: { kind: 'ask'; key: string; questions: ReturnType<typeof parseAskQuestions> } | {
    kind: 'plan'
    key: string
    plan: string
  }
  /**
   * 交付文件（present_files，设计 §5-5）：路径来自会话边车 delivered（与桌面交付卡同源，
   * 绝不接受请求指定任意路径）。有此字段时本条目的 tools 不再含 present_files——手机端整行画成交付卡。
   */
  files?: DeliverableFileJson[]
}

/** 交付文件条目（回填与 /deliveries 同形）。size=null 表示文件已被移走或删除。 */
interface DeliverableFileJson {
  path: string
  name: string
  size: number | null
  image: boolean
}

/** 手机端能内联预览的图片扩展名（与桌面 deliverables 的图片集合对齐；svg 手机端不预览）。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic'])

/**
 * present_files 一次交付的文件清单（绝对路径、已解析）：优先会话边车 delivered，
 * 缺失时回落历史里该调用的绝对路径参数（早期版本把解析后的路径直接写进了参数）。
 * 与 deliverables.ts 的 deliveredPaths 同源同口径，不在通道里改写业务规则。
 */
function deliveredPaths(session: StoredSession, toolUseId: string): string[] {
  const recorded = session.delivered?.[toolUseId]
  if (recorded?.length) return recorded
  for (const m of session.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const p of m.content) {
      if (p.type !== 'tool_use' || p.id !== toolUseId) continue
      if (p.name !== 'present_files') return []
      const paths = (p.input as { paths?: unknown } | null)?.paths
      return Array.isArray(paths)
        ? paths.filter((x): x is string => typeof x === 'string' && isAbsolute(x))
        : []
    }
  }
  return []
}

async function deliveredFiles(session: StoredSession, toolUseId: string): Promise<DeliverableFileJson[]> {
  const paths = deliveredPaths(session, toolUseId)
  return Promise.all(
    paths.map(async (p) => {
      const st = await fs.stat(p).catch(() => null)
      return {
        path: p,
        name: basename(p),
        size: st?.isFile() ? st.size : null,
        image: IMAGE_EXTS.has(extname(p).toLowerCase())
      }
    })
  )
}

/**
 * 引擎注入的标记消息（压缩摘要 ⟦deva:compaction⟧ / 自愈引导 ⟦deva:auto⟧ / 后台任务通知 ⟦deva:notify⟧）：
 * 桌面端主进程重建时翻成压缩提示/系统行，从不上屏原文；手机端投影同口径——不当人话，跳过。
 * 判定与桌面同源（model-view.ts / compaction.ts），不在通道里复制前缀规则（压缩「只插摘要不删消息」
 * 后这类消息只增不减，投影不过滤就会把带标记的原文当用户气泡回给手机）。
 */
function isEngineMarked(m: Message): boolean {
  return isCompactionSummary(m) || isAutoNudge(m) || isTaskNotification(m)
}

/**
 * 把主进程的 Message[]（模型上下文真源）投影成手机端可显示的线性列表：
 * 正文取 text 块；assistant 的 tool_use 折叠成工具名；user 消息里的 tool_result（provider 约定）
 * 不是人话，跳过；引擎标记消息（压缩摘要/自愈引导/任务通知，见 isEngineMarked）同样跳过；
 * 图片/文档只报个数（v1 不回填正文附件）。i 为投影后序号，供分页定位。
 * 未决交互卡判定只读边车终态（asks/plans），不在通道里复制「循环暂停」语义。
 * 交付文件（present_files）读边车 delivered：有交付时该调用整行升格为 files 卡。
 */
async function projectMessages(messages: Message[], session: StoredSession): Promise<BackfillItem[]> {
  const out: BackfillItem[] = []
  for (const m of messages) {
    if (isEngineMarked(m)) continue
    const texts: string[] = []
    const tools: string[] = []
    const files: DeliverableFileJson[] = []
    let attachments = 0
    let card: BackfillItem['card']
    if (typeof m.content === 'string') {
      if (m.content.trim()) texts.push(m.content)
    } else {
      for (const p of m.content) {
        if (p.type === 'text') {
          if (p.text.trim()) texts.push(p.text)
        } else if (p.type === 'tool_use') {
          if (p.name === 'present_files') {
            const f = await deliveredFiles(session, p.id)
            if (f.length) {
              files.push(...f)
              continue // 有交付：tools 不再带 present_files，手机端整行画交付卡
            }
          }
          tools.push(p.name)
          if (m.role === 'assistant' && !card) {
            // 一对话同时最多一张未决卡（交互工具会暂停循环）；终态在边车的不再当未决回填
            if (p.name === 'ask_user' && session.asks?.[p.id] === undefined)
              card = { kind: 'ask', key: p.id, questions: parseAskQuestions(p.input) }
            else if (p.name === 'exit_plan' && session.plans?.[p.id] === undefined) {
              const plan =
                typeof (p.input as { plan?: unknown })?.plan === 'string'
                  ? (p.input as { plan: string }).plan
                  : ''
              if (plan.trim()) card = { kind: 'plan', key: p.id, plan }
            }
          }
        } else if (p.type === 'image' || p.type === 'document') {
          attachments++
        }
        // tool_result：工具输出，桌面端折叠展示，v1 手机端不回填
      }
    }
    if (texts.length || tools.length || attachments || card || files.length)
      out.push({
        i: out.length,
        role: m.role,
        ...(texts.length ? { text: texts.join('\n\n') } : {}),
        ...(tools.length ? { tools } : {}),
        ...(attachments ? { attachments } : {}),
        ...(card ? { card } : {}),
        ...(files.length ? { files } : {})
      })
  }
  return out
}

/** 下载响应的 Content-Type（够用的最小集；未知一律 octet-stream）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.zip': 'application/zip'
}

/**
 * 会话列表的「最后一条消息」摘要（设备端列表展示用）：与 projectMessages 同口径取人话文本
 * （正文 text 块；跳过纯工具轮），从尾部倒查到第一条带正文的即返回，超长截断。
 */
function lastVisibleText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isEngineMarked(m)) continue // 标记消息不当「最后一条消息」：列表摘要不能露出 ⟦deva:*⟧ 原文
    const texts: string[] = []
    if (typeof m.content === 'string') {
      if (m.content.trim()) texts.push(m.content)
    } else {
      for (const p of m.content) if (p.type === 'text' && p.text.trim()) texts.push(p.text)
    }
    if (texts.length) {
      const joined = texts.join(' ').replace(/\s+/g, ' ').trim()
      return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined
    }
  }
  return null
}

/** personaId → 展示名（设备端角色徽标用；未绑定或已删除的角色回 null）。 */
function personaDisplayName(personaId: string | undefined): string | null {
  if (!personaId) return null
  return getPersona(personaId)?.name ?? null
}

/**
 * 会话是否有未决交互卡（设备端列表「待操作」角标）：与 projectMessages 同一口径——
 * 边车 asks/plans 里存在无终态（值为 undefined）的卡即未决。挂载请求卡不入历史，不在此列。
 */
function pendingCardOf(s: StoredSession): boolean {
  // asks/plans 边车只记录已决的卡(键缺失 = 未决):与 projectMessages 同口径,扫历史找无终态卡
  for (const m of s.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const p of m.content) {
      if (p.type !== 'tool_use') continue
      if (p.name === 'ask_user' && s.asks?.[p.id] === undefined) return true
      if (p.name === 'exit_plan' && s.plans?.[p.id] === undefined) {
        const plan = (p.input as { plan?: unknown } | null)?.plan
        if (typeof plan === 'string' && plan.trim()) return true
      }
    }
  }
  return false
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  const method = req.method ?? 'GET'
  chLog(`→ ${method} ${url.pathname}${url.search}`)
  req.on('close', () => { if (!res.writableEnded) chLog(`!! ${method} ${url.pathname} 客户端断开且响应未写完`) })

  try {
    // ── 配对：唯一免鉴权接口（设计 §3.2）──
    if (method === 'POST' && url.pathname === '/api/pair') {
      const ip = req.socket.remoteAddress ?? ''
      if (!pairAttemptAllowed(ip)) return json(res, 429, { error: '配对尝试太频繁，请一分钟后再试。' })
      const body = await readJson<{ code?: unknown; deviceName?: unknown }>(req)
      const code = typeof body?.code === 'string' ? body.code.trim() : ''
      if (!code) return json(res, 400, { error: '缺少配对码。' })
      // 一次性原子消费：校验+作废同步完成，并发同码有且只有一个成功（设计 §3.2）
      // 设备名先于配对码消费：净化 + 唯一性（NFKC 不分大小写，config.ts 共用助手），
      // 重名即 409 且不烧一次性码——设备端换名后同码可重试。
      const rawName = typeof body?.deviceName === 'string' ? body.deviceName : ''
      const name = sanitizeDeviceName(rawName) || '通用设备'
      if (
        getGeneralServerConfig().devices.some(
          (d) => d.name.normalize('NFKC').trim().toLowerCase() === name.normalize('NFKC').toLowerCase()
        )
      )
        return json(res, 409, { error: `设备名「${name}」已被占用，请换一个名字并重新生成配对码。` })
      // 一次性原子消费：校验+作废同步完成，并发同码有且只有一个成功（设计 §3.2）
      const consumed = consumePairCodeIfMatch(code)
      if (!consumed) {
        notePairFailure()
        return json(res, 400, { error: '配对码不正确或已过期，请在电脑端重新生成。' })
      }
      const deviceId = genDeviceId()
      const token = randomBytes(32).toString('base64url')
      const saved = await setSecret(`general:${deviceId}:token`, token)
      if (!saved.ok) {
        // 密钥存储失败不再白烧码（§6）：码在本请求手里、期间不可能被并发消费——
        // 原有效期恢复，设备同码重试即得；期间桌面若已出新码则丢弃（与旧行为一致）
        restorePairCode(code, consumed.expiresAt)
        return json(res, 500, { error: '系统密钥存储不可用，无法安全保存设备凭据。' })
      }
      addDevice({ id: deviceId, name, pairedAt: Date.now(), enabled: true })
      invalidateTokenCache()
      hooksRef?.onDevicePaired?.(name)
      return json(res, 200, {
        deviceId,
        token,
        protocol: PROTOCOL_VERSION,
        capabilities: PROTOCOL_CAPABILITIES
      })
    }

    // ── Web 控制台：页面壳免鉴权（数据端点仍一律 Bearer）──
    // 同端口托管是浏览器接入的前提：页面 Origin = <本机地址>:<通道端口>，与 Origin 双重校验
    // （主机名=本机地址 + 端口=监听端口）天然匹配；独立部署的静态托管会被 403 拦下。
    // 只放行固定两个路径，不做通用静态服务（白名单口径与附件一致）。
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      chLog(`${method} ${url.pathname} → 200 页面壳`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(WEB_CONSOLE_HTML)
      return
    }

    // ── 鉴权中间件：其余一律 Bearer token（设计 §3.2）──
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const deviceId = await deviceIdForToken(token)
    if (!deviceId) return json(res, 401, { error: '未配对或凭据无效。' })

    // 纵深防御（审查 A3）：带 Origin 头的请求必须来自本机/本机 LAN 地址，且端口必须就是本通道
    // 监听端口——本机其他端口上的服务（如开发服务器）可伪造同主机名的 Origin，只比主机名拦不住。
    // 手机 App 不发送 Origin 头，不受影响。
    const origin = req.headers.origin
    if (origin) {
      try {
        const o = new URL(origin)
        const allowedHosts = ['127.0.0.1', 'localhost', hostname(), ...lanHosts()]
        if (!allowedHosts.includes(o.hostname)) return json(res, 403, { error: '跨源请求被拒绝。' })
        // URL.port 缺省（http 默认 80 / https 默认 443）时补成显式端口再比
        const originPort = o.port || (o.protocol === 'https:' ? '443' : '80')
        if (originPort !== String(getGeneralServerConfig().port))
          return json(res, 403, { error: '跨源请求被拒绝。' })
      } catch {
        return json(res, 403, { error: 'Origin 不合法。' })
      }
    }
    noteDeviceSeen(deviceId)

    // 自助吊销（凭 Bearer token 自证身份）：丢失设备可远程自救，无需物理回到桌面。
    // 走 removeDevice 全套清理（配置 + 密钥 + 活动态 + SSE + token 缓存），此后该 token 一律 401。
    if (method === 'POST' && url.pathname === '/api/devices/self') {
      removeDevice(deviceId)
      await deleteSecretsByPrefix(`general:${deviceId}:`)
      dropDevice(deviceId)
      closeDeviceConnections(deviceId)
      invalidateTokenCache()
      return json(res, 200, { ok: true })
    }

    // POST /api/attachments?name=…：附件上传（设备端「只交字节、不交路径」，与桌面粘贴同一管道）——
    // 落盘到粘贴目录并登记白名单，返回的 path 只能用于 send 的 attachments[]（send 侧未登记路径
    // 一律「已忽略未授权文件」，任意路径读盘不可能）。类型/体积超限降级为「位置注入」（kind=file）。
    if (url.pathname === '/api/attachments' && method === 'POST') {
      const rawName = url.searchParams.get('name') ?? ''
      if (!rawName.trim()) return json(res, 400, { error: '缺少附件名（?name=…）。' })
      const body = await readRaw(req, ATTACHMENT_UPLOAD_MAX)
      if (body === null || body.length === 0)
        return json(res, body === null ? 413 : 400, {
          error: body === null ? `附件超过 ${ATTACHMENT_UPLOAD_MAX / 1024 / 1024}MB 上限。` : '附件内容为空。'
        })
      const ct = req.headers['content-type'] ?? 'application/octet-stream'
      const att = await acceptExternalAttachment({
        name: rawName,
        mime: Array.isArray(ct) ? ct[0] : ct,
        size: body.length,
        data: new Uint8Array(body)
      })
      if (!att.supported) return json(res, 400, { error: att.reason ?? '不支持的附件类型。' })
      return json(res, 200, { path: att.path, name: att.name, kind: att.kind })
    }

    // GET /api/personas：启用中的角色清单（设备端「新建对话选角色」用；id/name/description）。
    if (method === 'GET' && url.pathname === '/api/personas')
      return json(res, 200, {
        personas: listPersonas(false)
          .filter((p) => p.enabled)
          .map((p) => ({ id: p.id, name: p.name, description: p.description }))
      })

    // GET /api/tasks：定时任务只读清单（创建/编辑不在设备端 v1 面）。
    if (method === 'GET' && url.pathname === '/api/tasks')
      return json(res, 200, {
        tasks: listTasks().map((t) => ({
          id: t.id,
          title: t.title,
          status: typeof t.status === 'string' ? t.status : 'active',
          schedule:
            t.schedule?.kind === 'once'
              ? { kind: 'once', at: typeof t.schedule.at === 'string' ? t.schedule.at : '' }
              : { kind: 'recurring', cron: typeof t.schedule.cron === 'string' ? t.schedule.cron : '' },
          scheduleText: previewSchedule(t.schedule, getConfig().locale === 'en' ? 'en' : 'zh-CN'),
          ...(t.sessionId ? { sessionId: t.sessionId } : {})
        }))
      })

    // GET /api/models：可用模型清单 + 当前全局默认（send 的 modelRef 可从中取值；切换后本对话固定用它）。
    if (method === 'GET' && url.pathname === '/api/models')
      return json(res, 200, { models: listEnabledModels(), active: activeModelRef() })

    // GET /api/info：版本、主机名、平台、是否首次运行（首次运行 = 还没有任何顶层会话；
    // 成员会话（子智能体）与 /api/sessions 列表同口径过滤，避免「列表空但 firstRun=false」的矛盾）
    if (method === 'GET' && url.pathname === '/api/info')
      return json(res, 200, {
        version: app.getVersion(),
        hostname: hostname(),
        platform: process.platform,
        firstRun: listSessions().filter((s) => !s.parentId).length === 0,
        protocol: PROTOCOL_VERSION,
        capabilities: PROTOCOL_CAPABILITIES
      })

    // GET /api/sessions：会话列表（转发 chat-store；成员会话不进手机列表，与 hub /list 同口径）。
    // personaName 供角色徽标；focusRoot 供目录分组；pendingCard 供「待操作」角标（asks/plans 边车判定）；
    // lastMessage 供摘要。排序分类由设备端按这些字段自定（服务端恒按 updatedAt 倒序给全量）。
    if (method === 'GET' && url.pathname === '/api/sessions') {
      const rt = getChatRuntime()
      const all = listSessions()
        .filter((s) => !s.parentId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => {
          const pn = personaDisplayName(s.personaId)
          const stored = getSession(s.id)
          const last = lastVisibleText(stored?.messages ?? [])
          return {
            id: s.id,
            title: s.title,
            personaId: s.personaId,
            ...(pn ? { personaName: pn } : {}),
            ...(s.focusRoot ? { focusRoot: s.focusRoot } : {}),
            updatedAt: s.updatedAt,
            busy: rt?.isBusy(s.id) ?? false,
            archived: s.archived === true,
            ...(stored ? { pendingCard: pendingCardOf(stored) } : {}),
            ...(last ? { lastMessage: last } : {})
          }
        })
      // ?limit= 前缀截断(设备端「加载更早」分页的预留;默认全量)
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : undefined
      return json(res, 200, {
        sessions: limit === undefined ? all : all.slice(0, limit),
        total: all.length
      })
    }

    // POST /api/sessions：新建空会话（可选 personaId 选定角色——绑定沿桌面语义：首发落库后不再改）。
    // 标题仍由桌面 deriveTitle 首发时派生，改名走 /rename。转发 chat-store 既有函数
    // （ensureSession + saveProject，与桌面 chat:create-session 同源），不新增语义。
    if (method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJson<{ personaId?: unknown }>(req)
      const personaId = typeof body?.personaId === 'string' && body.personaId ? body.personaId : undefined
      if (personaId && !getPersona(personaId)) return json(res, 400, { error: '角色不存在或已删除。' })
      const id = `sess_${Date.now().toString(36)}_${randomInt(0, 36 ** 4).toString(36)}`
      ensureSession(id, personaId ? { personaId } : undefined)
      saveProject(id)
      return json(res, 200, { id })
    }

    // POST /api/sessions/:id/send：发消息（转调 chatRuntime.send，设计 §3.3——与桌面 IPC 同一入口）。
    // 模型解析照抄 hub 的链：请求显式 modelRef → 会话已存 → 角色偏好 → 全局默认（ChatSendRequest.model
    // 必填，入站通道必须自己解析出一个，不能把空值传进去）。
    const mSend = url.pathname.match(/^\/api\/sessions\/([^/]+)\/send$/)
    if (mSend && method === 'POST') {
      const rt = getChatRuntime()
      if (!rt) return json(res, 503, { error: 'Deva 还没准备好，请稍后再试。' })
      const sid = decodeSegment(mSend[1])
      if (sid === null) return json(res, 400, { error: '会话 id 编码不合法。' })
      const body = await readJson<{
        text?: unknown
        attachments?: unknown
        modelRef?: unknown
        effort?: unknown
      }>(req)
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (!text) return json(res, 400, { error: '缺少消息正文。' })
      const session = getSession(sid)
      if (!session) return json(res, 404, { error: '会话不存在。' })
      const persona = session.personaId ? getPersona(session.personaId) : null
      const explicitRef = typeof body?.modelRef === 'string' && body.modelRef ? body.modelRef : null
      // 模型解析链与 hub 同源（model-resolve.resolveModelRefForSend，审查 F3 消漂移）
      const model = resolveModelRefForSend({
        explicitRef: typeof body?.modelRef === 'string' && body.modelRef ? body.modelRef : null,
        sessionModel: session.model,
        personaModel: persona?.model ?? null
      })
      if (!model) return json(res, 400, { error: '还没有可用的模型，请先在电脑端的设置里配置并选定模型。' })
      // 会话忙 → 回退为「插入进行中的任务」(与 hub/IM 同口径,审查 A4):
      // 设备在回合进行中再发消息,桌面原语就是插入当前这一轮。
      // 两次 isBusy 检查(读 attachments 前后)防竞态,409 文案统一为 hub 同款。
      // 注意:rt.insert 无 attachments 入参——忙时插入只带正文(与桌面/IM 同语义)。
      if (rt.isBusy(sid)) {
        const r = rt.insert({ sessionId: sid, text, model })
        if (r.ok) return json(res, 200, { inserted: true })
        return json(res, 409, { error: '上一轮还在进行中。发送 /stop 可以停止它。' })
      }
      const attachments = Array.isArray(body?.attachments)
        ? body.attachments.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : undefined
      // 会话忙 → 回退为「插入进行中的任务」(与 hub/IM 同口径,审查 A4):
      // 用户在回合进行中再发消息,桌面原语就是插入当前这一轮。
      if (rt.isBusy(sid)) {
        const r = rt.insert({ sessionId: sid, text, model })
        if (r.ok) return json(res, 200, { inserted: true })
        return json(res, 409, { error: '上一轮还在进行中。发送 /stop 可以停止它。' })
      }
      try {
        const { turnId } = await rt.send({
          sessionId: sid,
          text,
          model,
          workspaceRoot: null,
          ...(attachments?.length ? { attachments } : {}),
          // 与桌面/hub 同：记下这一轮实际生效的模型与思考等级，此后本对话固定用它们
          modelRef: explicitRef ?? `${model.providerId}:${model.model}`,
          effort: isEffortLevel(body?.effort) ? body.effort : (session.effort ?? resolveDefaultEffort())
        })
        return json(res, 200, { turnId })
      } catch (e) {
        // 只有「会话忙」这类业务错回 409（手机端按冲突处理），其余（落盘失败等）按 500，不混淆语义
        const msg = errText(e)
        return json(res, msg.includes('正在进行中') ? 409 : 500, { error: msg })
      }
    }

    // POST /api/sessions/:id/answer：交互卡作答（转调 answerAsk / decidePlan / answerMount，设计 §3.3）。
    // 卡键 = 交互工具的 toolUseId；ok=false（卡已结束/不存在）回 409，让手机端把卡收成已决态。
    // mount 的 path 手机端给不出可信目录（系统对话框在桌面），与远程通道同口径只传 null（暂不挂载）。
    const mAns = url.pathname.match(/^\/api\/sessions\/([^/]+)\/answer$/)
    if (mAns && method === 'POST') {
      const rt = getChatRuntime()
      if (!rt) return json(res, 503, { error: 'Deva 还没准备好，请稍后再试。' })
      const ansSid = decodeSegment(mAns[1])
      if (ansSid === null || !getSession(ansSid)) return json(res, 404, { error: '会话不存在。' })
      const body = await readJson<{ key?: unknown; kind?: unknown; payload?: unknown }>(req)
      const key = typeof body?.key === 'string' ? body.key.trim() : ''
      if (!key) return json(res, 400, { error: '缺少卡片键（key）。' })
      const payload = (body?.payload ?? {}) as Record<string, unknown>
      if (body?.kind === 'ask') {
        const raw = Array.isArray(payload.answers) ? payload.answers : null
        // answers: 逐题字符串数组（与 questions 对齐）；null = 取消/中止（AskResponse 语义原样透传）
        const answers =
          raw === null ? null : raw.map((a) => (typeof a === 'string' ? a : String(a ?? '')))
        if (!rt.answerAsk({ key, answers })) return json(res, 409, { error: '这张问答卡已结束或不存在。' })
        return json(res, 200, { ok: true })
      }
      if (body?.kind === 'plan') {
        const decision = payload.decision
        if (decision !== 'approve' && decision !== 'keep' && decision !== 'ignore')
          return json(res, 400, { error: 'decision 必须是 approve / keep / ignore。' })
        const feedback = typeof payload.feedback === 'string' ? payload.feedback : undefined
        if (!rt.decidePlan({ key, decision, ...(feedback !== undefined ? { feedback } : {}) }))
          return json(res, 409, { error: '这张计划卡已结束或不存在。' })
        return json(res, 200, { ok: true })
      }
      if (body?.kind === 'mount') {
        // 设计 §3.2/§7 不变量:挂载路径只能来自桌面系统目录对话框,远程/通用设备一律只传 null——
        // 这里不透传请求里的 path,防止把任意目录登记为受信根(trustRoot)后借 agent 读写外传。
        if (!rt.answerMount({ key, path: null })) return json(res, 409, { error: '这张挂载卡已结束或不存在。' })
        return json(res, 200, { ok: true })
      }
      return json(res, 400, { error: 'kind 必须是 ask / plan / mount。' })
    }

    // POST /api/turns/:turnId/abort：停止回合（转调 chatRuntime.abort；未知 turnId 为 no-op，照常 ok）
    const mAbort = url.pathname.match(/^\/api\/turns\/([A-Za-z0-9_-]+)\/abort$/)
    if (mAbort && method === 'POST') {
      const rt = getChatRuntime()
      if (!rt) return json(res, 503, { error: 'Deva 还没准备好，请稍后再试。' })
      rt.abort(mAbort[1])
      return json(res, 200, { ok: true })
    }

    // GET /api/sessions/:id/events：会话级 SSE（设计 §3.3 通用化修订）——投递该会话全部
    // 回合的 chat 帧 + 通知，设备端据此实时看到任意发起方的回合（验收线 4）
    const mSessEvents = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
    if (mSessEvents && method === 'GET') {
      const sid = decodeSegment(mSessEvents[1])
      if (sid === null || !getSession(sid)) return json(res, 404, { error: '会话不存在。' })
      const h = req.headers['last-event-id']
      const raw = Array.isArray(h) ? h[0] : h
      const parsed = Number.parseInt(raw ?? '', 10)
      if (!canAdmit(deviceId))
        return json(res, 429, { error: '该设备连接数已达上限，请关闭其他会话的实时订阅。' })
      noteDeviceStream(deviceId, true)
      openSessionStream(res, sid, Number.isFinite(parsed) ? parsed : 0, deviceId)
      return
    }

    // POST /api/sessions/:id/archive：归档 / 取消归档（转调 chat-store.setSessionArchived，与桌面
    // chat:set-archived 同源）。忙碌会话不可归档（与桌面同口径回 409）；取消归档随时可以。
    const mArch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/)
    if (mArch && method === 'POST') {
      const archSid = decodeSegment(mArch[1])
      if (archSid === null || !getSession(archSid)) return json(res, 404, { error: '会话不存在。' })
      const body = await readJson<{ archived?: unknown }>(req)
      if (typeof body?.archived !== 'boolean') return json(res, 400, { error: '缺少 archived 布尔值。' })
      if (body.archived && (getChatRuntime()?.isBusy(archSid) ?? false))
        return json(res, 409, { error: '会话正在运行回合，结束后再归档。' })
      setSessionArchived(archSid, body.archived)
      return json(res, 200, { ok: true, archived: body.archived })
    }

    // POST /api/sessions/:id/rename：重命名对话（转调 chat:rename-session 同一实现；空标题=恢复自动派生）。
    const mRen = url.pathname.match(/^\/api\/sessions\/([^/]+)\/rename$/)
    if (mRen && method === 'POST') {
      const renSid = decodeSegment(mRen[1])
      if (renSid === null || !getSession(renSid)) return json(res, 404, { error: '会话不存在。' })
      const body = await readJson<{ title?: unknown }>(req)
      if (typeof body?.title !== 'string') return json(res, 400, { error: '缺少 title 字符串。' })
      const r = renameSessionTitle(renSid, body.title)
      if (!r) return json(res, 404, { error: '会话不存在。' })
      return json(res, 200, { ok: true, title: r.title })
    }

    // DELETE /api/sessions/:id：删除对话（转调 chat:delete-session 同一实现——成员会话一并删、
    // 在其中运行的定时任务改为独立运行；进行中的回合先中止。桌面确认语义由设备端 UI 承担）。
    const mDelSess = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (mDelSess && method === 'DELETE') {
      const delSid = decodeSegment(mDelSess[1])
      if (delSid === null || !getSession(delSid)) return json(res, 404, { error: '会话不存在。' })
      if (!deleteSessionFully(delSid)) return json(res, 503, { error: 'Deva 还没准备好，请稍后再试。' })
      return json(res, 200, { ok: true })
    }

    // GET /api/sessions/:id：单个会话元信息（设计 §3.3 表补齐;pendingInserts v1 恒空——
    // 插入消息走 send 的 busy→insert 回退,不落独立队列）。带 query 不再落 404:query 一律忽略。
    // model/effort = 本对话当前固定的模型与思考等级（send 显式指定即落档）。
    const mOne = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (mOne && method === 'GET') {
      const oneId = decodeSegment(mOne[1])
      if (oneId === null) return json(res, 400, { error: '会话 id 编码不合法。' })
      const one = getSession(oneId)
      if (!one) return json(res, 404, { error: '会话不存在。' })
      const busy = getChatRuntime()?.isBusy(oneId) ?? false
      const onePn = personaDisplayName(one.personaId)
      const oneLast = lastVisibleText(one.messages)
      return json(res, 200, {
        id: one.id,
        title: one.title,
        personaId: one.personaId,
        ...(onePn ? { personaName: onePn } : {}),
        ...(one.focusRoot ? { focusRoot: one.focusRoot } : {}),
        ...(one.model ? { model: one.model } : {}),
        ...(one.effort ? { effort: one.effort } : {}),
        busy,
        archived: one.archived === true,
        pendingInserts: [],
        pendingCard: pendingCardOf(one),
        ...(oneLast ? { lastMessage: oneLast } : {})
      })
    }

    // GET /api/sessions/:id/messages：历史回填（投影展示条目；?start=&limit= 向后翻页，默认返回最新一段）
    const mMsg = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (mMsg && method === 'GET') {
      const msgSid = decodeSegment(mMsg[1])
      if (msgSid === null) return json(res, 400, { error: '会话 id 编码不合法。' })
      const session = getSession(msgSid)
      if (!session) return json(res, 404, { error: '会话不存在。' })
      const items = await projectMessages(session.messages, session)
      const total = items.length
      const qLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
      const limit = Number.isFinite(qLimit) ? Math.min(Math.max(qLimit, 1), 2000) : 400
      const qStart = Number.parseInt(url.searchParams.get('start') ?? '', 10)
      const start = Number.isFinite(qStart)
        ? Math.min(Math.max(qStart, 0), Math.max(total - 1, 0))
        : Math.max(total - limit, 0)
      return json(res, 200, { sessionId: session.id, total, start, messages: items.slice(start, start + limit) })
    }

    // GET /api/sessions/:id/deliveries?toolUseId=…：直播回合的交付文件（手机收到 present_files
    // 的 tool_result 后拉这口补清单）。回填口 /messages 的 files 字段与其同形。
    const mDel = url.pathname.match(/^\/api\/sessions\/([^/]+)\/deliveries$/)
    if (mDel && method === 'GET') {
      const delSid = decodeSegment(mDel[1])
      if (delSid === null) return json(res, 400, { error: '会话 id 编码不合法。' })
      const session = getSession(delSid)
      if (!session) return json(res, 404, { error: '会话不存在。' })
      const toolUseId = url.searchParams.get('toolUseId') ?? ''
      if (!toolUseId) return json(res, 400, { error: '缺少 toolUseId。' })
      return json(res, 200, { files: await deliveredFiles(session, toolUseId) })
    }

    // GET /api/files?path=…&session=…：下载交付文件 / 取图片预览（设计 §3.3）。
    // 路径必须出现在该会话边车 delivered 里——通道不提供任意路径读取（与桌面 deliverables IPC 同一边界）。
    if (url.pathname === '/api/files' && method === 'GET') {
      const sid = url.searchParams.get('session') ?? ''
      const p = url.searchParams.get('path') ?? ''
      const session = sid ? getSession(decodeSegment(sid) ?? '') : undefined
      if (!session) return json(res, 404, { error: '会话不存在。' })
      if (!p || !Object.values(session.delivered ?? {}).some((arr) => arr.includes(p)))
        return json(res, 403, { error: '只允许下载该对话交付过的文件。' })
      const st = await fs.stat(p).catch(() => null)
      if (!st?.isFile()) return json(res, 404, { error: '文件不存在或已被移动。' })
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size
      })
      const stream = createReadStream(p)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
      return
    }

    // GET /api/turns/:turnId/events：SSE（长连接，此处不写 JSON 结尾）。
    // 未知 turnId 直接 404（sse.turnRegistered）：turn_start 入环即登记，设备端拿到的 turnId
    // 必然已登记——客户端 bug 捏造的无效连接不再开流空等占用连接配额。
    const m = url.pathname.match(/^\/api\/turns\/([A-Za-z0-9_-]+)\/events$/)
    if (m && method === 'GET') {
      if (!turnRegistered(m[1])) return json(res, 404, { error: '回合不存在或已超出事件缓冲。' })
      if (!canAdmit(deviceId))
        return json(res, 429, { error: '该设备连接数已达上限，请关闭其他会话的实时订阅。' })
      const h = req.headers['last-event-id']
      const raw = Array.isArray(h) ? h[0] : h
      const parsed = Number.parseInt(raw ?? '', 10)
      noteDeviceStream(deviceId, true)
      openTurnStream(res, m[1], Number.isFinite(parsed) ? parsed : 0, deviceId)
      return
    }

    return json(res, 404, { error: '接口不存在。' })
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误。' })
    else res.end()
    console.warn('[channel-server] 处理请求失败：', errText(e))
  }
}

/** 起监听（设计 §3.1：端口冲突明确报错，不静默换端口）。 */
export async function startServer(opts: { host: string; port: number }, hooks: ServerHooks): Promise<void> {
  await stopServer()
  hooksRef = hooks
  const srv = createHttpServer((req, res) => {
    void route(req, res)
  })
  server = srv
  srv.on('error', (e) => {
    const code = (e as NodeJS.ErrnoException).code
    hooks.onState(
      'error',
      code === 'EADDRINUSE'
        ? `端口 ${opts.port} 已被占用，请在配置里换一个端口（config.json → generalServer.port）。`
        : errText(e)
    )
  })
  await new Promise<void>((resolve) => {
    srv.once('listening', () => {
      hooks.onState('connected')
      resolve()
    })
    srv.once('error', () => resolve())
    srv.listen(opts.port, opts.host)
  })
}

export async function stopServer(): Promise<void> {
  const srv = server
  server = null
  if (!srv) return
  // SSE 是长连接：先掐掉全部连接再 close，close 回调才会到来
  srv.closeAllConnections()
  await new Promise<void>((resolve) => srv.close(() => resolve()))
}

/** 供 channel-server/index.ts 组装配置（类型复用）。 */
export type { GeneralServerConfig, ChannelState }
