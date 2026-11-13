package zai.deva.android.ui

import android.text.format.DateUtils
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.RadioButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import zai.deva.android.AppGraph
import zai.deva.android.core.ApiResult
import zai.deva.android.core.PersonaInfo
import zai.deva.android.core.ServerConfig
import zai.deva.android.core.SessionMeta

/** 会话列表分组维度（默认不分组=注意力分区；整理入口在顶栏 ⋮ 菜单）。 */
private enum class GroupMode { NONE, PERSONA, FOLDER }

/**
 * 会话列表（心流形态）：默认**注意力分区**——「需要你」(有未决卡) → 「进行中」(回合运行) → 「最近」
 * （其余按更新时间），打开 App 即见需要处理的对话，无任何筛选决策。归档默认隐藏（⋮ 可临时显示）。
 * 行内只保留关键信号：标题、摘要、待操作角标、相对时间；角色/目录并入次行文字（分组视图下自动去冗余）。
 * FAB → 角色选择（搜索 + 点选直达创建，角色多时可用）；不选角色即默认直建。
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(onOpenChat: (String) -> Unit, onOpenSettings: () -> Unit, onOpenTasks: () -> Unit = {}) {
    val server by AppGraph.current.collectAsState()
    val sessions by AppGraph.sessions.sessions.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var refreshError by remember { mutableStateOf<String?>(null) }
    var actionTarget by remember { mutableStateOf<SessionMeta?>(null) }
    var showPersonaPicker by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var groupMode by remember { mutableStateOf(GroupMode.NONE) }
    var showArchived by remember { mutableStateOf(false) }

    // 进入 / 回到首页时刷新列表（失败给横幅：可重试；401 引导去设置重新配对）
    LaunchedEffect(Unit) {
        val client = AppGraph.client() ?: return@LaunchedEffect
        when (val r = AppGraph.sessions.refresh(client)) {
            is ApiResult.Err -> refreshError = r.message
            is ApiResult.Ok -> refreshError = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(server?.name ?: "未连接服务器", style = MaterialTheme.typography.titleMedium)
                        Text(
                            text = serverStatusText(server),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                },
                actions = {
                    IconButton(onClick = onOpenTasks) {
                        Icon(Icons.Default.List, contentDescription = "定时任务")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "设置")
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "整理")
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            if (server != null) {
                // 显式钉主色：此 material3 版本的 ExtendedFAB 默认容器色不随 colorScheme.primary 走
                ExtendedFloatingActionButton(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    onClick = { showPersonaPicker = true }
                ) {
                    Icon(Icons.Default.Add, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("新对话")
                }
            }
        }
    ) { pad ->
        val srv = server
        if (srv == null) {
            EmptyState(pad, onOpenSettings)
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(pad),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                refreshError?.let { msg ->
                    item(key = "error") {
                        ElevatedCard(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.elevatedCardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant
                            )
                        ) {
                            Row(modifier = Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    msg,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (msg.contains("重新配对")) MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f)
                                )
                                if (msg.contains("重新配对")) {
                                    TextButton(onClick = onOpenSettings) { Text("去设置") }
                                }
                                TextButton(onClick = {
                                    scope.launch {
                                        val client = AppGraph.client() ?: return@launch
                                        when (val r = AppGraph.sessions.refresh(client)) {
                                            is ApiResult.Err -> refreshError = r.message
                                            is ApiResult.Ok -> refreshError = null
                                        }
                                    }
                                }) { Text("重试") }
                            }
                        }
                    }
                }

                val display = buildDisplayRows(sessions, groupMode, showArchived)
                items(display, key = { it.key }) { entry ->
                    when (entry) {
                        is DisplayRow.Header -> Text(
                            entry.label,
                            style = MaterialTheme.typography.titleSmall,
                            color = if (entry.accent) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp)
                        )
                        is DisplayRow.Item -> SessionRow(
                            entry.session,
                            hidePersona = groupMode == GroupMode.PERSONA,
                            hideFolder = groupMode == GroupMode.FOLDER,
                            onClick = { onOpenChat(entry.session.id) },
                            onLongClick = { actionTarget = entry.session }
                        )
                    }
                }
                if (display.isEmpty()) {
                    item {
                        Text(
                            "没有需要处理的对话。点右下角「新对话」开始。",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 24.dp)
                        )
                    }
                }
            }
        }
    }

    // 长按会话项 → 重命名 / 归档 / 删除（删除走二次确认；409 = 忙时归档）
    actionTarget?.let { target ->
        var renameText by remember(target.id) { mutableStateOf(target.title) }
        var confirmingDelete by remember(target.id) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { actionTarget = null },
            title = { Text(target.title.ifBlank { "新对话" }) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = renameText,
                        onValueChange = { renameText = it },
                        label = { Text("重命名（留空恢复自动标题）") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TextButton(onClick = {
                            val client = AppGraph.client()
                            if (client != null) {
                                scope.launch {
                                    when (val r = client.setArchived(target.id, !target.archived)) {
                                        is ApiResult.Err -> snackbar.showSnackbar(r.message)
                                        is ApiResult.Ok -> Unit
                                    }
                                    AppGraph.sessions.refresh(client)
                                }
                            }
                            actionTarget = null
                        }) { Text(if (target.archived) "取消归档" else "归档") }
                        TextButton(onClick = { confirmingDelete = true }) {
                            Text("删除", color = MaterialTheme.colorScheme.error)
                        }
                    }
                    if (confirmingDelete) {
                        Text(
                            "删除「${target.title.ifBlank { "新对话" }}」？对话与历史将一并删除，不可恢复。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            TextButton(onClick = {
                                val client = AppGraph.client()
                                if (client != null) {
                                    scope.launch {
                                        when (val r = client.deleteSession(target.id)) {
                                            is ApiResult.Err -> snackbar.showSnackbar(r.message)
                                            is ApiResult.Ok -> Unit
                                        }
                                        AppGraph.sessions.refresh(client)
                                    }
                                }
                                actionTarget = null
                            }) { Text("确认删除", color = MaterialTheme.colorScheme.error) }
                            TextButton(onClick = { confirmingDelete = false }) { Text("再想想") }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val client = AppGraph.client()
                    if (client != null) {
                        scope.launch {
                            when (val r = client.renameSession(target.id, renameText.trim())) {
                                is ApiResult.Err -> snackbar.showSnackbar(r.message)
                                is ApiResult.Ok -> Unit
                            }
                            AppGraph.sessions.refresh(client)
                        }
                    }
                    actionTarget = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { actionTarget = null }) { Text("关闭") } }
        )
    }

    if (menuOpen) {
        AlertDialog(
            onDismissRequest = { menuOpen = false },
            title = { Text("整理") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "分组",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = groupMode == GroupMode.NONE, onClick = { groupMode = GroupMode.NONE })
                        Text("不分组（按注意力分区）")
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = groupMode == GroupMode.PERSONA, onClick = { groupMode = GroupMode.PERSONA })
                        Text("按角色")
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = groupMode == GroupMode.FOLDER, onClick = { groupMode = GroupMode.FOLDER })
                        Text("按目录")
                    }
                    HorizontalDivider()
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("显示已归档", modifier = Modifier.weight(1f))
                        Switch(checked = showArchived, onCheckedChange = { showArchived = it })
                    }
                }
            },
            confirmButton = { TextButton(onClick = { menuOpen = false }) { Text("完成") } }
        )
    }

    if (showPersonaPicker) {
        PersonaPickerDialog(
            snackbar = snackbar,
            onDismiss = { showPersonaPicker = false },
            onCreated = { id ->
                showPersonaPicker = false
                scope.launch {
                    AppGraph.client()?.let { AppGraph.sessions.refresh(it) }
                    onOpenChat(id)
                }
            }
        )
    }
}

/** 列表展示条目（分区头或会话行）。 */
private sealed interface DisplayRow {
    val key: String

    data class Header(val label: String, val accent: Boolean = false) : DisplayRow {
        override val key: String = "h:$label"
    }

    data class Item(val session: SessionMeta) : DisplayRow {
        override val key: String = session.id
    }
}

private val RECENT = Comparator<SessionMeta> { a, b -> b.updatedAt.compareTo(a.updatedAt) }

/**
 * 心流默认视图：需要你(未决卡) → 进行中(回合运行) → 最近(其余) → 已归档(仅显式显示时)。
 * 分组视图（按角色/目录）：组间按组内最新活动排，组内按注意力排序；归档同样仅显式显示时尾随。
 */
private fun buildDisplayRows(
    sessions: List<SessionMeta>,
    groupMode: GroupMode,
    showArchived: Boolean
): List<DisplayRow> {
    val visible = sessions.filter { showArchived || !it.archived }
    if (visible.isEmpty()) return emptyList()

    if (groupMode == GroupMode.NONE) {
        // 归档会话只进尾部的「已归档」区(showArchived 时),绝不混入活动分区——否则 LazyColumn key 重复
        val active = visible.filter { !it.archived }
        val todo = active.filter { it.pendingCard }.sortedWith(RECENT)
        val busy = active.filter { !it.pendingCard && it.busy }.sortedWith(RECENT)
        val rest = active.filter { !it.pendingCard && !it.busy }.sortedWith(RECENT)
        val rows = mutableListOf<DisplayRow>()
        if (todo.isNotEmpty()) rows += DisplayRow.Header("需要你", accent = true)
        rows += todo.map { DisplayRow.Item(it) }
        if (busy.isNotEmpty()) rows += DisplayRow.Header("进行中")
        rows += busy.map { DisplayRow.Item(it) }
        if (rest.isNotEmpty()) rows += DisplayRow.Header("最近")
        rows += rest.map { DisplayRow.Item(it) }
        if (showArchived) {
            val archived = visible.filter { it.archived }.sortedWith(RECENT)
            if (archived.isNotEmpty()) {
                rows += DisplayRow.Header("已归档")
                rows += archived.map { DisplayRow.Item(it) }
            }
        }
        return rows
    }

    // 分组视图：组间按组内最新活动，组内按注意力（未决卡 → 忙 → 其余）排序
    val labelOf: (SessionMeta) -> String = when (groupMode) {
        GroupMode.PERSONA -> { s -> s.personaName ?: "默认" }
        GroupMode.FOLDER -> { s -> s.focusRoot?.substringAfterLast('/')?.ifBlank { "目录" } ?: "全机" }
        GroupMode.NONE -> return emptyList()
    }
    val attention = Comparator<SessionMeta> { a, b ->
        when {
            a.pendingCard != b.pendingCard -> if (a.pendingCard) -1 else 1
            a.busy != b.busy -> if (a.busy) -1 else 1
            else -> b.updatedAt.compareTo(a.updatedAt)
        }
    }
    val rows = mutableListOf<DisplayRow>()
    visible.filter { !it.archived }.groupBy(labelOf)
        .entries.sortedByDescending { (_, v) -> v.maxOf { it.updatedAt } }
        .forEach { (label, list) ->
            rows += DisplayRow.Header(label)
            rows += list.sortedWith(attention).map { DisplayRow.Item(it) }
        }
    if (showArchived) {
        val archived = visible.filter { it.archived }.sortedWith(RECENT)
        if (archived.isNotEmpty()) {
            rows += DisplayRow.Header("已归档")
            rows += archived.map { DisplayRow.Item(it) }
        }
    }
    return rows
}

private fun serverStatusText(server: ServerConfig?): String =
    when {
        server == null -> "先去设置里添加并配对一台 Deva"
        server.deviceId.isEmpty() -> "${server.host}:${server.port} · 未配对"
        else -> "${server.host}:${server.port} · 已配对"
    }

@Composable
private fun EmptyState(pad: PaddingValues, onOpenSettings: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(pad).padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("还没有添加服务器", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text(
                "在电脑端 Deva「设置 → 远程设备」里开启安卓通道并生成配对码，" +
                    "然后到这里添加服务器（host:port）并输入配对码。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(16.dp))
            ElevatedCard(onClick = onOpenSettings) {
                Text(
                    "去添加服务器",
                    modifier = Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.primary
                )
            }
        }
    }
}

/**
 * 会话行（降噪版）：标题 + 摘要 + 一行次要文字（待操作角标 + 角色 · 目录 · 时间）。
 * 分组视图下与组头冗余的维度自动隐藏（按角色分组时行内不再重复角色名）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    s: SessionMeta,
    hidePersona: Boolean,
    hideFolder: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit
) {
    ElevatedCard(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
    ) {
        Row(
            modifier = Modifier.padding(14.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    s.title.ifBlank { "新对话" },
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1
                )
                s.lastMessage?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                    )
                }
                val secondary = buildString {
                    if (!hidePersona) s.personaName?.let { append(it).append(" · ") }
                    if (!hideFolder) s.focusRoot?.let { append(it.substringAfterLast('/')).append(" · ") }
                    append(
                        DateUtils.getRelativeTimeSpanString(
                            s.updatedAt,
                            System.currentTimeMillis(),
                            DateUtils.MINUTE_IN_MILLIS
                        ).toString()
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (s.pendingCard) {
                        Text(
                            "待操作",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onError,
                            modifier = Modifier
                                .background(MaterialTheme.colorScheme.error, RoundedCornerShape(4.dp))
                                .padding(horizontal = 6.dp, vertical = 1.dp)
                        )
                    }
                    Text(
                        secondary,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                    )
                }
            }
            if (s.busy) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            }
        }
    }
}

/**
 * 新建会话的角色选择（FAB 直达）：搜索过滤 + **点选即创建**（角色多时的快速路径）。
 * 「不选角色」= 与桌面新建同语义（首发落库时绑定默认角色）。绑定后不可改，条目描述注明。
 */
@Composable
private fun PersonaPickerDialog(
    snackbar: SnackbarHostState,
    onDismiss: () -> Unit,
    onCreated: (String) -> Unit
) {
    val scope = rememberCoroutineScope()
    var personas by remember { mutableStateOf<List<PersonaInfo>?>(null) }
    var query by remember { mutableStateOf("") }
    var creatingWith by remember { mutableStateOf<String?>("__none__") } // "__none__" = 无在飞创建

    LaunchedEffect(Unit) {
        val client = AppGraph.client() ?: return@LaunchedEffect
        when (val r = client.personas()) {
            is ApiResult.Ok -> personas = r.value
            is ApiResult.Err -> snackbar.showSnackbar(r.message)
        }
    }

    fun create(personaId: String?) {
        if (creatingWith != "__none__") return // 防双击双建
        creatingWith = personaId
        val client = AppGraph.client()
        if (client == null) {
            creatingWith = "__none__"
            return
        }
        scope.launch {
            when (val r = client.createSession(personaId)) {
                is ApiResult.Ok -> onCreated(r.value)
                is ApiResult.Err -> {
                    snackbar.showSnackbar(r.message)
                    creatingWith = "__none__"
                }
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新对话") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("搜索角色…") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                when (val p = personas) {
                    null -> CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    else -> {
                        val filtered = if (query.isBlank()) p
                        else p.filter {
                            it.name.contains(query, ignoreCase = true) ||
                                it.description.contains(query, ignoreCase = true)
                        }
                        Column(
                            modifier = Modifier
                                .heightIn(max = 360.dp)
                                .verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(2.dp)
                        ) {
                            PersonaPickRow(
                                name = "不选角色",
                                description = "直接开始；首发时绑定默认角色",
                                enabled = creatingWith == "__none__",
                                onClick = { create(null) }
                            )
                            filtered.forEach { persona ->
                                PersonaPickRow(
                                    name = persona.name,
                                    description = persona.description.ifBlank { "绑定后不可改" },
                                    enabled = creatingWith == "__none__",
                                    onClick = { create(persona.id) }
                                )
                            }
                            if (filtered.isEmpty()) {
                                Text(
                                    "没有匹配的角色",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(vertical = 8.dp)
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PersonaPickRow(
    name: String,
    description: String,
    enabled: Boolean,
    onClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 8.dp)
    ) {
        Text(name, style = MaterialTheme.typography.bodyLarge)
        Text(
            description,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
        )
    }
}
