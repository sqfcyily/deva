import type { ServerResponse } from 'node:http'
import { onAppNotice, onChatEvent, type AppNotice } from '../chat-bus'
import { noteDeviceStream } from './activity'

/**
 * SSE 事件流（设计 §3.4）：channel-server 对 chat-bus 的唯一订阅在这里，
 * 每个 SSE 连接只是「按回合过滤的视图」，不各自订阅。
 *
 *  · 所有事件先进进程内环形缓冲（每会话 2000 条），连接断开后照常积累，重连续传靠它；
 *  · 帧形状：id 单调递增（进程内计数器），event 仅 chat / notice 两种，
 *    data 把 sessionId / turnId 平铺进 JSON、ChatStreamEvent / AppNotice 原样透传，不新增事件形状；
 *  · GET /api/turns/:turnId/events：投递本回合的事件 + 该会话的会话级事件（turnId 为空串的 chat
 *    与带 sessionId 的 notice）；客户端带 Last-Event-ID 补发增量，超出缓冲回 replay_reset
 *    （客户端重新拉 /messages 回填）。
 */

const RING_CAPACITY = 2000
/** 连接配额(审查 A2):全局 + 每设备,超限拒绝新建 SSE(429)。 */
const MAX_CONNECTIONS = 64
const MAX_PER_DEVICE = 4
/** 单会话 ring 的字节预算：超出丢最老帧（大帧入环时降级为占位，直播连接已收过完整帧）。 */
const RING_BYTES = 5 * 1024 * 1024
/** 超过该字节的帧不入环原文，替换为占位（回放端按未知类型忽略，设计 §3.4）。 */
const FRAME_MAX_BYTES = 64 * 1024
/** turnId → sessionId 索引的容量上限（防长期运行无界增长；淘汰最老的）。 */
const TURN_INDEX_MAX = 2000
const HEARTBEAT_MS = 15_000

interface Frame {
  id: number
  /** SSE 的 event 名。 */
  kind: 'chat' | 'notice'
  sessionId?: string
  turnId?: string
  data: string
}

interface Connection {
  res: ServerResponse
  turnId: string
  /** 发起连接的设备（鉴权时解析）；关闭时据此清除在线态。 */
  deviceId?: string
  /** 首个本回合事件到达后锁定其会话；会话级事件只投给已锁定会话的连接。 */
  sessionId?: string
  /** 会话级订阅（/api/sessions/:id/events）：投递该会话全部回合的 chat 帧 + 通知。 */
  sessionLevel?: boolean
  heartbeat: ReturnType<typeof setInterval>
}

let nextId = 1
const rings = new Map<string, Frame[]>()
const ringBytes = new Map<string, number>()
const turnIndex = new Map<string, string>()
const connections = new Set<Connection>()
let unsubscribers: (() => void)[] = []

function lockSession(conn: Connection, f: Frame): void {
  if (conn.sessionId === undefined && f.kind === 'chat' && f.turnId === conn.turnId && f.sessionId)
    conn.sessionId = f.sessionId
}

function matches(conn: Connection, f: Frame): boolean {
  // 会话级订阅（设计 §3.3 通用化修订）：该会话的一切帧（全部回合 + 通知）都投递——
  // 设备端据此实时看到任意发起方的回合（验收线 4）
  if (conn.sessionLevel) return f.sessionId === conn.sessionId
  // 本回合的事件
  if (f.kind === 'chat' && f.turnId === conn.turnId) return true
  // 已锁定会话后的：该会话的会话级事件（turnId 为空串）与会话通知
  if (conn.sessionId !== undefined && f.sessionId === conn.sessionId) {
    if (f.kind === 'notice') return true
    if (f.turnId === '') return true
  }
  return false
}

function push(f: Frame): void {
  if (!f.sessionId) return // 无会话归属的通知只做实时投递，不进缓冲
  let ring = rings.get(f.sessionId)
  if (!ring) {
    ring = []
    rings.set(f.sessionId, ring)
    ringBytes.set(f.sessionId, 0)
  }
  // 超大帧降级为占位后入环：直播连接已收到完整帧；回放端按未知类型忽略并推进 id（设计 §3.4）
  let buffered = f.data.length > FRAME_MAX_BYTES
    ? JSON.stringify({ ...JSON.parse(f.data), type: '__truncated__', dropped: 'oversize' })
    : f.data
  ring.push({ ...f, data: buffered })
  ringBytes.set(f.sessionId, (ringBytes.get(f.sessionId) ?? 0) + buffered.length)
  // 帧数与字节双上限：超限丢最老帧（客户端有 Last-Event-ID/replay_reset 兜底）
  if (ring.length > RING_CAPACITY) {
    const dropped = ring.splice(0, ring.length - RING_CAPACITY)
    ringBytes.set(f.sessionId, Math.max(0, (ringBytes.get(f.sessionId) ?? 0) - dropped.reduce((n, d) => n + d.data.length, 0)))
  }
  while ((ringBytes.get(f.sessionId) ?? 0) > RING_BYTES && ring.length > 1) {
    const dropped = ring.shift()
    ringBytes.set(f.sessionId, Math.max(0, (ringBytes.get(f.sessionId) ?? 0) - (dropped?.data.length ?? 0)))
  }
  if (f.kind === 'chat' && f.turnId && !turnIndex.has(f.turnId)) {
    turnIndex.set(f.turnId, f.sessionId)
    if (turnIndex.size > TURN_INDEX_MAX) {
      const oldest = turnIndex.keys().next().value
      if (oldest !== undefined) turnIndex.delete(oldest)
    }
  }
}

/** 连接配额判定:server.ts 在建流前调用,超限回 429。 */
export function canAdmit(deviceId?: string): boolean {
  if (connections.size >= MAX_CONNECTIONS) return false
  if (!deviceId) return true
  const mine = [...connections].filter((c) => c.deviceId === deviceId).length
  return mine < MAX_PER_DEVICE
}

/**
 * turnId 是否已有事件入环（turn_start 已发即登记）。server.ts 的回合级流据此 404 未知 turnId——
 * 客户端 bug 导致的无效连接不再照常开流空等占用连接配额。
 * send 返回前 turn_start 已入环，设备端拿到的 turnId 必然已登记；被 ring 淘汰的老回合回 404 亦符合语义。
 */
export function turnRegistered(turnId: string): boolean {
  return turnIndex.has(turnId)
}

function writeFrame(conn: Connection, f: Frame): void {
  if (conn.res.destroyed || conn.res.writableEnded) return
  // 写背压（审查 P1-5）：停滞连接（进程冻结/死 Wi-Fi）的用户态缓冲无界增长前踢除——
  // 客户端有 Last-Event-ID 续传 + retry 3s，代价极低
  if (conn.res.writableLength > 8 * 1024 * 1024) {
    conn.res.destroy()
    return
  }
  conn.res.write(`id: ${f.id}\nevent: ${f.kind}\ndata: ${f.data}\n\n`)
}

function deliver(f: Frame): void {
  for (const conn of connections) {
    lockSession(conn, f)
    if (matches(conn, f)) writeFrame(conn, f)
  }
}

/** 订阅 chat-bus（通道启动时调一次；停止时退订并断开全部连接）。 */
export function startEventStream(): void {
  if (unsubscribers.length) return
  unsubscribers.push(
    onChatEvent(({ sessionId, turnId, event }) => {
      const f: Frame = {
        id: nextId++,
        kind: 'chat',
        sessionId,
        turnId,
        data: JSON.stringify({ sessionId, turnId, ...event })
      }
      push(f)
      deliver(f)
    }),
    onAppNotice((n: AppNotice) => {
      const f: Frame = { id: nextId++, kind: 'notice', sessionId: n.sessionId, data: JSON.stringify(n) }
      push(f)
      deliver(f)
    })
  )
}

/**
 * 接管一条 SSE 响应：补发增量（仅当带了 Last-Event-ID）→ 挂上实时投递 → 心跳。
 * replay_reset 语义（设计 §3.4）：Last-Event-ID 早于缓冲最老一帧（超出缓冲）或来自上一进程
 * （计数器已重置）时，发一帧 notice 让客户端重新拉 /messages。
 */
/** 会话删除后回收 ring 缓冲（chat.ts purgeSession 经 onSessionPurge 调用，审查 P1-4）。 */
export function dropSession(sessionId: string): void {
  rings.delete(sessionId)
  ringBytes.delete(sessionId)
  for (const [id, sid] of turnIndex) if (sid === sessionId) turnIndex.delete(id)
}

/** 吊销设备时掐断其全部 SSE 连接（鉴权只在建连时做，必须主动断）。 */
export function closeDeviceConnections(deviceId: string): void {
  for (const conn of connections) {
    if (conn.deviceId === deviceId) conn.res.destroy()
  }
}

/**
 * 会话级 SSE（设计 §3.3 通用化修订）：投递该会话全部回合的 chat 帧 + 通知。
 * 设备端据此实时看到任意发起方的回合（验收线 4）——回合发现靠 turn_start 自带 turnId。
 * 连接常开（done 不关闭），离开由客户端断开；Last-Event-ID/replay_reset 语义与回合流一致。
 */
export function openSessionStream(res: ServerResponse, sessionId: string, lastEventId: number, deviceId?: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write('retry: 3000\n\n')

  const conn: Connection = {
    res,
    turnId: '',
    sessionId,
    sessionLevel: true,
    heartbeat: setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n')
    }, HEARTBEAT_MS)
  }
  connections.add(conn)

  if (lastEventId > 0) {
    const ring = rings.get(sessionId)
    const stale = lastEventId >= nextId || !ring || ring.length === 0 || lastEventId + 1 < ring[0].id
    if (stale) {
      writeFrame(conn, {
        id: nextId++,
        kind: 'notice',
        data: JSON.stringify({ type: 'replay_reset', sessionId })
      })
    } else {
      for (const f of ring) if (f.id > lastEventId && f.sessionId === sessionId) writeFrame(conn, f)
    }
  }

  res.on('error', () => res.destroy())
  res.on('close', () => {
    clearInterval(conn.heartbeat)
    connections.delete(conn)
    if (deviceId) noteDeviceStream(deviceId, false)
  })
}

export function openTurnStream(res: ServerResponse, turnId: string, lastEventId: number, deviceId?: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write('retry: 3000\n\n')

  const conn: Connection = {
    res,
    turnId,
    deviceId,
    heartbeat: setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n')
    }, HEARTBEAT_MS)
  }
  connections.add(conn)

  if (lastEventId > 0) {
    const session = turnIndex.get(turnId)
    const ring = session ? rings.get(session) : undefined
    const stale =
      lastEventId >= nextId || !ring || ring.length === 0 || lastEventId + 1 < ring[0].id
    if (stale) {
      writeFrame(conn, {
        id: nextId++,
        kind: 'notice',
        data: JSON.stringify({ type: 'replay_reset', ...(session ? { sessionId: session } : {}) })
      })
    } else {
      for (const f of ring) {
        lockSession(conn, f)
        if (f.id > lastEventId && matches(conn, f)) writeFrame(conn, f)
      }
    }
  }

  res.on('error', () => res.destroy())
  res.on('close', () => {
    clearInterval(conn.heartbeat)
    connections.delete(conn)
    if (conn.deviceId) noteDeviceStream(conn.deviceId, false)
  })
}

export function stopEventStream(): void {
  for (const u of unsubscribers) u()
  unsubscribers = []
  for (const conn of connections) {
    clearInterval(conn.heartbeat)
    if (!conn.res.writableEnded) conn.res.end()
  }
  connections.clear()
  rings.clear()
  turnIndex.clear()
}
