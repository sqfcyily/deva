package zai.deva.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import zai.deva.android.core.AskQuestion
import zai.deva.android.core.CardPayload
import zai.deva.android.core.TimelineItem

/** 可点区域下限（设计 §5：按钮/行 ≥44dp）。 */
private val MinTouch = Modifier.heightIn(min = 44.dp)

/**
 * 三类交互卡（设计 §5-4）：问答（单选/多选/自由输入）、计划审阅（批准/继续完善/取消）、
 * 挂载请求（选目录只能走桌面系统对话框，手机端提供「暂不挂载」，与远程通道同口径）。
 * Waiting 态下输入框禁用并提示「等待你在下方卡片中作答」（设计 §4 状态机）。
 * 作答成功后卡片由 interaction_resolved 帧收起（先到的答复生效，桌面手机同机制）。
 */
@Composable
fun CardRow(card: TimelineItem.Card, onAnswer: (kind: String, key: String, payload: JSONObject) -> Unit) {
    val resolved = card.resolved
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))
            .padding(12.dp)
    ) {
        Text(
            when (card.payload) {
                is CardPayload.Ask -> "❓ Deva 有问题想问你"
                is CardPayload.Plan -> "📋 计划审阅"
                is CardPayload.Mount -> "📁 请求挂载工作区"
            },
            style = MaterialTheme.typography.titleSmall
        )
        if (resolved != null) {
            // 已决态：先到的答复生效后，各端都把卡收成这一行（设计 §3.4 interaction_resolved）
            Text(
                "✓ $resolved",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = 4.dp)
            )
            return@Column
        }
        when (val p = card.payload) {
            is CardPayload.Ask -> AskCardBody(p, onAnswer)
            is CardPayload.Plan -> PlanCardBody(p, onAnswer)
            is CardPayload.Mount -> MountCardBody(p, onAnswer)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AskCardBody(p: CardPayload.Ask, onAnswer: (String, String, JSONObject) -> Unit) {
    // 每题：选中项集合 + 自由输入；提交时答案与题目对齐（answers[i] 对应第 i 题）
    val selected = remember { mutableStateOf(p.questions.map { setOf<String>() }) }
    val freeText = remember { mutableStateOf(p.questions.map { "" }) }
    var submitting by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        p.questions.forEachIndexed { qi, q -> QuestionBlock(qi, q, selected, freeText) }

        val allAnswered = p.questions.indices.all { i ->
            !p.questions[i].required || selected.value[i].isNotEmpty() || freeText.value[i].isNotBlank()
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                enabled = !submitting && allAnswered,
                modifier = MinTouch,
                onClick = {
                    submitting = true
                    val answers = JSONArray()
                    p.questions.indices.forEach { i ->
                        val free = freeText.value[i].trim()
                        answers.put(if (free.isNotEmpty()) free else selected.value[i].joinToString("、"))
                    }
                    onAnswer("ask", p.key, JSONObject().put("answers", answers))
                }
            ) { Text("提交") }
            OutlinedButton(onClick = { onAnswer("ask", p.key, JSONObject().put("answers", JSONObject.NULL)) }) {
                Text("取消")
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QuestionBlock(qi: Int, q: AskQuestion, selected: MutableState<List<Set<String>>>, freeText: MutableState<List<String>>) {
    Column {
        Text(
            "${qi + 1}. ${q.question}" + if (q.required) " *" else "（可跳过）",
            style = MaterialTheme.typography.bodyMedium
        )
        q.options.forEach { opt ->
            // 整行可点（不只点控件本身），可点区域 ≥44dp（设计 §5）
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .combinedClickable(onClick = {
                        selected.value = selected.value.toMutableList().also {
                            it[qi] = if (q.multi) {
                                if (opt in selected.value[qi]) selected.value[qi] - opt else selected.value[qi] + opt
                            } else {
                                setOf(opt)
                            }
                        }
                    })
            ) {
                when {
                    q.multi -> Checkbox(
                        checked = opt in selected.value[qi],
                        onCheckedChange = { on ->
                            selected.value = selected.value.toMutableList().also {
                                it[qi] = if (on) selected.value[qi] + opt else selected.value[qi] - opt
                            }
                        }
                    )
                    else -> RadioButton(
                        selected = opt in selected.value[qi],
                        onClick = { selected.value = selected.value.toMutableList().also { it[qi] = setOf(opt) } }
                    )
                }
                Text(opt, style = MaterialTheme.typography.bodyMedium)
            }
        }
        OutlinedTextField(
            value = freeText.value[qi],
            onValueChange = { v -> freeText.value = freeText.value.toMutableList().also { it[qi] = v } },
            label = { Text(if (q.options.isEmpty()) "输入你的回答" else "或自己输入") },
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            textStyle = MaterialTheme.typography.bodyMedium,
            singleLine = true
        )
    }
}

@Composable
private fun PlanCardBody(p: CardPayload.Plan, onAnswer: (String, String, JSONObject) -> Unit) {
    var keepMode by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            p.plan,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 260.dp)
                .verticalScroll(rememberScrollState())
                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
                .padding(8.dp)
        )
        if (keepMode) {
            OutlinedTextField(
                value = feedback,
                onValueChange = { feedback = it },
                label = { Text("想让它怎么改？（可留空，之后用消息补充）") },
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        onAnswer("plan", p.key, JSONObject().put("decision", "keep").put("feedback", feedback))
                    },
                    modifier = MinTouch
                ) { Text("发送修改意见") }
                OutlinedButton(onClick = { keepMode = false }, modifier = MinTouch) { Text("返回") }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onAnswer("plan", p.key, JSONObject().put("decision", "approve")) },
                    modifier = MinTouch
                ) {
                    Text("批准并执行")
                }
                OutlinedButton(onClick = { keepMode = true }, modifier = MinTouch) { Text("继续完善") }
                OutlinedButton(
                    onClick = { onAnswer("plan", p.key, JSONObject().put("decision", "ignore")) },
                    modifier = MinTouch
                ) {
                    Text("取消")
                }
            }
        }
    }
}

@Composable
private fun MountCardBody(p: CardPayload.Mount, onAnswer: (String, String, JSONObject) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            buildString {
                append("Deva 想访问目录：")
                append(p.path)
                append("（触发工具：")
                append(p.tool)
                append("）")
                p.member?.let { append("，成员：").append(it) }
            },
            style = MaterialTheme.typography.bodyMedium
        )
        Text(
            "选择目录需要系统文件夹对话框，只能在电脑端完成。可暂时跳过，去电脑端处理。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        OutlinedButton(onClick = { onAnswer("mount", p.key, JSONObject().put("path", JSONObject.NULL)) }) {
            Text("暂不挂载")
        }
    }
}
