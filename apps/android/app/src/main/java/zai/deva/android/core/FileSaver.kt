package zai.deva.android.core

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * 交付文件落盘（设计 §5-5）：Downloads/Deva/。
 * API 29+ 走 MediaStore.Downloads（无需存储权限）；26-28 走公共 Downloads 目录
 * （需 WRITE_EXTERNAL_STORAGE 运行时授权，被拒时回落应用外部私有目录，display 回实际路径供 UI 提示）。
 * 失败收尾（commit(false)）会清掉半截文件 / 未完成条目，不留垃圾。
 */
object FileSaver {

    /** 打开好的落盘目标：stream 写完即关，再按成败 commit。display 是给用户看的位置文案。 */
    class Target(
        val display: String,
        val stream: OutputStream,
        private val commit: (Boolean) -> Unit
    ) {
        fun finish(success: Boolean) {
            try {
                stream.flush()
            } catch (_: Exception) {
            }
            runCatching { stream.close() }
            commit(success)
        }
    }

    fun open(context: Context, name: String): Target =
        if (Build.VERSION.SDK_INT >= 29) mediaStoreTarget(context, name) else legacyTarget(context, name)

    // ── API 29+：MediaStore（Downloads/Deva/<name>；同名自动去重，无权限要求）──

    private fun mediaStoreTarget(context: Context, name: String): Target {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Deva")
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: return fallbackTarget(context, name)
        val stream = resolver.openOutputStream(uri) ?: return fallbackTarget(context, name)
        return Target("Downloads/Deva/$name", stream) { ok ->
            if (!ok) runCatching { resolver.delete(uri, null, null) }
        }
    }

    // ── API 26-28：公共 Downloads（需运行时授权）→ 被拒/失败回落应用外部私有目录 ──

    private fun legacyTarget(context: Context, name: String): Target {
        if (Environment.getExternalStorageState() == Environment.MEDIA_MOUNTED) {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Deva")
            val f = unique(File(dir, name))
            return try {
                dir.mkdirs()
                Target("Downloads/Deva/${f.name}", FileOutputStream(f)) { ok -> if (!ok) f.delete() }
            } catch (_: Exception) {
                fallbackTarget(context, name)
            }
        }
        return fallbackTarget(context, name)
    }

    private fun fallbackTarget(context: Context, name: String): Target {
        val dir = File(context.getExternalFilesDir(null) ?: context.filesDir, "Deva")
        dir.mkdirs()
        val f = unique(File(dir, name))
        return Target("${f.absolutePath}（无 Downloads 权限，暂存应用目录）", FileOutputStream(f)) { ok ->
            if (!ok) f.delete()
        }
    }

    /** 同名不覆盖：name.ext → "name (2).ext"。 */
    private fun unique(f: File): File {
        if (!f.exists()) return f
        val dot = f.name.lastIndexOf('.')
        val base = if (dot > 0) f.name.substring(0, dot) else f.name
        val ext = if (dot > 0) f.name.substring(dot) else ""
        var i = 2
        var cand = File(f.parentFile, "$base ($i)$ext")
        while (cand.exists()) {
            i++
            cand = File(f.parentFile, "$base ($i)$ext")
        }
        return cand
    }

    private fun mimeOf(name: String): String = when (File(name).extension.lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        "svg" -> "image/svg+xml"
        "pdf" -> "application/pdf"
        "txt", "md", "log", "csv" -> "text/plain"
        "json" -> "application/json"
        "html", "htm" -> "text/html"
        "mp4" -> "video/mp4"
        "webm" -> "video/webm"
        "mp3" -> "audio/mpeg"
        "wav" -> "audio/wav"
        "zip" -> "application/zip"
        else -> "application/octet-stream"
    }
}
