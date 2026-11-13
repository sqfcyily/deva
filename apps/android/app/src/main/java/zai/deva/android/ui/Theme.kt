package zai.deva.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * 深色优先的主题（设计 §5 / P5）：深色 scheme 与桌面端底色 #1e1e20 对齐，强调色 Deva 品牌蓝；
 * 排版基线——正文 ≥15sp（bodyMedium 15sp、bodyLarge 16sp），辅助行 12sp 只用于元信息，不承载正文。
 */

private val Accent = Color(0xFF4C8DFF)

// primaryContainer 是 FAB / Snackbar 等容器的底色：不显式给定会落到 M3 基线紫，
// 与「强调色与桌面一致」（设计 §5）不符，这里两套 scheme 都钉成品牌蓝的 tonal 变体。
private val DarkScheme = darkColorScheme(
    primary = Accent,
    primaryContainer = Color(0xFF2E4B86),
    onPrimaryContainer = Color(0xFFD9E6FF),
    background = Color(0xFF1E1E20),
    surface = Color(0xFF1E1E20),
    surfaceVariant = Color(0xFF2A2A2E),
    onBackground = Color(0xFFE4E4E7),
    onSurface = Color(0xFFE4E4E7),
    onSurfaceVariant = Color(0xFFA1A1AA)
)

private val LightScheme = lightColorScheme(
    primary = Accent,
    primaryContainer = Color(0xFFD8E2FF),
    onPrimaryContainer = Color(0xFF0A2A5E)
)

private val AppTypography = Typography(
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
)

@Composable
fun DevaTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = AppTypography,
        content = content
    )
}
