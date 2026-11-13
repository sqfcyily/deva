package zai.deva.android.core

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * 应用级开关（设计 §4 / P4）：后台保活（默认关——前台服务是可选能力）、断线自动重连（默认开，
 * EventStream 退避续传的闸门）。SharedPreferences 持久化，StateFlow 供设置页与观测者读。
 */
class AppPrefs(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private val _keepAlive = MutableStateFlow(prefs.getBoolean(KEY_KEEPALIVE, false))
    val keepAlive: StateFlow<Boolean> = _keepAlive

    private val _reconnect = MutableStateFlow(prefs.getBoolean(KEY_RECONNECT, true))
    val reconnect: StateFlow<Boolean> = _reconnect

    fun setKeepAlive(on: Boolean) {
        _keepAlive.value = on
        prefs.edit().putBoolean(KEY_KEEPALIVE, on).apply()
    }

    fun setReconnect(on: Boolean) {
        _reconnect.value = on
        prefs.edit().putBoolean(KEY_RECONNECT, on).apply()
    }

    private companion object {
        const val FILE = "deva_prefs"
        const val KEY_KEEPALIVE = "keepAlive"
        const val KEY_RECONNECT = "reconnect"
    }
}
