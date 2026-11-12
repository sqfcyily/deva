package zai.deva.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * 前台服务保活（设计 §4 / P4，可选开关默认关）：App 退到后台时拉起，进程不被杀，
 * SSE 流继续收事件；常驻通知显示当前连接状态。回到前台即停（前台本来就活着，不占通知栏）。
 * 服务只保进程与报状态，不拥有 SSE——EventStream 仍归 SessionStore 管。
 */
class KeepAliveService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Deva 连接状态", NotificationManager.IMPORTANCE_LOW).apply {
                description = "后台保活时的连接状态常驻通知"
                setShowBadge(false)
            }
        )
        // startForeground 必须在 startForegroundService 后 5 秒内：先发一帧再随状态更新
        startForeground(NOTIFICATION_ID, notification("", ""))
        scope.launch {
            combine(AppGraph.sessions.streamState, AppGraph.current) { st, srv -> st to srv?.name }
                .collect { (st, name) -> nm.notify(NOTIFICATION_ID, notification(st, name ?: "")) }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(state: String, server: String): Notification {
        val title = when (state) {
            "live" -> "Deva 已连接"
            "reconnecting" -> "Deva 重连中…"
            "connecting" -> "Deva 连接中…"
            else -> "Deva 后台保活中"
        }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_deva)
            .setContentTitle(title)
            .setContentText(if (server.isEmpty()) "保持与电脑端 Deva 的事件流" else "$server · 保持事件流")
            .setOngoing(true)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val CHANNEL = "deva_keepalive"
        const val NOTIFICATION_ID = 1001
    }
}
