package zai.deva.android.core

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.GeneralSecurityException
import java.io.IOException

/**
 * EncryptedSharedPreferences 封装（设计 §4）：按 deviceId 存 token，不进任何明文配置。
 */
interface SecureStore {
    fun saveToken(deviceId: String, token: String)
    fun loadToken(deviceId: String): String?
    fun removeToken(deviceId: String)
}

class EncryptedSecureStore(context: Context) : SecureStore {

    private val appContext = context.applicationContext

    // 惰性创建：部分机型 KeyStore 可能损坏（AEADBadTagException 等），失败时清掉密文文件重建一次，
    // 代价只是丢一次 token（重新配对即可），好过永久打不开。
    private val prefs: EncryptedSharedPreferences by lazy {
        try {
            create()
        } catch (e: GeneralSecurityException) {
            Log.w(TAG, "加密存储打开失败，重置后重建：", e)
            reset()
            try {
                create()
            } catch (e2: Exception) {
                throw IllegalStateException("安全存储不可用", e2)
            }
        } catch (e: IOException) {
            Log.w(TAG, "加密存储打开失败（IO），重置后重建：", e)
            reset()
            try {
                create()
            } catch (e2: Exception) {
                throw IllegalStateException("安全存储不可用", e2)
            }
        }
    }

    private fun create(): EncryptedSharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        ) as EncryptedSharedPreferences
    }

    private fun reset() {
        appContext.deleteSharedPreferences(FILE)
    }

    override fun saveToken(deviceId: String, token: String) {
        prefs.edit().putString(key(deviceId), token).apply()
    }

    override fun loadToken(deviceId: String): String? =
        prefs.getString(key(deviceId), null)

    override fun removeToken(deviceId: String) {
        prefs.edit().remove(key(deviceId)).apply()
    }

    private fun key(deviceId: String): String = "token:$deviceId"

    private companion object {
        const val TAG = "SecureStore"
        const val FILE = "deva_secure_prefs"
    }
}
