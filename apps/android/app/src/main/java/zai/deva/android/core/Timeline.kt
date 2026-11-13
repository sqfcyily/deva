package zai.deva.android.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * 时间线条目的稳定 key（LazyColumn items(key = it.uid) 用）：进程内计数器唯一即可——
 * 同一条目跨快照恒定（增量走 data class copy 保留 uid），列表结构变化时 Compose 按内容
 * 同一性做局部重组，不再做全列表位置 diff（审查遗留 #13：位置同一性）。
 */
private val itemSeq = java.util.concurrent.atomic.AtomicInteger(0)
internal fun nextItemId(): String = "ti${itemSeq.incrementAndGet()}"

/** 问答卡的单题（与桌面 AskQuestion 同形：题干 + 候选项 + 多选 + 必答）。 */
data class AskQuestion(val question: String, val options: List<String>, val multi: Boolean, val required: Boolean)

/** 三类交互卡的载荷（设计 §5-4）。key = 交互工具的 toolUseId，作答时原样带回。 */
sealed interface CardPayload {
    val key: String

    data class Ask(override val key: String, val questions: List<AskQuestion>) : CardPayload
    data class Plan(override val key: String, val plan: String) : CardPayload
    data class Mount(override val key: String, val tool: String, val path: String, val member: String?) : CardPayload
}

/**
 * 事件折叠成时间线（设计 §4）：ChatStreamEvent 流 → 正文/思考/工具/卡片/交付物五类节点。
 * 事件类型全集见设计 §3.4（与桌面端 ChatStreamEvent 同形）；未知类型忽略并计数，不抛异常。
 * P2 覆盖：text_delta / thinking_delta / tool_call / tool_result / turn_start / error / done。
 * P3 覆盖：ask_user / plan_review / mount_request 三类卡 + interaction_resolved 收起。
 * P4 覆盖：present_files 交付卡（tool_result 升格 + /deliveries 清单回填）。
 *
 * uid 是列表稳定 key（缺省自动分配；Tool.id 是工具调用 id，勿混）。
 */
sealed interface TimelineItem {
    val uid: String

    data class Text(val text: String, val fromUser: Boolean, override val uid: String = nextItemId()) : TimelineItem
    data class Thinking(val text: String, override val uid: String = nextItemId()) : TimelineItem
    /** summary = null 表示工具还在跑（「正在…」）；tool_result 到达后定格。 */
    data class Tool(
        val id: String,
        val name: String,
        val summary: String?,
        override val uid: String = nextItemId()
    ) : TimelineItem
    /** resolved = null 未决（可作答）；否则为收起后的一句话终态（已作答 / 已批准 / 已取消…）。 */
    data class Card(val payload: CardPayload, val resolved: String?, override val uid: String = nextItemId()) : TimelineItem
    /** 系统提示行（usage / insert / auto_retry / todos 等小事件，设计 §3.4 最小映射集）。 */
    data class Note(val text: String, override val uid: String = nextItemId()) : TimelineItem
    /**
     * 交付文件卡（present_files，设计 §5-5）。files 为空且未失败 = 清单加载中；
     * failed = 清单没拉到（保留可重试的空卡）。
     */
    data class Deliverable(
        val toolUseId: String,
        val files: List<DeliverableFile>,
        val failed: Boolean = false,
        override val uid: String = nextItemId()
    ) : TimelineItem
    data class Error(val message: String, override val uid: String = nextItemId()) : TimelineItem
}

/**
 * 折叠器：/messages 回填种子 + SSE chat 帧增量 → 展示列表。
 * SSE 帧在 EventStream 线程到达、UI 在主线程读快照，方法全部同步化。
 */
class TimelineBuilder {

    private val items = mutableListOf<TimelineItem>()
    var unknownEvents = 0
        private set

    val snapshot: List<TimelineItem>
        @Synchronized get() = items.toList()

    /** 当前未决卡数（>0 = Waiting 态：输入框禁用，设计 §4 状态机）。 */
    val pendingCards: Int
        @Synchronized get() = items.count { it is TimelineItem.Card && it.resolved == null }

    /** 历史回填种子（进入会话时调一次；重连 replay_reset 后 force 重种前先 clear）。 */
    @Synchronized
    fun seedBackfill(msgs: List<BackfillMsg>) {
        items.clear()
        for (m in msgs) items.addAll(renderBackfill(m))
    }

    /** 加载更早：把更早区间前插到列表头部（流式增量在尾部，不受影响）。 */
    @Synchronized
    fun prependBackfill(msgs: List<BackfillMsg>) {
        val addition = msgs.flatMap { renderBackfill(it) }
        items.addAll(0, addition)
    }

    /** 回填条目 → 展示节点（seed 与 prepend 共用）。 */
    private fun renderBackfill(m: BackfillMsg): List<TimelineItem> {
        val out = mutableListOf<TimelineItem>()
        if (m.role == "user") {
            m.text?.let { out.add(TimelineItem.Text(it, fromUser = true)) }
        } else {
            m.text?.let { out.add(TimelineItem.Text(it, fromUser = false)) }
            for (t in m.tools) out.add(TimelineItem.Tool(id = "hist:$t", name = t, summary = "已完成"))
            // 交付卡随历史还原（服务端已把 present_files 从 tools 里剔除，此处独立成卡）
            if (m.files.isNotEmpty()) out.add(TimelineItem.Deliverable("hist:${m.i}", m.files))
            if (m.attachments > 0) {
                out.add(TimelineItem.Text("（含 ${m.attachments} 个附件）", fromUser = m.role == "user"))
            }
            // 未决卡随历史还原（已答的卡服务端不回填，只留普通工具行）
            m.card?.let { out.add(TimelineItem.Card(it.toPayload(), resolved = null)) }
        }
        return out
    }

    /** 本机发出的消息：send 成功后乐观上屏（同回合的 turn_start 据此去重）。 */
    @Synchronized
    fun addUser(text: String) {
        items.add(TimelineItem.Text(text, fromUser = true))
    }

    /**
     * 处理一帧 chat 事件（data 已平铺 sessionId/turnId，形状同服务端 sse.ts）。
     * isOwnTurn = 本帧 turnId 是本机发起的那一轮：turn_start 不再重复画用户气泡。
     */
    @Synchronized
    fun onChatEvent(data: JSONObject, isOwnTurn: Boolean) {
        when (data.optString("type")) {
            "text_delta" -> appendToLastAssistant(data.optString("text"))
            "thinking_delta" -> appendThinking(data.optString("text"))
            "tool_call" -> items.add(
                TimelineItem.Tool(
                    id = data.optString("id"),
                    name = data.optString("name"),
                    summary = null
                )
            )
            "tool_result" -> {
                val id = data.optString("id")
                // 交付完成：present_files 的成功结果整行升格为交付卡（清单随后由 /deliveries 补齐）
                if (data.optString("name") == "present_files" && !data.optBoolean("isError")) {
                    promoteToDeliverable(id)
                } else {
                    finishTool(id, (if (data.optBoolean("isError")) "✗ " else "") + data.optString("summary"))
                }
            }
            "turn_start" -> {
                if (isOwnTurn) return // 自己发起的：发送时已乐观上屏
                val user = data.optJSONObject("user") ?: return
                // notify/quiet 轮不是用户说的话（后台任务通知/成员交差唤醒；桌面画系统行或不显示）：
                // 与回填口径一致不画用户气泡（引擎标记消息在投影侧已过滤），active/busy 置位在 SessionStore 不受影响
                if (user.optBoolean("notify") || user.optBoolean("quiet")) return
                val text = user.optString("text")
                if (text.isNotEmpty()) items.add(TimelineItem.Text(text, fromUser = true))
            }
            "ask_user" -> {
                val key = data.optString("key")
                val qs = parseQuestions(data.optJSONArray("questions"))
                if (key.isNotEmpty() && qs.isNotEmpty()) items.add(TimelineItem.Card(CardPayload.Ask(key, qs), resolved = null))
            }
            "plan_review" -> {
                val key = data.optString("key")
                val plan = data.optString("plan")
                if (key.isNotEmpty() && plan.isNotEmpty()) items.add(TimelineItem.Card(CardPayload.Plan(key, plan), resolved = null))
            }
            "mount_request" -> {
                val key = data.optString("key")
                if (key.isNotEmpty())
                    items.add(
                        TimelineItem.Card(
                            CardPayload.Mount(
                                key,
                                tool = data.optString("tool"),
                                path = data.optString("path"),
                                member = data.optString("member").takeIf { it.isNotEmpty() }
                            ),
                            resolved = null
                        )
                    )
            }
            "interaction_resolved" -> resolveCard(data)
            "stream_reset" -> dropStepPartial()
            "insert" -> {
                val text = data.optString("text")
                if (text.isNotEmpty()) items.add(TimelineItem.Note("↩ 插入：$text"))
            }
            "auto_retry" -> {
                val attempt = data.optInt("attempt", 0)
                val max = data.optInt("max", 0)
                items.add(TimelineItem.Note(if (max > 0) "⚠ 自动重试中（$attempt/$max）…" else "⚠ 自动重试中…"))
            }
            "todos" -> {
                // 设计 §3.4 最小映射集：待办清单只读展示（active=null = 全部完成/取消，撤下节点）
                val active = data.optJSONObject("state")?.optJSONObject("active")
                val todoIdx = items.indexOfFirst { it is TimelineItem.Note && it.text.startsWith("☐") }
                if (active == null) {
                    if (todoIdx >= 0) items.removeAt(todoIdx)
                } else {
                    val title = active.optString("title")
                    val lines = StringBuilder()
                    val itemsArr = active.optJSONArray("items") ?: org.json.JSONArray()
                    for (i in 0 until itemsArr.length()) {
                        val item = itemsArr.optJSONObject(i) ?: continue
                        val mark = when (item.optString("status")) {
                            "completed" -> "☑"
                            "in_progress" -> "▶"
                            else -> "☐"
                        }
                        lines.append('\n').append(mark).append(' ').append(item.optString("content"))
                    }
                    val node = TimelineItem.Note("☐ $title${lines}")
                    if (todoIdx >= 0) items[todoIdx] = node else items.add(node)
                }
            }
            "usage" -> {
                val input = data.optLong("input", -1)
                val output = data.optLong("output", -1)
                if (input >= 0 && output >= 0) items.add(TimelineItem.Note("ℹ 用量：输入 $input · 输出 $output tokens"))
            }
            "error" -> items.add(TimelineItem.Error(data.optString("message")))
            // done / usage / todos / compacted 等：P2 不展示（done 由 SessionStore 消费以收尾状态）
            else -> unknownEvents++
        }
    }

    /** interaction_resolved：把同键的未决卡收成已决态（答复来自桌面还是手机端都一样，先到先收）。 */
    private fun resolveCard(data: JSONObject) {
        val key = data.optString("key")
        val idx = items.indexOfLast { it is TimelineItem.Card && it.payload.key == key && it.resolved == null }
        if (idx < 0) return
        val card = items[idx] as TimelineItem.Card
        val summary = when (data.optString("kind")) {
            "ask" -> if (data.has("answers") && !data.isNull("answers")) "已作答" else "已取消"
            "plan" -> when (data.optString("decision")) {
                "approve" -> "已批准并执行"
                "keep" -> "继续完善"
                else -> "已忽略"
            }
            "mount" -> if (data.has("path") && !data.isNull("path")) "已挂载" else "暂不挂载"
            else -> "已处理"
        }
        items[idx] = card.copy(resolved = summary)
    }

    private fun appendToLastAssistant(text: String) {
        if (text.isEmpty()) return
        val last = items.lastOrNull()
        if (last is TimelineItem.Text && !last.fromUser) {
            items[items.size - 1] = last.copy(text = last.text + text)
        } else {
            items.add(TimelineItem.Text(text, fromUser = false))
        }
    }

    private fun appendThinking(text: String) {
        if (text.isEmpty()) return
        val last = items.lastOrNull()
        if (last is TimelineItem.Thinking) {
            items[items.size - 1] = last.copy(text = last.text + text)
        } else {
            items.add(TimelineItem.Thinking(text))
        }
    }

    /** present_files 成功：把同 id 的「正在…」工具行就地换成加载态交付卡。 */
    private fun promoteToDeliverable(toolUseId: String) {
        val idx = items.indexOfLast { it is TimelineItem.Tool && it.id == toolUseId }
        if (idx >= 0) items[idx] = TimelineItem.Deliverable(toolUseId, files = emptyList())
        else items.add(TimelineItem.Deliverable(toolUseId, files = emptyList()))
    }

    /** 清单补齐 / 失败标记（SessionStore 拉完 /deliveries 后回填）。 */
    @Synchronized
    fun attachFiles(toolUseId: String, files: List<DeliverableFile>, failed: Boolean = false) {
        val idx = items.indexOfLast { it is TimelineItem.Deliverable && it.toolUseId == toolUseId }
        if (idx >= 0) {
            val d = items[idx] as TimelineItem.Deliverable
            items[idx] = d.copy(files = files, failed = failed)
        }
    }

    /**
     * stream_reset(桌面重连后重跑当前步骤):丢弃末尾本步的残缺 thinking/text——
     * 工具行、用户气泡、交互卡、交付卡、错误都是步骤边界,重跑会重新发完整内容。
     * 与桌面 dropStepPartial 同口径(边界后的残缺尾部,边界本身保留)。
     */
    private fun dropStepPartial() {
        var i = items.size - 1
        while (i >= 0) {
            when (val it = items[i]) {
                is TimelineItem.Thinking -> items.removeAt(i)
                is TimelineItem.Text -> if (!it.fromUser) items.removeAt(i) else return
                else -> return
            }
            i--
        }
    }

    private fun finishTool(id: String, summary: String) {
        val idx = items.indexOfLast { it is TimelineItem.Tool && it.id == id }
        if (idx >= 0) {
            val t = items[idx] as TimelineItem.Tool
            items[idx] = t.copy(summary = summary)
        }
    }
}

/** 回填条目里的未决卡（服务端 projectMessages 投影）→ 载荷。 */
fun BackfillCard.toPayload(): CardPayload = when (kind) {
    "plan" -> CardPayload.Plan(key, plan)
    else -> CardPayload.Ask(key, questions) // 服务端只回填 ask / plan 两种
}

/** 解析 questions 数组（SSE ask_user 事件与回填卡共用）。选项与桌面 AskOption 同形：{label, description?}。 */
internal fun parseQuestions(arr: JSONArray?): List<AskQuestion> {
    val out = mutableListOf<AskQuestion>()
    if (arr != null)
        for (i in 0 until arr.length()) {
            val q = arr.optJSONObject(i) ?: continue
            val opts = mutableListOf<String>()
            val oa = q.optJSONArray("options")
            if (oa != null)
                for (j in 0 until oa.length()) {
                    val label = when (val o = oa.opt(j)) {
                        is JSONObject -> o.optString("label")
                        is String -> o
                        null -> ""
                        else -> o.toString()
                    }
                    if (label.isNotEmpty()) opts.add(label)
                }
            out.add(
                AskQuestion(
                    question = q.optString("question"),
                    options = opts,
                    // 线上字段是 multi（桌面 AskQuestion 序列化名）；multiSelect 是模型入参名，兜一下旧形状
                    multi = q.optBoolean("multi") || q.optBoolean("multiSelect"),
                    required = q.optBoolean("required", true)
                )
            )
        }
    return out
}
