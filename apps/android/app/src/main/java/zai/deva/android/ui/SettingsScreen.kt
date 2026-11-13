package zai.deva.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import zai.deva.android.AppGraph
import zai.deva.android.core.ApiResult
import zai.deva.android.core.ServerConfig

/**
 * 设置页（设计 §5-6 / P2 范围）：服务器增删与切换、配对（配对码 + 设备名）、连接测试、
 * 明文传输提示（安全要求，设计 §7——设置页与配对成功提示都要显式出现）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val servers by AppGraph.servers.servers.collectAsState()
    val currentId by AppGraph.servers.currentId.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var showAdd by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<ServerConfig?>(null) }

    var prefillCode by remember { mutableStateOf<String?>(null) }

    // deva://pair 深链预填:确保 host:port 条目存在并选中,码预填进配对面板
    LaunchedEffect(Unit) {
        val link = AppGraph.pendingPairLink.value ?: return@LaunchedEffect
        AppGraph.pendingPairLink.value = null
        val target = servers.firstOrNull { it.host == link.host && it.port == link.port }
        val sid = target?.id ?: AppGraph.servers.add("", link.host, link.port).also { AppGraph.servers.setCurrent(it.id) }.id
        AppGraph.servers.setCurrent(sid)
        prefillCode = link.code
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbar) }
    ) { pad ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(pad),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "服务器",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { showAdd = true }) {
                        Icon(Icons.Default.Add, contentDescription = null)
                        Spacer(Modifier.width(4.dp))
                        Text("添加")
                    }
                }
            }

            items(servers, key = { it.id }) { srv ->
                ElevatedCard(
                    onClick = { AppGraph.servers.setCurrent(srv.id) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        RadioButton(selected = srv.id == currentId, onClick = { AppGraph.servers.setCurrent(srv.id) })
                        Column(Modifier.weight(1f)) {
                            Text(srv.name, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                "${srv.host}:${srv.port}" +
                                    if (srv.deviceId.isEmpty()) " · 未配对" else " · 已配对（${srv.deviceId}）",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        IconButton(onClick = { deleting = srv }) {
                            Icon(Icons.Default.Delete, contentDescription = "删除")
                        }
                    }
                }
            }
            if (servers.isEmpty()) {
                item {
                    Text(
                        "还没有服务器。点右上「添加」，填电脑端显示的地址与端口。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // 配对面板：针对当前选中的服务器
            item {
                val cur = servers.firstOrNull { it.id == currentId }
                if (cur != null) {
                    PairPanel(server = cur, snackbar = snackbar, scope = scope, prefillCode = prefillCode)
                }
            }

            // 自助吊销（协议 self-revoke 能力）：凭当前 token 远程删除本设备的桌面侧凭据，
            // 丢失设备无需物理回到桌面自救
            item {
                val cur = servers.firstOrNull { it.id == currentId }
                if (cur?.deviceId?.isNotEmpty() == true) {
                    var confirming by remember { mutableStateOf(false) }
                    TextButton(onClick = { confirming = true }) {
                        Text("吊销本设备", color = MaterialTheme.colorScheme.error)
                    }
                    if (confirming) {
                        AlertDialog(
                            onDismissRequest = { confirming = false },
                            title = { Text("吊销本设备") },
                            text = { Text("删除电脑端「${cur.name}」里本设备的配对凭据，此后本机无法再访问该电脑端（历史会话保留）。需要时可在电脑端重新配对。") },
                            confirmButton = {
                                TextButton(onClick = {
                                    confirming = false
                                    val client = AppGraph.client() ?: return@TextButton
                                    val deviceId = cur.deviceId
                                    scope.launch {
                                        when (val r = client.selfRevoke()) {
                                            is ApiResult.Err -> snackbar.showSnackbar(r.message)
                                            is ApiResult.Ok -> {
                                                AppGraph.secure.removeToken(deviceId)
                                                AppGraph.servers.updateDevice(cur.id, "")
                                                snackbar.showSnackbar("已吊销本设备。如需再次使用请在电脑端重新配对。")
                                            }
                                        }
                                    }
                                }) { Text("吊销", color = MaterialTheme.colorScheme.error) }
                            },
                            dismissButton = { TextButton(onClick = { confirming = false }) { Text("取消") } }
                        )
                    }
                }
            }

            // 明文传输提示（安全要求，不能省）
            item {
                ElevatedCard(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.elevatedCardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Text(
                        "⚠ 明文传输提示：当前客户端与 Deva 桌面端之间使用局域网 HTTP 明文传输，" +
                            "同网段内可被嗅探。请仅在可信网络（家庭 / 自己的路由器）下使用，" +
                            "不要在公共 Wi-Fi 下配对或发送敏感内容。",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp)
                    )
                }
            }

            // P4:保活与重连（设计 §4/§5-6——保活默认关,重连默认开）
            item {
                val keepAlive by AppGraph.prefs.keepAlive.collectAsState()
                val reconnect by AppGraph.prefs.reconnect.collectAsState()
                val ctx = LocalContext.current
                val notifPerm = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { } // 拒了也照跑,只是通知不可见
                ElevatedCard(modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("后台保活", style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    "App 退到后台时用前台服务保持事件流（常驻通知显示连接状态，默认关）",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Switch(
                                checked = keepAlive,
                                onCheckedChange = { on ->
                                    AppGraph.prefs.setKeepAlive(on)
                                    if (on) {
                                        if (Build.VERSION.SDK_INT >= 33 &&
                                            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
                                            PackageManager.PERMISSION_GRANTED
                                        ) notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
                                        // 前台时观测者会停服务；这里兜底交给前后台切换时拉起
                                    } else {
                                        AppGraph.stopKeepAlive()
                                    }
                                }
                            )
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("断线自动重连", style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    "断开后按 1s→30s 指数退避自动恢复事件流；关掉则断线即停，重进会话恢复",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Switch(
                                checked = reconnect,
                                onCheckedChange = { AppGraph.prefs.setReconnect(it) }
                            )
                        }
                    }
                }
            }

            // 关于
            item { AboutCard() }
        }
    }

    if (showAdd) {
        AddServerDialog(
            onDismiss = { showAdd = false },
            onAdd = { name, host, port ->
                AppGraph.servers.add(name, host, port)
                showAdd = false
            }
        )
    }

    deleting?.let { srv ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("删除服务器") },
            text = { Text("删除「${srv.name}」（${srv.host}:${srv.port}）？已保存的配对凭据也会一并清除。") },
            confirmButton = {
                TextButton(onClick = {
                    srv.deviceId.takeIf { it.isNotEmpty() }?.let { AppGraph.secure.removeToken(it) }
                    AppGraph.servers.remove(srv.id)
                    deleting = null
                }) { Text("删除") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } }
        )
    }
}

@Composable
private fun AboutCard() {
    val ctx = LocalContext.current
    val version = remember {
        runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "?"
    }
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("关于", style = MaterialTheme.typography.titleMedium)
            Text("Deva 安卓客户端 v$version", style = MaterialTheme.typography.bodyMedium)
            Text(
                "局域网直连电脑端 Deva，同一后端、同一会话。配对与下载边界见桌面端设置 → 远程设备。" +
                    "在家不可用时可用 Tailscale / WireGuard 等组网工具接入。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun PairPanel(
    server: ServerConfig,
    snackbar: SnackbarHostState,
    scope: kotlinx.coroutines.CoroutineScope,
    prefillCode: String? = null
) {
    var deviceName by remember { mutableStateOf(defaultDeviceName()) }
    var code by remember { mutableStateOf("") }
    // deva:// 深链预填:扫码进入时自动填好 6 位码,用户只需点「重新配对」
    LaunchedEffect(prefillCode) {
        if (!prefillCode.isNullOrEmpty()) code = prefillCode
    }
    var pairing by remember { mutableStateOf(false) }
    var infoText by remember { mutableStateOf("") }

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("配对：${server.name}", style = MaterialTheme.typography.titleMedium)
            Text(
                "在电脑端 Deva「设置 → 远程设备」开启安卓通道、点「生成配对码」，把 6 位码填到下面（5 分钟内有效）。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text("设备名（电脑端显示）") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter { c -> c.isDigit() }.take(6) },
                label = { Text("6 位配对码") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(
                    enabled = !pairing && code.length == 6 && server.id == AppGraph.servers.currentId.value,
                    onClick = {
                        val srv = AppGraph.current.value ?: return@TextButton
                        // 配对接口免鉴权，但地址必须是当前选中的这台服务器
                        val client = AppGraph.client() ?: return@TextButton
                        pairing = true
                        scope.launch {
                            when (val r = client.pair(code, deviceName)) {
                                is ApiResult.Ok -> {
                                    AppGraph.secure.saveToken(r.value.deviceId, r.value.token)
                                    AppGraph.servers.updateDevice(srv.id, r.value.deviceId)
                                    snackbar.showSnackbar(
                                        "配对成功。⚠ 当前为局域网明文传输，请仅在可信网络使用。"
                                    )
                                }
                                is ApiResult.Err -> snackbar.showSnackbar(r.message)
                            }
                            pairing = false
                        }
                    }
                ) { Text(if (pairing) "配对中…" else if (server.deviceId.isEmpty()) "配对" else "重新配对") }

                Spacer(Modifier.width(12.dp))

                TextButton(
                    onClick = {
                        val client = AppGraph.client() ?: return@TextButton
                        scope.launch {
                            when (val r = client.info()) {
                                is ApiResult.Ok -> infoText =
                                    "已连接：${r.value.hostname} · v${r.value.version} · ${r.value.platform}"
                                is ApiResult.Err -> infoText = r.message
                            }
                        }
                    }
                ) { Text("测试连接") }
            }
            if (infoText.isNotEmpty()) {
                Text(
                    infoText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun AddServerDialog(onDismiss: () -> Unit, onAdd: (name: String, host: String, port: Int) -> Unit) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("4317") }
    val portOk = port.toIntOrNull() in 1..65535
    val hostOk = host.trim().isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("添加服务器") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名称（可选）") },
                    singleLine = true
                )
                OutlinedTextField(
                    value = host,
                    onValueChange = { host = it },
                    label = { Text("主机（IP 或主机名）") },
                    singleLine = true,
                    isError = host.isNotEmpty() && !hostOk
                )
                OutlinedTextField(
                    value = port,
                    onValueChange = { port = it.filter { c -> c.isDigit() }.take(5) },
                    label = { Text("端口（默认 4317）") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    singleLine = true,
                    isError = !portOk
                )
            }
        },
        confirmButton = {
            TextButton(enabled = hostOk && portOk, onClick = { onAdd(name, host.trim(), port.toInt()) }) {
                Text("添加")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

private fun defaultDeviceName(): String {
    val manufacturer = Build.MANUFACTURER?.replace(Regex("\\s+"), "-") ?: "Android"
    val model = Build.MODEL?.replace(Regex("\\s+"), "-") ?: "device"
    return if (model.startsWith(manufacturer)) model.take(40) else "$manufacturer-$model".take(40)
}
