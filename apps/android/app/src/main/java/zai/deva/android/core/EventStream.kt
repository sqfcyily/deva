package zai.deva.android.core

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.random.Random

/** 一帧 SSE 事件（event 仅 chat / notice 两种，data 为服务端平铺后的 JSON）。 */
data class SseFrame(val id: Long, val event: String, val data: JSONObject)

/**
 * SSE 事件流客户端（设计 §3.4 / §4）：连 /api/turns/:turnId/events（或会话级流），
 * 支持 Last-Event-ID 续传与指数退避重连（1s→2s→…→30s，抖动 ±20%）。
 * 手解 text/event-stream（服务端 data 恒为单行 JSON，仍按规范支持多行 data 拼接）。
 * 收到任何一帧即重置退避；notice 的 replay_reset 清零 lastEventId 并回调（触发整体回填）。
 *
 * 生命周期以**代际号**守护：每次 start()/stop() 递增 generation，旧 worker 的回调
 * 与 abort 句柄写入据此过期——杜绝 stop/start 竞态下的僵尸 worker、句柄互踩与
 * 状态回调串台（审查 P1-1）。续传 id 按 target 作用域保存：target 变化即清零
 * （审查 P1-2——A 会话的 id 拿去 B 会话重放会错位）。读循环挂**心跳看门狗**：
 * 超过 WATCHDOG_MS 没有任何行（含 : ping）即判死重连（审查 P1-3，防静默断连
 * 在 live 态挂 15-30 分钟）。
 */
class EventStream(
    private val baseUrlProvider: () -> String?,
    private val tokenProvider: () -> String?,
    /** 断线自动重连闸门（设置页开关，默认开）；关掉时断线即停，重进会话再手动恢复。 */
    private val reconnectEnabled: () -> Boolean = { true },
    /** 独立 client：SSE 长连接不设读超时（存活由看门狗守护）。 */
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .build()
) {
    companion object {
        /** 超过该毫秒数没有任何行（含心跳）即判连接死亡。服务端心跳 15s，取 3 倍容差。 */
        private const val WATCHDOG_MS = 45_000L
    }

    /** 代际号：每次 start()/stop() 递增，旧 worker 的回调与句柄写入据此过期。 */
    private val generation = AtomicLong(0)
    /** 当前 worker 线程；stop() 据此中断。 */
    private val workerRef = AtomicReference<Thread?>(null)
    /** 当前 worker 的在飞请求；stop() 据此取消。仅当代际未变时才允许写入。 */
    private val abortHandle = AtomicReference<okhttp3.Call?>(null)

    /** 最近收到的一帧 id（续传用，按 target 作用域）；replay_reset/target 变化时清零。 */
    @Volatile var lastEventId: Long = 0
        private set
    @Volatile private var lastTarget: String? = null

    /**
     * 开始订阅 target（回合 id 或会话 id，决定 URL 路径段）；幂等：先 stop 旧的。
     * onFrame 在 SSE 线程回调（转发方自行保证线程安全）；
     * onState: connecting/live/reconnecting/stopped/unauthorized。
     */
    @Synchronized
    fun start(target: String, onFrame: (SseFrame) -> Unit, onReplayReset: () -> Unit, onState: (String) -> Unit = {}) {
        stop()
        // 续传 id 是按 target 作用域的：A 会话的 id 拿去 B 会话重放会错位（审查 P1-2）
        if (target != lastTarget) lastEventId = 0
        lastTarget = target
        val gen = generation.incrementAndGet()
        onState("connecting")
        workerRef.set(thread(name = "deva-sse", isDaemon = true) { runLoop(gen, target, onFrame, onReplayReset, onState) })
    }

    /** 停止：先递增代际让旧 worker 一切写入过期，再中断线程、取消在飞请求。 */
    @Synchronized
    fun stop() {
        generation.incrementAndGet()
        workerRef.getAndSet(null)?.interrupt()
        abortHandle.getAndSet(null)?.cancel()
        workerRef.set(null)
    }

    private fun runLoop(
        gen: Long,
        target: String,
        onFrame: (SseFrame) -> Unit,
        onReplayReset: () -> Unit,
        onState: (String) -> Unit
    ) {
        var attempt = 0
        onState("connecting")
        while (generation.get() == gen) {
            val base = baseUrlProvider() ?: break
            // 会话级流走 /api/sessions/:id/events；回合流走 /api/turns/:id/events（设计 §3.3）
            val urlPath =
                if (target.startsWith("sess_")) "/api/sessions/$target/events" else "/api/turns/$target/events"
            val b = Request.Builder().url(base + urlPath).get()
            tokenProvider()?.takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
            if (lastEventId > 0) b.header("Last-Event-ID", lastEventId.toString())
            val call = http.newCall(b.build())
            abortHandle.set(call)
            var watchdog: Thread? = null
            try {
                call.execute().use { resp ->
                    if (generation.get() != gen) return
                    if (resp.code == 401 || resp.code == 403) {
                        // 凭据无效不再空转重连：报 unauthorized 终态，UI 引导去设置重新配对
                        onState("unauthorized")
                        return
                    }
                    if (resp.code != 200) {
                        onState("reconnecting")
                    } else {
                        onState("live")
                        val src = resp.body?.source() ?: return
                        var lastLineAt = System.currentTimeMillis()
                        // 看门狗：WATCHDOG_MS 内没有任何行（含 : ping）即判死重连（审查 P1-3）
                        watchdog = thread(name = "deva-sse-watchdog", isDaemon = true) {
                            while (generation.get() == gen) {
                                if (System.currentTimeMillis() - lastLineAt > WATCHDOG_MS) {
                                    runCatching { call.cancel() }
                                    return@thread
                                }
                                // stop() 的清理中断会打进这个 sleep：吞掉退出，不留 uncaught 噪音日志
                                try {
                                    Thread.sleep(5_000)
                                } catch (_: InterruptedException) {
                                    return@thread
                                }
                            }
                        }
                        var evName = ""
                        var evId = 0L
                        val data = StringBuilder()
                        while (generation.get() == gen) {
                            val line = src.readUtf8Line() ?: break
                            lastLineAt = System.currentTimeMillis()
                            when {
                                line.isEmpty() -> {
                                    // 帧边界：注释/心跳（: ping）也会走到这，data 为空时直接丢弃
                                    if (data.isNotEmpty()) {
                                        dispatch(evName, evId, data.toString(), onFrame, onReplayReset)
                                        attempt = 0 // 有真帧 = 连接活过一轮，退避归零
                                    }
                                    evName = ""
                                    evId = 0L
                                    data.setLength(0)
                                }
                                line.startsWith(":") -> Unit // 注释 / 心跳
                                line.startsWith("id:") -> evId = line.substring(3).trim().toLongOrNull() ?: evId
                                line.startsWith("event:") -> evName = line.substring(6).trim()
                                line.startsWith("data:") -> {
                                    if (data.isNotEmpty()) data.append('\n')
                                    data.append(line.substring(5).removePrefix(" "))
                                }
                                line.startsWith("retry:") -> Unit // 服务端建议的 retry，重连节奏走自己的退避
                            }
                        }
                    }
                }
            } catch (_: IOException) {
                // cancel() / 断线都走这：走退避重连
            } finally {
                abortHandle.compareAndSet(call, null)
                watchdog?.interrupt()
            }
            if (generation.get() != gen) break
            if (!reconnectEnabled()) {
                onState("stopped")
                break
            }
            onState("reconnecting")
            try {
                Thread.sleep(backoffMs(attempt))
            } catch (_: InterruptedException) {
                break
            }
            attempt++
        }
        if (generation.get() == gen) onState("stopped")
    }

    private fun dispatch(
        evName: String,
        evId: Long,
        data: String,
        onFrame: (SseFrame) -> Unit,
        onReplayReset: () -> Unit
    ) {
        val json = try {
            JSONObject(data)
        } catch (_: Exception) {
            return
        }
        if (evName == "notice") {
            if (json.optString("type") == "replay_reset") {
                lastEventId = 0
                onReplayReset()
            }
            return
        }
        if (evId > 0) lastEventId = evId
        onFrame(SseFrame(id = evId, event = evName, data = json))
    }

    /** 1s→2s→…→30s 封顶，±20% 抖动（设计 §4）。 */
    private fun backoffMs(attempt: Int): Long {
        val base = (1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000L)
        val jitter = (base * 0.2).toLong()
        return base + Random.nextLong(-jitter, jitter + 1)
    }
}
