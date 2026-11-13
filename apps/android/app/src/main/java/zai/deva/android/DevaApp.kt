package zai.deva.android

import android.app.Application
import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import okhttp3.OkHttpClient
import zai.deva.android.core.AppPrefs
import zai.deva.android.core.DevaClient
import zai.deva.android.core.EncryptedSecureStore
import zai.deva.android.core.EventStream
import zai.deva.android.core.SecureStore
import zai.deva.android.core.ServerConfig
import zai.deva.android.core.ServerStore
import zai.deva.android.core.SessionStore

/**
 * Application 入口：启动时装载服务器列表（设计 §4），初始化进程级服务定位器 AppGraph；
 * 观测前后台切换——退后台且开了保活时拉起前台服务，回前台即停（设计 §4 保活约定）。
 */
class DevaApp : Application(), DefaultLifecycleObserver {
    override fun onCreate() {
        super<Application>.onCreate() // 与 DefaultLifecycleObserver 同名成员，需显式指定
        AppGraph.init(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
    }

    override fun onStart(owner: LifecycleOwner) = AppGraph.stopKeepAlive()

    override fun onStop(owner: LifecycleOwner) {
        if (AppGraph.prefs.keepAlive.value) AppGraph.startKeepAlive()
    }
}

/**
 * 进程级服务定位器：SecureStore（token）/ ServerStore（服务器列表）/ SessionStore（会话与时间线）/
 * EventStream（SSE）/ 当前服务器与 client 工厂。单 Activity + Compose，Composable 直接取用。
 */
object AppGraph {

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** deva://pair 深链带来的预填(host/port/code);SettingsScreen 消费后清空。 */
    data class GeneralPairLink(val host: String, val port: Int, val code: String)
    val pendingPairLink = MutableStateFlow<GeneralPairLink?>(null)

    /** REST 复用一个 client（连接池共享）。 */
    private val restHttp = OkHttpClient()

    lateinit var secure: SecureStore
        private set
    lateinit var servers: ServerStore
        private set
    lateinit var sessions: SessionStore
        private set
    lateinit var prefs: AppPrefs
        private set

    private var appContext: Application? = null

    /** 当前选中服务器（null = 还没添加）。 */
    val current: StateFlow<ServerConfig?> by lazy {
        combine(servers.servers, servers.currentId) { list, id -> list.firstOrNull { it.id == id } }
            .stateIn(scope, SharingStarted.Eagerly, null)
    }

    fun init(app: Application) {
        appContext = app
        secure = EncryptedSecureStore(app)
        servers = ServerStore(app).also { it.load() }
        prefs = AppPrefs(app)
        sessions = SessionStore(sse, ::client)
    }

    /** 后台保活前台服务（KeepAliveService；设置页开关与前后台观测者都走这两个入口）。 */
    fun startKeepAlive() {
        val ctx = appContext ?: return
        ctx.startForegroundService(Intent(ctx, KeepAliveService::class.java))
    }

    fun stopKeepAlive() {
        val ctx = appContext ?: return
        ctx.stopService(Intent(ctx, KeepAliveService::class.java))
    }

    private fun baseUrl(): String? = current.value?.let { "http://${it.host}:${it.port}" }

    private fun token(): String? =
        current.value?.deviceId?.takeIf { it.isNotEmpty() }?.let { secure.loadToken(it) }

    /** SSE 事件流（baseUrl/token 跟随当前服务器；断线重连闸门读设置页开关，默认开）。 */
    private val sse: EventStream by lazy {
        EventStream(
            baseUrlProvider = ::baseUrl,
            tokenProvider = ::token,
            reconnectEnabled = { prefs.reconnect.value }
        )
    }

    /** 绑定当前服务器的 REST 客户端；未添加服务器时为 null。 */
    fun client(): DevaClient? = current.value?.let { srv ->
        DevaClient(
            baseUrl = "http://${srv.host}:${srv.port}",
            tokenProvider = { srv.deviceId.takeIf { it.isNotEmpty() }?.let { secure.loadToken(it) } },
            http = restHttp
        )
    }
}
