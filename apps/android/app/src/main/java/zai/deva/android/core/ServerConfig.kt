package zai.deva.android.core

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * 服务器条目（设计 §4）：一台已添加的 Deva 桌面端。
 * 只存非敏感信息；token 明文由 SecureStore 按 deviceId 保管，不进这里。
 */
data class ServerConfig(
    /** 本地生成的条目 id（与桌面端 deviceId 无关）。 */
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    /** 配对成功后桌面端返回的设备 id；空串 = 尚未配对。 */
    val deviceId: String = ""
)

/**
 * 服务器列表的持久化与当前选中项（SharedPreferences + org.json，设计 §4 的 SessionStore 前置）。
 * 列表与 currentId 各存一个键；全部写入是幂等快照，没有迁移问题。
 */
class ServerStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private val _servers = MutableStateFlow<List<ServerConfig>>(emptyList())
    val servers: StateFlow<List<ServerConfig>> = _servers

    private val _currentId = MutableStateFlow<String?>(null)
    val currentId: StateFlow<String?> = _currentId

    /** 启动时装载（DevaApp.onCreate 调一次）。 */
    fun load() {
        val list = try {
            val arr = JSONArray(prefs.getString(KEY_SERVERS, "[]") ?: "[]")
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                ServerConfig(
                    id = o.getString("id"),
                    name = o.optString("name"),
                    host = o.getString("host"),
                    port = o.optInt("port", 4317),
                    deviceId = o.optString("deviceId")
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "服务器列表解析失败，按空列表处理", e)
            emptyList()
        }
        _servers.value = list
        val cur = prefs.getString(KEY_CURRENT, null)
        _currentId.value = cur?.takeIf { c -> list.any { it.id == c } } ?: list.firstOrNull()?.id
    }

    fun add(name: String, host: String, port: Int): ServerConfig {
        val s = ServerConfig(
            id = "srv_${System.currentTimeMillis().toString(36)}_${(0..1679615).random().toString(36)}",
            name = name.ifBlank { "$host:$port" },
            host = host,
            port = port
        )
        _servers.value = _servers.value + s
        if (_currentId.value == null) _currentId.value = s.id
        persist()
        return s
    }

    fun remove(id: String) {
        _servers.value = _servers.value.filterNot { it.id == id }
        if (_currentId.value == id) _currentId.value = _servers.value.firstOrNull()?.id
        persist()
    }

    fun setCurrent(id: String) {
        if (_servers.value.any { it.id == id }) {
            _currentId.value = id
            persist()
        }
    }

    /** 配对成功后回填 deviceId（token 已另存 SecureStore）。 */
    fun updateDevice(id: String, deviceId: String) {
        _servers.value = _servers.value.map { if (it.id == id) it.copy(deviceId = deviceId) else it }
        persist()
    }

    private fun persist() {
        val arr = JSONArray()
        for (s in _servers.value) {
            arr.put(
                JSONObject()
                    .put("id", s.id)
                    .put("name", s.name)
                    .put("host", s.host)
                    .put("port", s.port)
                    .put("deviceId", s.deviceId)
            )
        }
        prefs.edit()
            .putString(KEY_SERVERS, arr.toString())
            .putString(KEY_CURRENT, _currentId.value)
            .apply()
    }

    private companion object {
        const val TAG = "ServerStore"
        const val FILE = "deva_servers"
        const val KEY_SERVERS = "servers"
        const val KEY_CURRENT = "currentId"
    }
}
