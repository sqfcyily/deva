package zai.deva.android.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/** 统一返回：Err.message 已翻成人话文案，UI 可直接展示。 */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data class Err(val message: String) : ApiResult<Nothing>
}

data class SessionMeta(
    val id: String,
    val title: String,
    val personaId: String?,
    /** 角色展示名（服务端解析；null = 未绑定或角色已删除）。列表徽标用，无需角色清单接口。 */
    val personaName: String?,
    /** 聚焦工作区目录（绝对路径；null = 全机通用）。列表目录分组用。 */
    val focusRoot: String?,
    /** 有未决交互卡（ask/plan 等你作答）——列表「待操作」角标。 */
    val pendingCard: Boolean,
    /** 本对话当前固定的模型引用 "providerId:modelId"（null = 跟随全局默认）。 */
    val model: String?,
    /** 本对话当前固定的思考等级。 */
    val effort: String?,
    /** 最后一条可见消息摘要（服务端投影，≤120 字符；null = 空会话）。 */
    val lastMessage: String?,
    val updatedAt: Long,
    val busy: Boolean,
    val archived: Boolean
)

/** 交付文件条目（present_files；路径来自桌面会话边车 delivered，与桌面交付卡同源）。 */
data class DeliverableFile(val path: String, val name: String, val size: Long?, val isImage: Boolean)

/** 回填条目里的未决交互卡（服务端只回填 ask / plan 两种；mount 不入历史）。 */
data class BackfillCard(val kind: String, val key: String, val questions: List<AskQuestion>, val plan: String)

/** /api/sessions/:id/messages 的回填条目（服务端 projectMessages 的投影，见 channel-server/server.ts）。 */
data class BackfillMsg(
    val i: Int,
    val role: String,
    val text: String?,
    val tools: List<String>,
    val attachments: Int,
    val card: BackfillCard? = null,
    val files: List<DeliverableFile> = emptyList()
)

data class Backfill(val total: Int, val start: Int, val messages: List<BackfillMsg>)

data class PairSuccess(val deviceId: String, val token: String)

/** 启用中的角色（GET /api/personas）。 */
data class PersonaInfo(val id: String, val name: String, val description: String)

/** 定时任务只读条目（GET /api/tasks）。 */
data class TaskInfo(
    val id: String,
    val title: String,
    val status: String,
    val scheduleKind: String,
    val scheduleAt: String?,
    val scheduleCron: String?,
    /** 服务端本地化的人读日程（previewSchedule）。 */
    val scheduleText: String,
    /** 绑定会话 id（任务在其对话追加轮次；null = 独立）。 */
    val sessionId: String?
)

/** 可用模型（GET /api/models）。ref 可直接用于 send 的 modelRef。 */
data class ModelInfo(val ref: String, val name: String, val provider: String)

data class ModelsResult(val models: List<ModelInfo>, val active: String?)

data class ServerInfo(
    val version: String,
    val hostname: String,
    val platform: String,
    val firstRun: Boolean,
    /** 服务端协议版本（设计 §3.3 版本化）：pair 与 /api/info 均携带。 */
    val protocol: Int
)

/**
 * HTTP 客户端（设计 §3.3 的 REST 面）：配对、info、sessions、messages、send、abort。
 * 传输用 OkHttp + 原生 org.json（设计 §4，不引序列化框架）。
 * 除 pair 外全部带 Authorization: Bearer <token>；错误统一翻成人话文案。
 */
class DevaClient(
    private val baseUrl: String,
    /** token 取自 SecureStore；未配对时为 null，只有 pair 可用。 */
    private val tokenProvider: () -> String?,
    /** 可注入共享 client（AppGraph 复用连接池）；缺省自建。实际超时以注入值为准（AppGraph 用 10/10/10）。 */
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
) {

    suspend fun pair(code: String, deviceName: String): ApiResult<PairSuccess> {
        val body = JSONObject().put("code", code.trim()).put("deviceName", deviceName.trim())
        return when (val r = request("POST", "/api/pair", body, auth = false)) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("配对响应为空。")
                ApiResult.Ok(PairSuccess(deviceId = o.getString("deviceId"), token = o.getString("token")))
            }
            is ApiResult.Err -> r
        }
    }

    suspend fun info(): ApiResult<ServerInfo> =
        when (val r = request("GET", "/api/info")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                ApiResult.Ok(
                    ServerInfo(
                        version = o.optString("version"),
                        hostname = o.optString("hostname"),
                        platform = o.optString("platform"),
                        firstRun = o.optBoolean("firstRun"),
                        protocol = o.optInt("protocol", 1)
                    )
                )
            }
            is ApiResult.Err -> r
        }

    suspend fun sessions(): ApiResult<List<SessionMeta>> =
        when (val r = request("GET", "/api/sessions")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                val arr = o.optJSONArray("sessions") ?: JSONArray()
                val list = (0 until arr.length()).mapNotNull { i ->
                    val s = arr.optJSONObject(i) ?: return@mapNotNull null
                    SessionMeta(
                        id = s.getString("id"),
                        title = s.optString("title"),
                        personaId = s.optString("personaId").takeIf { it.isNotEmpty() },
                        personaName = s.optString("personaName").takeIf { it.isNotEmpty() },
                        focusRoot = s.optString("focusRoot").takeIf { it.isNotEmpty() },
                        pendingCard = s.optBoolean("pendingCard"),
                        model = s.optString("model").takeIf { it.isNotEmpty() },
                        effort = s.optString("effort").takeIf { it.isNotEmpty() },
                        lastMessage = s.optString("lastMessage").takeIf { it.isNotEmpty() },
                        updatedAt = s.optLong("updatedAt"),
                        busy = s.optBoolean("busy"),
                        archived = s.optBoolean("archived")
                    )
                }
                ApiResult.Ok(list)
            }
            is ApiResult.Err -> r
        }

    /**
     * 新建空会话，返回会话 id。personaId 可选（新建即选定角色；沿桌面语义，首发落库后绑定不再改）。
     */
    suspend fun createSession(personaId: String? = null): ApiResult<String> {
        val body = if (personaId != null) JSONObject().put("personaId", personaId) else JSONObject()
        return when (val r = request("POST", "/api/sessions", body)) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                ApiResult.Ok(o.getString("id"))
            }
            is ApiResult.Err -> r
        }
    }

    /** 单会话元信息（含当前 model/effort/focusRoot/pendingCard；带 query 不需要）。 */
    suspend fun sessionMeta(sessionId: String): ApiResult<SessionMeta> =
        when (val r = request("GET", "/api/sessions/${enc(sessionId)}")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                ApiResult.Ok(
                    SessionMeta(
                        id = o.getString("id"),
                        title = o.optString("title"),
                        personaId = o.optString("personaId").takeIf { it.isNotEmpty() },
                        personaName = o.optString("personaName").takeIf { it.isNotEmpty() },
                        focusRoot = o.optString("focusRoot").takeIf { it.isNotEmpty() },
                        pendingCard = o.optBoolean("pendingCard"),
                        model = o.optString("model").takeIf { it.isNotEmpty() },
                        effort = o.optString("effort").takeIf { it.isNotEmpty() },
                        lastMessage = o.optString("lastMessage").takeIf { it.isNotEmpty() },
                        updatedAt = o.optLong("updatedAt"),
                        busy = o.optBoolean("busy"),
                        archived = o.optBoolean("archived")
                    )
                )
            }
            is ApiResult.Err -> r
        }

    /** 启用中的角色清单。 */
    suspend fun personas(): ApiResult<List<PersonaInfo>> =
        when (val r = request("GET", "/api/personas")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                val arr = o.optJSONArray("personas") ?: JSONArray()
                ApiResult.Ok(
                    (0 until arr.length()).mapNotNull { i ->
                        arr.optJSONObject(i)?.let {
                            PersonaInfo(it.optString("id"), it.optString("name"), it.optString("description"))
                        }
                    }
                )
            }
            is ApiResult.Err -> r
        }

    /** 定时任务只读清单。 */
    suspend fun tasks(): ApiResult<List<TaskInfo>> =
        when (val r = request("GET", "/api/tasks")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                val arr = o.optJSONArray("tasks") ?: JSONArray()
                ApiResult.Ok(
                    (0 until arr.length()).mapNotNull { i ->
                        val t = arr.optJSONObject(i) ?: return@mapNotNull null
                        val sch = t.optJSONObject("schedule")
                        TaskInfo(
                            id = t.getString("id"),
                            title = t.optString("title"),
                            status = t.optString("status", "active"),
                            scheduleKind = sch?.optString("kind") ?: "recurring",
                            scheduleAt = sch?.optString("at")?.takeIf { it.isNotEmpty() },
                            scheduleCron = sch?.optString("cron")?.takeIf { it.isNotEmpty() },
                            scheduleText = t.optString("scheduleText"),
                            sessionId = t.optString("sessionId").takeIf { it.isNotEmpty() }
                        )
                    }
                )
            }
            is ApiResult.Err -> r
        }

    /** 可用模型清单 + 当前全局默认 ref。 */
    suspend fun models(): ApiResult<ModelsResult> =
        when (val r = request("GET", "/api/models")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                val arr = o.optJSONArray("models") ?: JSONArray()
                val list = (0 until arr.length()).mapNotNull { i ->
                    arr.optJSONObject(i)?.let {
                        ModelInfo(it.optString("ref"), it.optString("name"), it.optString("provider"))
                    }
                }
                ApiResult.Ok(ModelsResult(list, o.optString("active").takeIf { it.isNotEmpty() }))
            }
            is ApiResult.Err -> r
        }

    /** 重命名对话（空标题 = 恢复自动派生）。返回落库后的最终标题。 */
    suspend fun renameSession(sessionId: String, title: String): ApiResult<String> =
        when (val r = request("POST", "/api/sessions/${enc(sessionId)}/rename", JSONObject().put("title", title))) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                ApiResult.Ok(o.optString("title"))
            }
            is ApiResult.Err -> r
        }

    /** 删除对话（成员会话一并删；其中运行的定时任务改为独立运行）。 */
    suspend fun deleteSession(sessionId: String): ApiResult<Unit> =
        when (val r = request("DELETE", "/api/sessions/${enc(sessionId)}")) {
            is ApiResult.Ok -> ApiResult.Ok(Unit)
            is ApiResult.Err -> r
        }

    /** 历史回填（进入会话时调；start 缺省 = 服务端给最新一段）。 */
    suspend fun messages(sessionId: String, start: Int? = null, limit: Int = 400): ApiResult<Backfill> {
        val q = StringBuilder("/api/sessions/").append(enc(sessionId)).append("/messages?limit=").append(limit)
        if (start != null) q.append("&start=").append(start)
        return when (val r = request("GET", q.toString())) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                val arr = o.optJSONArray("messages") ?: JSONArray()
                val list = (0 until arr.length()).mapNotNull { i ->
                    val m = arr.optJSONObject(i) ?: return@mapNotNull null
                    val tools = mutableListOf<String>()
                    val tarr = m.optJSONArray("tools")
                    if (tarr != null) for (j in 0 until tarr.length()) tools.add(tarr.optString(j))
                    val card = m.optJSONObject("card")?.let { c ->
                        BackfillCard(
                            kind = c.optString("kind"),
                            key = c.optString("key"),
                            questions = parseQuestions(c.optJSONArray("questions")),
                            plan = c.optString("plan")
                        )
                    }
                    val farr = m.optJSONArray("files")
                    val files = (0 until (farr?.length() ?: 0)).mapNotNull { j ->
                        farr?.optJSONObject(j)?.let { f ->
                            DeliverableFile(
                                path = f.optString("path"),
                                name = f.optString("name"),
                                size = if (f.isNull("size")) null else f.optLong("size"),
                                isImage = f.optBoolean("image")
                            )
                        }
                    }
                    BackfillMsg(
                        i = m.optInt("i"),
                        role = m.optString("role"),
                        text = m.optString("text").takeIf { it.isNotEmpty() },
                        tools = tools,
                        attachments = m.optInt("attachments", 0),
                        card = card,
                        files = files
                    )
                }
                ApiResult.Ok(Backfill(total = o.optInt("total"), start = o.optInt("start"), messages = list))
            }
            is ApiResult.Err -> r
        }
    }

    /**
     * 发消息。返回本轮 turnId;会话忙时服务端回退为「插入进行中的任务」,
     * 返回空串(turnId 缺失)——调用方按空串提示,不再发起新回合。
     * attachments 为 /api/attachments 返回的服务端路径(忙时插入只带正文,附件被丢弃——与桌面/IM 同语义)。
     */
    suspend fun send(
        sessionId: String,
        text: String,
        attachments: List<String> = emptyList(),
        modelRef: String? = null
    ): ApiResult<String> {
        val body = JSONObject().put("text", text)
        if (attachments.isNotEmpty()) body.put("attachments", JSONArray(attachments))
        if (modelRef != null) body.put("modelRef", modelRef)
        return when (val r = request("POST", "/api/sessions/${enc(sessionId)}/send", body)) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                ApiResult.Ok(o.optString("turnId"))
            }
            is ApiResult.Err -> r
        }
    }

    /**
     * 上传附件字节（设备端只交字节、不交路径）：服务端落盘并登记白名单，
     * 返回的路径仅供 send 的 attachments[] 使用。
     */
    suspend fun uploadAttachment(bytes: ByteArray, name: String): ApiResult<String> =
        withContext(Dispatchers.IO) {
            val b = Request.Builder()
                .url(baseUrl + "/api/attachments?name=" + enc(name))
                .post(bytes.toRequestBody("application/octet-stream".toMediaType()))
            tokenProvider()?.takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
            try {
                http.newCall(b.build()).execute().use { resp ->
                    val text = resp.body?.string() ?: ""
                    if (resp.code == 401) return@withContext ApiResult.Err("未配对或凭据无效，请重新配对。")
                    val json: JSONObject? = if (text.isNotEmpty()) {
                        try {
                            JSONObject(text)
                        } catch (_: Exception) {
                            null
                        }
                    } else {
                        null
                    }
                    if (!resp.isSuccessful) {
                        ApiResult.Err(
                            json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "上传失败（HTTP ${resp.code}）。"
                        )
                    } else {
                        val path = json?.optString("path")?.takeIf { it.isNotEmpty() }
                        if (path == null) ApiResult.Err("上传响应缺少路径。") else ApiResult.Ok(path)
                    }
                }
            } catch (e: IOException) {
                ApiResult.Err("连不上服务器：${e.message ?: "网络错误"}")
            }
        }

    suspend fun abort(turnId: String): ApiResult<Unit> =
        when (val r = request("POST", "/api/turns/${enc(turnId)}/abort", JSONObject())) {
            is ApiResult.Ok -> ApiResult.Ok(Unit)
            is ApiResult.Err -> r
        }

    /** 归档 / 取消归档会话（桌面忙时归档回 409，走 Err 返回）。 */
    suspend fun setArchived(sessionId: String, archived: Boolean): ApiResult<Unit> =
        when (val r = request("POST", "/api/sessions/${enc(sessionId)}/archive", JSONObject().put("archived", archived))) {
            is ApiResult.Ok -> ApiResult.Ok(Unit)
            is ApiResult.Err -> r
        }

    /**
     * 自助吊销本设备（凭当前 Bearer token 自证身份）：服务端走 removeDevice 全套清理，
     * 成功后本地凭据即失效——调用方需清本地 token 与 deviceId 并引导重新配对。
     */
    suspend fun selfRevoke(): ApiResult<Unit> =
        when (val r = request("POST", "/api/devices/self", JSONObject())) {
            is ApiResult.Ok -> ApiResult.Ok(Unit)
            is ApiResult.Err -> r
        }

    /**
     * 交互卡作答（设计 §3.3）：kind = ask / plan / mount，payload 形状随 kind
     * （ask: {answers: string[]|null}；plan: {decision, feedback?}；mount: {path: string|null}）。
     * 服务端 409（卡已结束/不存在）走 Err 返回。
     */
    suspend fun answer(sessionId: String, key: String, kind: String, payload: JSONObject): ApiResult<Unit> {
        val body = JSONObject().put("key", key).put("kind", kind).put("payload", payload)
        return when (val r = request("POST", "/api/sessions/${enc(sessionId)}/answer", body)) {
            is ApiResult.Ok -> ApiResult.Ok(Unit)
            is ApiResult.Err -> r
        }
    }

    /** 一次 present_files 交付的文件清单（直播回合收到 tool_result 后补拉；回填口已内嵌 files）。 */
    suspend fun deliveries(sessionId: String, toolUseId: String): ApiResult<List<DeliverableFile>> =
        when (val r = request("GET", "/api/sessions/${enc(sessionId)}/deliveries?toolUseId=${enc(toolUseId)}")) {
            is ApiResult.Ok -> {
                val o = r.value ?: return ApiResult.Err("响应为空。")
                val arr = o.optJSONArray("files") ?: JSONArray()
                ApiResult.Ok(
                    (0 until arr.length()).mapNotNull { i ->
                        val f = arr.optJSONObject(i) ?: return@mapNotNull null
                        DeliverableFile(
                            path = f.optString("path"),
                            name = f.optString("name"),
                            size = if (f.isNull("size")) null else f.optLong("size"),
                            isImage = f.optBoolean("image")
                        )
                    }
                )
            }
            is ApiResult.Err -> r
        }

    /**
     * 下载交付文件到 sink（流式，不整载进内存；设计 §5-5 落到 Downloads/Deva/）。
     * 服务端只放行该会话边车 delivered 里的路径（403 = 不在白名单）。
     */
    suspend fun download(path: String, sessionId: String, sink: OutputStream): ApiResult<Unit> =
        fetchFile(path, sessionId) { resp ->
            resp.body?.byteStream()?.use { src -> src.copyTo(sink) }
        }

    /** 取文件字节（图片内联预览用；cap 之外直接报错，不无界读）。 */
    suspend fun fileBytes(path: String, sessionId: String, cap: Long = 25L * 1024 * 1024): ApiResult<ByteArray> =
        fetchFile(path, sessionId) { resp ->
            val body = resp.body ?: return@fetchFile ByteArray(0)
            if ((body.contentLength().takeIf { it > 0 } ?: Long.MAX_VALUE) > cap)
                throw IOException("文件超过预览上限")
            body.bytes()
        }

    private suspend fun <T> fetchFile(
        path: String,
        sessionId: String,
        consume: (okhttp3.Response) -> T
    ): ApiResult<T> = withContext(Dispatchers.IO) {
        val b = Request.Builder()
            .url(baseUrl + "/api/files?path=" + enc(path) + "&session=" + enc(sessionId))
            .get()
        tokenProvider()?.takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
        try {
            http.newCall(b.build()).execute().use { resp ->
                when {
                    resp.code == 401 -> ApiResult.Err("未配对或凭据无效，请重新配对。")
                    resp.code == 403 -> ApiResult.Err("只允许下载该对话交付过的文件。")
                    resp.code == 404 -> ApiResult.Err("文件不存在或已被移动。")
                    !resp.isSuccessful -> ApiResult.Err("下载失败（HTTP ${resp.code}）。")
                    else ->
                        try {
                            ApiResult.Ok(consume(resp))
                        } catch (e: IOException) {
                            ApiResult.Err("下载中断：${e.message ?: "网络错误"}")
                        }
                }
            }
        } catch (e: IOException) {
            ApiResult.Err("连不上服务器：${e.message ?: "网络错误"}")
        }
    }

    // ── 内部 ──

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    private suspend fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        auth: Boolean = true
    ): ApiResult<JSONObject?> = withContext(Dispatchers.IO) {
        val b = Request.Builder().url(baseUrl + path)
        when (method) {
            "GET" -> b.get()
            else -> b.method(
                method,
                (body?.toString() ?: "{}").toRequestBody("application/json; charset=utf-8".toMediaType())
            )
        }
        if (auth) tokenProvider()?.takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
        try {
            http.newCall(b.build()).execute().use { resp ->
                val text = resp.body?.string() ?: ""
                if (resp.code == 401) return@withContext ApiResult.Err("未配对或凭据无效，请重新配对。")
                val json: JSONObject? = if (text.isNotEmpty()) {
                    try {
                        JSONObject(text)
                    } catch (_: Exception) {
                        null
                    }
                } else {
                    null
                }
                if (!resp.isSuccessful) {
                    ApiResult.Err(json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "请求失败（HTTP ${resp.code}）。")
                } else {
                    ApiResult.Ok(json)
                }
            }
        } catch (e: IOException) {
            ApiResult.Err("连不上服务器：${e.message ?: "网络错误"}")
        }
    }
}
