/**
 * 设备活动追踪（设计 §3.5「在线设备数与最近活动时间」）。
 * lastSeen = 最近一次带鉴权的请求时间；online = 有存活的 SSE 连接。
 * 进程内态，不落盘——重启后归零，设备重连即刷新。
 */
const lastSeen = new Map<string, number>()
/** 在线引用计数：同设备的并存 SSE 连接全断才算离线（审查 P1-6）。 */
const onlineRefs = new Map<string, number>()
const online = new Set<string>()

export function noteDeviceSeen(deviceId: string): void {
  if (!deviceId) return
  lastSeen.set(deviceId, Date.now())
}

export function noteDeviceStream(deviceId: string, open: boolean): void {
  if (!deviceId) return
  if (open) {
    onlineRefs.set(deviceId, (onlineRefs.get(deviceId) ?? 0) + 1)
    online.add(deviceId)
    noteDeviceSeen(deviceId)
  } else {
    const n = (onlineRefs.get(deviceId) ?? 1) - 1
    if (n <= 0) {
      onlineRefs.delete(deviceId)
      online.delete(deviceId)
    } else {
      onlineRefs.set(deviceId, n)
    }
  }
}

/** 吊销设备：清活动态（连接本身由 sse.closeDeviceConnections 掐断）。 */
export function dropDevice(deviceId: string): void {
  onlineRefs.delete(deviceId)
  online.delete(deviceId)
  lastSeen.delete(deviceId)
}

export function deviceActivity(deviceId: string): { online: boolean; lastSeenAt: number } {
  return { online: online.has(deviceId), lastSeenAt: lastSeen.get(deviceId) ?? 0 }
}
