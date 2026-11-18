import type { ActionValue, PromptView } from './remote-views'

/**
 * Deva 手机版 ⇄ 电脑端的线上协议（JSON 帧，走 WebSocket）。
 *
 * 手机端是电脑上 Deva 的手机形态：对话列表、角色、单个对话的历史与最终回复、交互卡、交付文件。对话记录的真源是
 * 电脑上的对话文件，手机按需拉取并在本机缓存；进行中只推「正在做什么」一行状态，回合结束再推一次对话摘要。
 *
 * 传输无关：经中转（默认官方中转，也可以是自建的）时手机与电脑都连中转，中转只按桌面 id 原样转发；
 * 仅局域网时手机直连电脑自带的 HTTP 服务（/ws）。两条路上跑的都是这同一套帧。
 *
 * 安全：连上后先做端到端加密握手（shared/remote-crypto.ts），之后的帧都是密文 { t:'x' }，下面的
 * WebClientFrame / WebServerFrame 是密文里的内容。明文只有握手、心跳与中转发的「电脑不在线」。
 */

/**
 * 协议版本：手机连上时在 hello 里报给电脑端，两边不一致就提示刷新页面或更新 Deva 并断开。
 * 手机网页随中转部署、电脑端随用户安装各自更新，帧格式有不兼容的改动时加 1（随后重新部署中转）。
 */
export const WEB_PROTOCOL_VERSION = 1

/**
 * 手机新建对话时先定好的对话 id（同电脑端 sess_<时间>_<随机>）：手机不等回执直接进入对话页。
 * 电脑端只收这个格式（id 会用作对话文件名）。
 */
export const PHONE_SID_RE = /^sess_[0-9a-z]{1,12}_[0-9a-z]{1,8}$/

/**
 * Deva 官方中转（Cloudflare Workers）。连接方式选「中转」且没填自己的地址时用它，用户不用做任何设置。
 * 部署见 apps/relay/README.md；域名 m.deva.chat 是在 Cloudflare 控制台绑到 deva-relay 上的（Custom domain），
 * 不写进 wrangler.toml，免得自建中转的人照着部署时因为没有这个域名而失败。
 * 必须是 https：手机网页的端到端加密（WebCrypto）、添加到主屏幕与推送都只在安全上下文里可用。
 * 配置里不存这个地址（留空 = 官方），换了以后没自定义的用户自动跟着换；但手机上的凭证按网页域名保存，换域名后手机要重新扫码。
 */
export const OFFICIAL_RELAY_URL = 'https://m.deva.chat'

/** 角色（抽屉里的一行）。avatar = Humation 参数（JSON 串，空 = 按 id 生成）；avatarImage = 上传的图片 data URI。 */
export interface WebPersona {
  id: string
  name: string
  description: string
  model: string
  avatar: string
  avatarImage: string
  enabled: boolean
}

/** 对话（列表里的一行）。busy = 正在处理；waiting = 停下来等你在卡片上决定；status = 进行中的一行提示。 */
export interface WebSession {
  id: string
  title: string
  personaId?: string
  createdAt: number
  updatedAt: number
  /** 最近一条消息的摘要（列表第二行）。 */
  preview: string
  /** 最近一条是谁说的（列表里给用户消息加「我：」）。 */
  previewRole?: 'user' | 'assistant'
  busy: boolean
  waiting: boolean
  status?: string
  /** 这一轮开始的时间（进行中时有，对话页显示「处理中 · 1 分 12 秒」）。 */
  since?: number
  /** task = 独立运行的定时任务的对话（行上打闹钟图标，同电脑端）。 */
  kind: 'chat' | 'task'
  /** 绑定在这个对话上的定时任务名（「在会话中运行」的任务：任务对话本身不进列表，这里打闹钟图标）。 */
  tasks?: string[]
  /** 挂载的文件夹名（只给名字，不给完整路径）。 */
  folder?: string
  /**
   * 项目成员（群组头像、对话页标题下的名单），已移除的不在内。id = 头像种子；
   * personaId = 用户 @ 加入的角色（头像、名字就用该角色本身，手机按角色列表取上传的头像图）。
   */
  members?: { id: string; name: string; avatar?: string; personaId?: string }[]
  /** 已归档：只在「已归档」里列出。 */
  archived?: boolean
  /** 「在会话中运行」的定时任务的对话：不进任何列表，从任务详情「查看对话」进入（同电脑端）。 */
  hidden?: boolean
  /** 这个对话发消息时用的模型（「服务商 id:模型 id」）与显示名；一个可用模型都没有时缺省。 */
  model?: string
  modelName?: string
  /** 连接模型中断 / 自动重试时的说明（对话页「进行中」标识旁显示）；正常进行时缺省。 */
  retry?: string
  /** 最后一次被看过的时间（电脑或手机，任一端看过就算）：手机的未读红点以它为准，电脑上看过的不再显示红点。 */
  readAt?: number
}

export type WebTaskStatus = 'active' | 'paused' | 'completed' | 'error'
export type WebTaskRunStatus = 'ok' | 'error' | 'skipped' | 'aborted'
/** 手机上对定时任务的操作（第一版不能编辑）。 */
export type WebTaskAction = 'pause' | 'resume' | 'run' | 'delete'

/** 定时任务（抽屉「定时任务」的列表与详情，对比稿 design/mobile-tasks.html 方案 A）。 */
export interface WebTask {
  id: string
  title: string
  /** 人读的日程（「每天 09:00」），电脑端按界面语言生成。 */
  schedule: string
  status: WebTaskStatus
  /** 下次运行（只在进行中时有意义）；不再触发为 null。 */
  nextRunAt: number | null
  /** 最近一次运行（含「立即运行」）；从未运行时缺省。 */
  lastRun?: { at: number; status: WebTaskRunStatus }
  /** 执行的角色；缺省 = 默认角色 Deva。 */
  personaId?: string
  /** 模型显示名（服务商 · 模型）；缺省 = 跟随默认模型。 */
  model?: string
  /** 「在会话中运行」时所在的对话；缺省 = 独立运行。 */
  owner?: { sid: string; title: string }
  /** 任务自己的对话（「查看对话」）；第一次运行前还没有、被删了也没有。 */
  sessionId?: string
}

/** 用户消息里的附件。ref = 图片在对话里的定位（取缩略图 / 原图用）。 */
export interface WebAttachment {
  name: string
  kind: 'image' | 'document' | 'text' | 'folder' | 'file'
  ref?: string
}

/** 助手消息里交付的文件（present_files）。tool + index 定位到那次交付里的第几个文件。 */
export interface WebDelivered {
  tool: string
  index: number
  name: string
}

/**
 * 交互卡（问答、计划、挂载、定时任务、角色名片）处理之后留在对话里的一行回执（文案见 shared/remote-receipts.ts）。
 * tone：ok = 已回答 / 已批准 / 已创建 / 已添加（绿色对勾）；redo = 继续完善；off = 跳过 / 忽略 / 拒绝 / 未作答（灰色）。
 * strong = 加粗的那段（你的选择）；detail = 点「查看」展开的全文（Markdown：计划正文、多个问题的问答）。
 */
export interface WebReceipt {
  k: 'receipt'
  tone: 'ok' | 'redo' | 'off'
  text: string
  strong?: string
  detail?: string
}

/** 一条助手回复里的内容：一段正文、一个交付的文件、一行提示（已停止、出错等）、一行回执，按出现的先后排列。 */
export type WebPart = { k: 'text'; text: string } | { k: 'file'; file: WebDelivered } | { k: 'note'; text: string } | WebReceipt

/**
 * 对话里的一条消息（由电脑端的展示投影归约而来：只有正文，工具调用与过程不下发）。
 * 助手的一轮里每段正文（两次工具调用之间写的话）是一个 text 部分，手机上各自一个气泡；
 * 进行中插入的消息拆成一条用户消息，排在它送达的位置。
 * id = 在展示投影里的序号；同一序号拆出的第 2、3 … 条记为「序号.1」「序号.2」，Number(id) 仍可比较先后。
 */
export type WebMessage =
  | { id: string; role: 'user'; text: string; attachments?: WebAttachment[]; notify?: boolean }
  | { id: string; role: 'assistant'; parts: WebPart[]; durationMs?: number; from?: WebSpeaker }

/**
 * 这条回复不是主角色说的：成员交差的结论（以成员的身份显示，同电脑端），或绑定的定时任务告知的结果（task）。
 * id / avatar / personaId 同 WebSession.members（画头像）；任务的 personaId = 任务所用的角色。
 */
export interface WebSpeaker {
  name: string
  id?: string
  avatar?: string
  personaId?: string
  task?: true
}

/** 可选的模型（对话页「更多」里切换）。ref = 「服务商 id:模型 id」。 */
export interface WebModel {
  ref: string
  name: string
  provider: string
}

/** 需要你决定的交互卡（提问 / 计划 / 挂载 / 定时任务名片 / 角色名片），按 key 原地更新。 */
export interface WebPrompt {
  view: PromptView
  at: number
  /** 成员在等你处理的卡：显示在主对话末尾（同电脑端），不在卡片自己的对话里（成员对话手机上看不到）。 */
  member?: WebPromptMember
}

/**
 * 等你处理的那位成员。sid = 主对话；id / avatar / personaId 同 WebSession.members（画头像）；
 * isNew = 主角色建成员时为新成员选文件夹（成员还没建，没有头像）。
 */
export interface WebPromptMember {
  sid: string
  name: string
  id?: string
  avatar?: string
  personaId?: string
  isNew?: boolean
}

/** 一条通知（定时任务跑完 / 自动暂停 …），可关联到某个对话。 */
export interface WebNotice {
  id: string
  at: number
  title?: string
  text: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  sessionId?: string
}

/** 手机端的推送订阅（PushSubscription.toJSON() 的子集）。 */
export interface WebPushSub {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** 文件预览：text = 纯文本 / 代码 / 从 Office 文档抽出的文字；markdown；image / binary 的字节随后分块下发。 */
export type WebFileKind = 'text' | 'markdown' | 'image' | 'binary'

export type WebClientFrame =
  /** 握手后的第一帧。v = 协议版本；kind：standalone = 从主屏幕打开，browser = 浏览器标签页；name = 设备名（配对时用）。 */
  | { t: 'hello'; v: number; name: string; kind: 'browser' | 'standalone' }
  /** 重新拉对话列表与角色列表。 */
  | { t: 'refresh' }
  /**
   * 某对话的历史：before = 只要序号小于它的（往前翻页）；缺省取最新一页，同时表示正看着这个对话——
   * 进行中有新内容电脑会直接推来（history 帧带 live）。
   */
  | { t: 'history'; sid: string; before?: number; limit?: number }
  /** cid = 客户端临时 id，服务端用 sent 帧回结果。files = 已上传完的文件 id。进行中的对话会作为插入送达。 */
  | { t: 'send'; sid: string; text: string; cid: string; files?: string[] }
  | { t: 'stop'; sid: string }
  /**
   * 新建对话（按角色）；rid 用 created 帧回。sid 由手机先定好（PHONE_SID_RE），手机不等回执就进入对话页、
   * 可以接着发消息——帧按顺序到达，电脑先建好对话再处理后面的。
   */
  | { t: 'new'; rid: string; personaId?: string; sid: string }
  /** 交互卡上的动作（key = 卡片 key；rid 用 result 帧回）。 */
  | { t: 'action'; rid: string; key: string; value: ActionValue; form?: Record<string, string | string[]> }
  /** 上传：begin → chunk × N（base64url，按 seq 顺序）→ end；电脑端用 upload 帧回。 */
  | { t: 'up_begin'; uid: string; name: string; size: number; mime: string }
  | { t: 'up_chunk'; uid: string; seq: number; data: string }
  | { t: 'up_end'; uid: string }
  | { t: 'up_cancel'; uid: string }
  /** 取交付文件（预览 / 下载）。 */
  | { t: 'file'; rid: string; sid: string; tool: string; index: number }
  /** 取对话里图片附件的缩略图（full = 原图）。 */
  | { t: 'image'; rid: string; sid: string; ref: string; full?: boolean }
  /** 添加到主屏幕前要一张安装票据（主屏幕图标首次打开时用它换自己的凭证）。 */
  | { t: 'install'; rid: string }
  /** 推送订阅（null = 取消）。 */
  | { t: 'push'; rid: string; sub: WebPushSub | null }
  /** 页面是否在前台（在前台时电脑端不推送，免得重复提醒）。 */
  | { t: 'visible'; visible: boolean }
  /** 正在看这个对话（打开时、有新内容时）：记为已读，电脑上的红点随之消掉。 */
  | { t: 'read'; sid: string }
  /** 归档 / 取消归档（rid 用 result 帧回；进行中的对话不能归档）。 */
  | { t: 'archive'; rid: string; sid: string; archived: boolean }
  /** 删除对话（进行中的先停止；电脑上同样删除，不可恢复）。 */
  | { t: 'delete'; rid: string; sid: string }
  /** 可选的模型列表（用 models 帧回）。 */
  | { t: 'models'; rid: string }
  /** 切换某对话的模型（同电脑端输入框切换：记在这个对话上，rid 用 result 帧回）。 */
  | { t: 'set_model'; rid: string; sid: string; ref: string }
  /** 改这台手机在电脑上显示的名字。 */
  | { t: 'rename'; rid: string; name: string }
  /** 定时任务：暂停 / 恢复 / 立即运行 / 删除（rid 用 result 帧回；立即运行时 message 非空 = 已在运行，不是错误）。 */
  | { t: 'task'; rid: string; id: string; action: WebTaskAction }
  /** 断开这台手机（电脑端移除这台设备）。 */
  | { t: 'bye' }

export type WebServerFrame =
  /** hello 成功：电脑、这台设备、对话列表、未决的交互卡、推送公钥（不支持推送时为 null）。 */
  | {
      t: 'ok'
      v: number
      desk: { id: string; computer: string }
      device: { id: string; name: string }
      sessions: WebSession[]
      prompts: WebPrompt[]
      vapid: string | null
    }
  /** 配对 / 安装成功：设备 id 与设备密钥，手机存好，以后用它重连。 */
  | { t: 'paired'; device: string; key: string }
  | { t: 'err'; code: 'bad_request' | 'gone'; message: string }
  | { t: 'sessions'; list: WebSession[] }
  | { t: 'session'; s: WebSession }
  | { t: 'session_gone'; sid: string }
  | { t: 'personas'; list: WebPersona[] }
  /** 定时任务的完整列表（连上时、任务或对话有变化时整份重发）。 */
  | { t: 'tasks'; list: WebTask[] }
  /**
   * 展示投影里 [start, end) 这一段归约出的消息；total = 投影的总条数。
   * live = 进行中电脑主动推来的这一轮（从它的用户消息起）：接不上手机已有的那段就丢掉，不拿它整段替换。
   */
  | { t: 'history'; sid: string; messages: WebMessage[]; start: number; end: number; total: number; live?: true }
  | { t: 'models'; rid: string; list: WebModel[] }
  /** 发送回执。at = 这条消息在对话记录里的 id（插入进行中这一轮的没有：要等交给模型才落进记录）。 */
  | { t: 'sent'; cid: string; sid: string; ok: boolean; message?: string; at?: string }
  | { t: 'created'; rid: string; sid?: string; error?: string }
  | { t: 'prompt'; p: WebPrompt }
  | { t: 'notice'; n: WebNotice }
  | { t: 'result'; rid: string; ok: boolean; message: string }
  /** 上传：ready = 可以开始发块；done = 收齐并登记好（id 用于 send.files）。 */
  | { t: 'upload'; uid: string; state: 'ready' | 'done' | 'failed'; message?: string }
  /** 文件：text / markdown 直接带内容；image / binary 随后有 chunks 个 file_chunk。 */
  | {
      t: 'file'
      rid: string
      ok: boolean
      message?: string
      name?: string
      size?: number
      mime?: string
      kind?: WebFileKind
      text?: string
      truncated?: boolean
      chunks?: number
    }
  | { t: 'file_chunk'; rid: string; seq: number; data: string }
  | { t: 'image'; rid: string; uri: string | null }
  | { t: 'install'; rid: string; ticket: string | null; message?: string }
  /** 这台设备已被移除（电脑上移除 / 手机上断开）：手机清掉凭证。 */
  | { t: 'removed' }

/** 握手前后的明文帧（中转与电脑都可能发）。 */
export type WebPlainServerFrame =
  | { t: 'hi'; e: string; m: string }
  /** 握手失败：auth = 票据过期 / 已用过 / 设备已移除；version = 版本不匹配。 */
  | { t: 'err'; code: 'auth' | 'version' | 'busy'; message: string; removed?: boolean }
  | { t: 'pong' }
  /** 中转发出：这台电脑的 Deva 没连上中转。 */
  | { t: 'offline' }
  | { t: 'x'; d: string }

/** 单帧上限（明文 JSON 长度）。上传 / 下载按块走，块大小留足余量。 */
export const MAX_FRAME_CHARS = 512 * 1024
/** 上传 / 下载每块的原始字节数（base64 + 加密后约 1.4 倍，远小于帧上限）。 */
export const FILE_CHUNK_BYTES = 192 * 1024
/** 手机上传单个文件的上限。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** 交付文件下载到手机的上限（更大的只能在电脑上打开）。 */
export const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024

// ───────── 电脑端 ⇄ 中转 ─────────

/** 中转 → 桌面：某部手机连上 / 发来一帧（d 为原始 JSON 文本）/ 断开。c = 中转分配的连接 id。 */
export type RelayToDesk = { t: 'open'; c: string } | { t: 'msg'; c: string; d: string } | { t: 'close'; c: string }

/** 桌面 → 中转：给某连接回一帧 / 主动断开它。 */
export type DeskToRelay = { t: 'msg'; c: string; d: string } | { t: 'close'; c: string }

/**
 * 手机网页地址里的参数（放在 # 后，不会发到服务器）：
 *   d = 桌面 id（经中转时）；p = 配对票据（扫码）；i = 安装票据（添加到主屏幕）；n = 电脑名（连接中页面显示用）；
 *   o = 打开某个对话（通知点进来：「桌面 id.对话 id」）。
 */
export interface WebPageParams {
  d?: string
  p?: string
  i?: string
  n?: string
  o?: string
}

export function parseWebPageParams(hash: string): WebPageParams {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const get = (k: string): string | undefined => q.get(k) || undefined
  return { d: get('d'), p: get('p'), i: get('i'), n: get('n'), o: get('o') }
}
