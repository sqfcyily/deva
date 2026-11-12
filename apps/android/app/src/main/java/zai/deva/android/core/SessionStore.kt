package zai.deva.android.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 会话列表与消息缓存（设计 §4）：v1 只用内存，不进 Room。
 * 列表按 updatedAt 倒序（服务端已排）；每会话一份 TimelineBuilder + StateFlow。
 *
 * 订阅模型（设计 §3.3 会话级 SSE，通用化修订）：进入会话即订阅**会话级流**
 * `/api/sessions/:id/events`——该会话任意发起方（本机/桌面/定时任务）的回合都实时
 * 可见（验收线 4）。回合发现靠 turn_start 自带 turnId（置 active）；done 清位。
 * 自己发起的回合记入 ownTurns：turn_start 不重复画气泡。离开会话 pause 停流，
 * 重进用 Last-Event-ID 续传，replay_reset 触发整体回填。
 */
class SessionStore(
    private val stream: EventStream,
    /** 补拉交付清单用的 client（AppGraph 注入，随当前服务器解析）；null = 不拉，卡停在加载态。 */
    private val clientProvider: () -> DevaClient? = { null }
) {

    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 已补拉过清单的交付卡（同一 toolUseId 只拉一次；SSE 线程判重，并发安全）。 */
    private val fetched: MutableSet<String> = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap())

    /**
     * delta 合帧闸门（审查遗留 #13）：text/thinking delta 可达 20-60 帧/s，每帧一次 O(n) 快照
     * 拷贝 + StateFlow 发射 + LazyColumn diff——长回合里滚动动画与阅读位置被拽。
     * 合并到 ~30fps：首个 delta 定下节拍，节拍内的后续 delta 由同一次发射带上。
     * 结构性帧（tool/card/turn_start…）不经闸门立即上屏，其发射自然带上已累积的 delta。
     */
    private val deltaFlushPending = AtomicBoolean(false)

    private data class SessionState(
        val builder: TimelineBuilder,
        val flow: MutableStateFlow<List<TimelineItem>>,
        /** 正在运行的回合（任意发起方：turn_start 置位、对应 done 清空）；null = 空闲。 */
        val active: MutableStateFlow<String?> = MutableStateFlow(null),
        /** 本机发起的回合 id：turn_start 不重复画气泡（乐观上屏在先）。 */
        val ownTurns: MutableSet<String> = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap()),
        /**
         * 本机发送在途标记（send HTTP 飞行中非空）：桌面 turn_start 帧先于 send 响应到达时，
         * ownTurns 还没登记——据文本相等把该 turn_start 识别为本机回合，不重复画气泡。
         * sendStarted（成功）/ clearSending（失败或忙时插入）清零。
         */
        @Volatile var pendingSendText: String? = null,
        /** 已回填区间起点（全量中的 start）；>0 表示还有更早的可加载。 */
        @Volatile var backfilledStart: Int = 0,
        val hasOlder: MutableStateFlow<Boolean> = MutableStateFlow(false),
        /** 会话级流当前订阅目标；null = 未订阅。 */
        @Volatile var watching: String? = null
    )

    private val states = HashMap<String, SessionState>()

    private val _sessions = MutableStateFlow<List<SessionMeta>>(emptyList())
    val sessions: StateFlow<List<SessionMeta>> = _sessions

    private val _streamState = MutableStateFlow("")
    /** 当前订阅的连接状态（connecting/live/reconnecting/stopped/unauthorized），仅活动会话有意义。 */
    val streamState: StateFlow<String> = _streamState

    fun timeline(sessionId: String): StateFlow<List<TimelineItem>> = state(sessionId).flow

    /** 活动回合流（任意发起方；UI 据此显示停止按钮——桌面/定时任务的回合也能停）。 */
    fun activeTurnFlow(sessionId: String): StateFlow<String?> = state(sessionId).active

    /** 是否还有更早的历史可加载（会话页「加载更早」按钮）。 */
    fun hasOlderFlow(sessionId: String): StateFlow<Boolean> = state(sessionId).hasOlder

    private fun state(sessionId: String): SessionState = synchronized(states) {
        states.getOrPut(sessionId) {
            SessionState(builder = TimelineBuilder(), flow = MutableStateFlow(emptyList()))
        }
    }

    /** 刷新会话列表（进入首页 / 回到前台时调）。 */
    suspend fun refresh(client: DevaClient): ApiResult<Unit> =
        when (val r = client.sessions()) {
            is ApiResult.Ok -> {
                _sessions.value = r.value
                ApiResult.Ok(Unit)
            }
            is ApiResult.Err -> r
        }

    /**
     * 进入会话：回填历史（已有内容则不重复拉；增量靠会话级 SSE 续传）。
     * force = replay_reset 后的整体回填：清掉流式增量重种。
     */
    suspend fun open(client: DevaClient, sessionId: String, force: Boolean = false): ApiResult<Unit> {
        val st = state(sessionId)
        if (!force && st.flow.value.isNotEmpty()) return ApiResult.Ok(Unit)
        return repopulate(client, sessionId)
    }

    /**
     * 整体重填(replay_reset 后 / 加载更早基础):先拉取,成功才重种——
     * 失败保留现有时间线不闪空白(审查 A1)。同时刷新 backfilledStart/hasOlder。
     */
    suspend fun repopulate(client: DevaClient, sessionId: String): ApiResult<Unit> {
        val st = state(sessionId)
        return when (val r = client.messages(sessionId)) {
            is ApiResult.Ok -> {
                st.builder.seedBackfill(r.value.messages)
                st.flow.value = st.builder.snapshot
                st.backfilledStart = r.value.start
                st.hasOlder.value = r.value.start > 0
                ApiResult.Ok(Unit)
            }
            is ApiResult.Err -> r
        }
    }

    /** 加载更早的历史（「加载更早」按钮；前插，不动流式增量）。每次向前翻一页(400)。 */
    suspend fun loadOlder(sessionId: String): ApiResult<Unit> {
        val st = state(sessionId)
        val start = st.backfilledStart
        if (start <= 0) return ApiResult.Ok(Unit)
        val client = clientProvider() ?: return ApiResult.Err("未连接服务器")
        return when (val r = client.messages(sessionId, start = 0, limit = start)) {
            is ApiResult.Ok -> {
                // 桌面返回 [0, k) 的更早区间(k ≤ limit 上限);剩余部分留给下一次点击
                val older = r.value.messages
                st.builder.prependBackfill(older)
                st.backfilledStart = older.size
                st.hasOlder.value = st.backfilledStart > 0
                st.flow.value = st.builder.snapshot
                ApiResult.Ok(Unit)
            }
            is ApiResult.Err -> r
        }
    }

    /**
     * 本机发送成功后调：乐观上屏用户气泡、标记本回合（ownTurns：turn_start 不重复画）。
     * 会话级流若未订阅则立即订阅（正常情况下进入会话时已订阅）。
     * onReplayReset 在 SSE 线程回调（调用方自行切协程做整体回填）。
     */
    fun sendStarted(sessionId: String, turnId: String, text: String, onReplayReset: () -> Unit) {
        val st = state(sessionId)
        st.builder.addUser(text)
        st.flow.value = st.builder.snapshot
        st.active.value = turnId
        st.ownTurns.add(turnId)
        st.pendingSendText = null // 响应已回:在途标记清零,turn_start 去重交给 ownTurns
        if (st.watching != sessionId) watchSession(sessionId, onReplayReset)
    }

    /** 用户点发送即调（send 网络飞行前）；失败 / 忙时插入路径调 clearSending 清零。 */
    fun markSending(sessionId: String, text: String) {
        state(sessionId).pendingSendText = text
    }

    /** 发送未成立（Err / 忙时插入无新回合）：清在途标记。 */
    fun clearSending(sessionId: String) {
        state(sessionId).pendingSendText = null
    }

    /**
     * 订阅会话级 SSE（设计 §3.3 通用化修订）：进入会话即调，任意发起方的回合实时可见。
     * 已订阅则幂等跳过。帧在 SSE 线程到达：builder 同步化，flow 赋值线程安全。
     */
    fun watchSession(sessionId: String, onReplayReset: () -> Unit) {
        val st = state(sessionId)
        if (st.watching == sessionId) return
        st.watching = sessionId
        stream.start(
            sessionId,
            onFrame = { f -> onSessionFrame(sessionId, f) },
            onReplayReset = {
                // 缓冲已断:不清屏——回调方拉取成功才重种,失败保留现状(审查 A1)
                onReplayReset()
            },
            onState = { s -> _streamState.value = s }
        )
    }

    /** 会话级流的一帧：active 标记 + builder 渲染 + 交付清单补拉。SSE 线程调用。 */
    private fun onSessionFrame(sessionId: String, f: SseFrame) {
        val st = state(sessionId)
        val type = f.data.optString("type")
        val turnId = f.data.optString("turnId")
        // 回合发现（验收线 4）：任意发起方的 turn_start 都置 active（停止按钮出现）；
        // 对应 done 清位。流式增量在 done 前持续到达。
        when (type) {
            "turn_start" -> if (turnId.isNotEmpty()) st.active.value = turnId
            "done" -> if (turnId.isNotEmpty() && turnId == st.active.value) st.active.value = null
        }
        val own = st.ownTurns.contains(turnId) ||
            // turn_start 先于 send 响应到达:据文本相等识别本机在途回合,不再重复画气泡
            (st.pendingSendText?.let { t -> t.isNotEmpty() && f.data.optJSONObject("user")?.optString("text") == t } == true)
        st.builder.onChatEvent(f.data, isOwnTurn = own)
        // delta 合帧（~30fps）上屏；其余帧立即上屏（发射本身带上已累积的 delta）
        if (type == "text_delta" || type == "thinking_delta") scheduleDeltaFlush(sessionId)
        else st.flow.value = st.builder.snapshot
        // present_files 成功：清单补拉（toolUseId = 调用 id）；失败把卡标成 failed 保留重试入口
        if (type == "tool_result" &&
            f.data.optString("name") == "present_files" &&
            !f.data.optBoolean("isError")
        ) {
            fetchDeliveries(sessionId, f.data.optString("id"))
        }
    }

    /** delta 合帧的节拍：CAS 保证同一时刻只有一个在飞发射（33ms ≈ 30fps）。 */
    private fun scheduleDeltaFlush(sessionId: String) {
        if (!deltaFlushPending.compareAndSet(false, true)) return
        ioScope.launch {
            delay(33)
            deltaFlushPending.set(false)
            val st = state(sessionId)
            st.flow.value = st.builder.snapshot
        }
    }

    /** /deliveries 补拉（IO 协程；结果回填走 builder 的同步方法，Err 把卡标成 failed 保留提示）。 */
    private fun fetchDeliveries(sessionId: String, toolUseId: String, force: Boolean = false) {
        if (toolUseId.isEmpty() || (!force && !fetched.add(toolUseId))) return
        ioScope.launch {
            val client = clientProvider() ?: return@launch
            when (val r = client.deliveries(sessionId, toolUseId)) {
                is ApiResult.Ok -> attach(sessionId, toolUseId, r.value, failed = false)
                is ApiResult.Err -> attach(sessionId, toolUseId, emptyList(), failed = true)
            }
        }
    }

    /** 失败交付卡的重试（UI 点「重试」调；绕过判重）。 */
    fun retryDeliveries(sessionId: String, toolUseId: String) {
        fetched.remove(toolUseId)
        fetchDeliveries(sessionId, toolUseId)
    }

    private fun attach(sessionId: String, toolUseId: String, files: List<DeliverableFile>, failed: Boolean) {
        val st = state(sessionId)
        st.builder.attachFiles(toolUseId, files, failed)
        st.flow.value = st.builder.snapshot
    }

    /** 停止当前订阅（离开会话时调；builder 与 lastEventId 保留，重进可续传）。 */
    fun pause() {
        stream.stop()
        // watching 清零:重进时重新订阅(Last-Event-ID 续传);在途发送标记一并清(离开即放弃归属)
        states.values.forEach {
            it.watching = null
            it.pendingSendText = null
        }
    }

    /** 活动回合（本会话正在运行的 turnId，任意发起方；null = 空闲）。 */
    fun currentTurn(sessionId: String): String? = state(sessionId).active.value
}
