package zai.deva.android.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import zai.deva.android.AppGraph
import zai.deva.android.core.ApiResult
import zai.deva.android.core.TimelineItem

/**
 * 对话流 + 输入框 + 停止（设计 §5-3）：气泡流（用户右、助手左），工具调用折叠成一行，
 * 底部固定输入框；停止按钮只在有活动回合时出现。断线由 EventStream 自动退避重连，
 * replay_reset 触发整体回填（SessionStore.open(force=true)）。
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(sessionId: String, onBack: () -> Unit, onOpenSettings: () -> Unit = {}) {
    val items by AppGraph.sessions.timeline(sessionId).collectAsState()
    val streamState by AppGraph.sessions.streamState.collectAsState()
    val activeTurn by AppGraph.sessions.activeTurnFlow(sessionId).collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var input by remember { mutableStateOf("") }
    var loadError by remember { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val hasOlder by AppGraph.sessions.hasOlderFlow(sessionId).collectAsState()

    val client = AppGraph.client()
    val context = LocalContext.current
    // 待发附件（path 来自 /api/attachments 上传；随 send 的 attachments[] 带回，发送后清空）。
    // v1 选图（GetContent image/*）；忙时插入不带附件（服务端与桌面/IM 同语义，只插正文）。
    var pendingAttaches by remember { mutableStateOf(listOf<Pair<String, String>>()) }
    var uploading by remember { mutableStateOf(false) }

    // 模型切换（需求 6）：进入会话拉单会话元信息取当前 model；选择后随 send 的 modelRef 落档
    // （桌面语义：此后本对话固定用它）。null = 跟随全局默认。
    var currentModel by remember { mutableStateOf<String?>(null) }
    var showModelPicker by remember { mutableStateOf(false) }
    LaunchedEffect(sessionId) {
        val c = AppGraph.client() ?: return@LaunchedEffect
        when (val r = c.sessionMeta(sessionId)) {
            is ApiResult.Ok -> currentModel = r.value.model
            is ApiResult.Err -> Unit // 元信息失败不阻塞会话使用
        }
    }
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val c = AppGraph.client() ?: return@rememberLauncherForActivityResult
        scope.launch {
            uploading = true
            val picked = readPickedBytes(context, uri, UPLOAD_CAP)
            when {
                picked == null -> snackbar.showSnackbar("读取图片失败或超过 ${UPLOAD_CAP / 1024 / 1024}MB 上限。")
                else -> when (val r = c.uploadAttachment(picked.bytes, picked.name)) {
                    is ApiResult.Err -> snackbar.showSnackbar(r.message)
                    is ApiResult.Ok -> pendingAttaches = pendingAttaches + listOf(r.value to picked.name)
                }
            }
            uploading = false
        }
    }

    // 卡片作答回调：结果由 interaction_resolved 帧收起（桌面/手机同机制，先到的答复生效）
    val onAnswer = { kind: String, key: String, payload: JSONObject ->
        val c = AppGraph.client()
        if (c != null) {
            scope.launch {
                when (val r = c.answer(sessionId, key, kind, payload)) {
                    is ApiResult.Err -> snackbar.showSnackbar(r.message)
                    is ApiResult.Ok -> Unit
                }
            }
        }
        Unit
    }

    // 进入会话：回填历史（失败给整屏错误态，可重试 / 401 引导去设置）；订阅会话级流
    // （设计 §3.3 会话级 SSE）——桌面/定时任务发起的回合也实时可见（验收线 4）
    LaunchedEffect(sessionId) {
        if (client == null) return@LaunchedEffect
        when (val r = AppGraph.sessions.open(client, sessionId)) {
            is ApiResult.Err -> loadError = r.message
            is ApiResult.Ok -> loadError = null
        }
        if (loadError != null) return@LaunchedEffect
        AppGraph.sessions.watchSession(sessionId) {
            AppGraph.scope.launch {
                val c = AppGraph.client() ?: return@launch
                // replay_reset 后整体重填:失败保留现有时间线并置横幅,不闪空白(审查 A1)
                when (val r = AppGraph.sessions.repopulate(c, sessionId)) {
                    is ApiResult.Err -> loadError = r.message
                    is ApiResult.Ok -> loadError = null
                }
            }
        }
    }

    // 新内容到达时:仅当用户停留在近底部才自动滚动(避免阅读历史被拽回,审查 A6)
    LaunchedEffect(items.size) {
        if (items.isNotEmpty()) {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            if (lastVisible >= listState.layoutInfo.totalItemsCount - 2) {
                listState.animateScrollToItem(items.size - 1)
            }
        }
    }

    // 离开会话：停流（builder 与 lastEventId 保留，回来可 Last-Event-ID 续传）
    androidx.compose.runtime.DisposableEffect(sessionId) {
        onDispose { AppGraph.sessions.pause() }
    }

    if (showModelPicker) {
        ModelPickerDialog(
            current = currentModel,
            onSelect = { currentModel = it },
            onDismiss = { showModelPicker = false }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        val title = AppGraph.sessions.sessions.value
                            .firstOrNull { it.id == sessionId }?.title
                        Text(title?.ifBlank { "对话" } ?: "对话", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "模型：" + (currentModel?.substringAfterLast(':') ?: "默认"),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.combinedClickable(onClick = { showModelPicker = true })
                        )
                        when {
                            streamState == "unauthorized" -> Text(
                                "凭据无效，点此去设置重新配对",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.combinedClickable(onClick = onOpenSettings)
                            )
                            activeTurn != null && streamState == "reconnecting" -> Text(
                                "连接中断，正在重连…",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbar) }
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).imePadding()) {
            if (items.isEmpty() && loadError != null) {
                Column(
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(loadError ?: "", style = MaterialTheme.typography.bodyMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (loadError?.contains("重新配对") == true) {
                            TextButton(onClick = onOpenSettings) { Text("去设置") }
                        }
                        TextButton(onClick = {
                            scope.launch {
                                val c = AppGraph.client() ?: return@launch
                                when (val r = AppGraph.sessions.open(c, sessionId, force = true)) {
                                    is ApiResult.Err -> loadError = r.message
                                    is ApiResult.Ok -> loadError = null
                                }
                            }
                        }) { Text("重试") }
                    }
                }
            } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                if (hasOlder) {
                    item(key = "load-older") {
                        TextButton(
                            onClick = { scope.launch { AppGraph.sessions.loadOlder(sessionId) } },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("加载更早") }
                    }
                }
                // 稳定 key（uid）：结构变化时 Compose 按内容同一性局部重组，不做全列表位置 diff
                items(items, key = { it.uid }) { item -> TimelineRow(item, onAnswer, sessionId, snackbar) }
            }
            }

            // Waiting 态（有未决卡）：输入框禁用并提示，防止用户打字却被静默丢弃（设计 §4 状态机）
            val hasPendingCard = items.any { it is TimelineItem.Card && it.resolved == null }
            if (pendingAttaches.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    pendingAttaches.forEach { (path, name) ->
                        AssistChip(
                            onClick = { pendingAttaches = pendingAttaches.filterNot { it.first == path } },
                            label = { Text(name, maxLines = 1, modifier = Modifier.widthIn(max = 160.dp)) },
                            trailingIcon = {
                                Icon(Icons.Default.Close, contentDescription = "移除附件 $name", modifier = Modifier.padding(end = 4.dp))
                            }
                        )
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                IconButton(
                    enabled = !hasPendingCard && !uploading,
                    onClick = {
                        runCatching { pickImage.launch("image/*") }
                            .onFailure { scope.launch { snackbar.showSnackbar("没有可用的图片选择器。") } }
                    }
                ) {
                    Icon(Icons.Default.Add, contentDescription = "添加附件")
                }
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text(if (hasPendingCard) "等待你在下方卡片中作答…" else "发消息…") },
                    enabled = !hasPendingCard,
                    maxLines = 5
                )
                if (activeTurn != null) {
                    IconButton(
                        onClick = {
                            val turn = activeTurn ?: return@IconButton
                            val c = AppGraph.client() ?: return@IconButton
                            scope.launch {
                                when (val r = c.abort(turn)) {
                                    is ApiResult.Err -> snackbar.showSnackbar(r.message)
                                    is ApiResult.Ok -> Unit // done 帧会收尾 activeTurn
                                }
                            }
                        }
                    ) {
                        Icon(Icons.Default.Close, contentDescription = "停止")
                    }
                } else {
                    IconButton(
                        enabled = !hasPendingCard,
                        onClick = {
                            val text = input.trim()
                            if (text.isEmpty()) return@IconButton
                            val c = AppGraph.client() ?: return@IconButton
                            val attachPaths = pendingAttaches.map { it.first }
                            input = ""
                            // 在途标记:turn_start 帧先于 send 响应到达时据文本去重(防双气泡)
                            AppGraph.sessions.markSending(sessionId, text)
                            scope.launch {
                                when (val r = c.send(sessionId, text, attachPaths, currentModel)) {
                                    is ApiResult.Ok -> {
                                        pendingAttaches = emptyList()
                                        if (r.value.isEmpty()) {
                                            // 忙时回退为「插入进行中的任务」(IM 同口径):无新回合
                                            // (插入只带正文;随附的附件被丢弃——明确提示,不让用户以为附件已送达)
                                            AppGraph.sessions.clearSending(sessionId)
                                            snackbar.showSnackbar(
                                                if (attachPaths.isEmpty()) "已插入进行中的任务，当前步骤结束后送达。"
                                                else "已插入进行中的任务；附件未随插入送达，如需请重新附加后再发。"
                                            )
                                        } else {
                                            AppGraph.sessions.sendStarted(sessionId, r.value, text) {
                                                AppGraph.scope.launch {
                                                    AppGraph.sessions.open(
                                                        AppGraph.client() ?: return@launch,
                                                        sessionId,
                                                        force = true
                                                    )
                                                }
                                            }
                                        }
                                    }
                                    is ApiResult.Err -> {
                                        AppGraph.sessions.clearSending(sessionId)
                                        input = text // 发不出去，放回输入框（附件清单保留可重试）
                                        snackbar.showSnackbar(r.message)
                                    }
                                }
                            }
                        }
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TimelineRow(
    item: TimelineItem,
    onAnswer: (String, String, JSONObject) -> Unit,
    sessionId: String,
    snackbar: SnackbarHostState
) {
    val copyScope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    // 长按复制（设计 §5）：正文 / 思考 / 工具行都可用，复制后轻提示
    fun copyOnLong(base: Modifier, text: String): Modifier = base.combinedClickable(
        onClick = {},
        onLongClick = {
            clipboard.setText(AnnotatedString(text))
            copyScope.launch { snackbar.showSnackbar("已复制") }
        }
    )
    when (item) {
        is TimelineItem.Text -> Bubble(item.text, item.fromUser, copyOnLong(Modifier, item.text))
        is TimelineItem.Thinking -> Text(
            item.text,
            style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = copyOnLong(Modifier.fillMaxWidth().padding(horizontal = 4.dp), item.text)
        )
        is TimelineItem.Tool -> Text(
            item.summary?.let { "🔧 ${item.name} — $it" } ?: "🔧 正在 ${item.name}…",
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = copyOnLong(
                Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                item.summary?.let { "🔧 ${item.name} — $it" } ?: "🔧 正在 ${item.name}…"
            )
        )
        is TimelineItem.Card -> CardRow(item, onAnswer)
        is TimelineItem.Error -> Text(
            item.message,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)
        )
        is TimelineItem.Deliverable -> DeliverableRow(item, sessionId, snackbar)
        is TimelineItem.Note -> Text(
            item.text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)
        )
    }
}

@Composable
private fun Bubble(text: String, fromUser: Boolean, extra: Modifier = Modifier) {
    Box(Modifier.fillMaxWidth(), contentAlignment = if (fromUser) Alignment.CenterEnd else Alignment.CenterStart) {
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            color = if (fromUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .then(extra)
                .widthIn(max = 300.dp)
                .background(
                    if (fromUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(
                        topStart = 14.dp, topEnd = 14.dp,
                        bottomStart = if (fromUser) 14.dp else 2.dp,
                        bottomEnd = if (fromUser) 2.dp else 14.dp
                    )
                )
                .padding(horizontal = 12.dp, vertical = 8.dp)
        )
    }
}

/** 模型选择弹窗：拉 /api/models 列出可选（radio 单选），选择即作为本对话后续 send 的 modelRef。 */
@Composable
private fun ModelPickerDialog(
    current: String?,
    onSelect: (String?) -> Unit,
    onDismiss: () -> Unit
) {
    var models by remember { mutableStateOf<zai.deva.android.core.ModelsResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        val c = AppGraph.client() ?: return@LaunchedEffect
        when (val r = c.models()) {
            is ApiResult.Ok -> models = r.value
            is ApiResult.Err -> error = r.message
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("切换模型（本对话固定使用）") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    error != null -> Text(error ?: "", color = MaterialTheme.colorScheme.error)
                    models == null -> Text("加载中…", style = MaterialTheme.typography.bodyMedium)
                    models!!.models.isEmpty() -> Text("没有可用模型。请先在电脑端设置里配置。")
                    else -> Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = current == null, onClick = { onSelect(null) })
                            Text("跟随全局默认${models!!.active?.let { "（当前：${it.substringAfterLast(':')}）" } ?: ""}")
                        }
                        models!!.models.forEach { m ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(selected = current == m.ref, onClick = { onSelect(m.ref) })
                                Column {
                                    Text("${m.name}（${m.provider}）", style = MaterialTheme.typography.bodyMedium)
                                    Text(
                                        m.ref,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("完成") } }
    )
}

/** 附件上传的传输上限（与服务端 ATTACHMENT_UPLOAD_MAX 对齐）。 */
private const val UPLOAD_CAP = 24 * 1024 * 1024

private class PickedBytes(val bytes: ByteArray, val name: String)

/** 读取选中内容的字节与显示名：流式读、超上限即弃（不整载超大文件）；读不到/被吊销返回 null。 */
private suspend fun readPickedBytes(context: android.content.Context, uri: Uri, cap: Int): PickedBytes? =
    withContext(Dispatchers.IO) {
        val name = context.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && c.moveToFirst()) c.getString(idx) else null
        } ?: "image"
        // 选择器给的 URI 可能已失效/不可读（ENOENT）：吞掉 IO 异常走 null 分支提示，绝不让它冒泡成 FATAL
        val bytes = try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(64 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(chunk)
                    if (n <= 0) break
                    total += n
                    if (total > cap) return@use null
                    buf.write(chunk, 0, n)
                }
                buf.toByteArray()
            }
        } catch (_: java.io.IOException) {
            null
        }
        if (bytes == null || bytes.isEmpty()) null else PickedBytes(bytes, name)
    }
