package zai.deva.android

import android.content.Intent
import android.util.Log
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import zai.deva.android.ui.ChatScreen
import zai.deva.android.ui.DevaTheme
import zai.deva.android.ui.HomeScreen
import zai.deva.android.ui.SettingsScreen
import zai.deva.android.ui.TasksScreen

/**
 * 单 Activity + Compose Navigation（设计 §4）：home（服务器 + 会话列表）→ chat/:sessionId / settings / tasks。
 */
class MainActivity : ComponentActivity() {

    private var navigateToSettings: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleDevaLink(intent)
        enableEdgeToEdge()
        setContent {
            DevaTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val nav = rememberNavController()
                    navigateToSettings = { nav.navigate("settings") }
                    NavHost(navController = nav, startDestination = "home") {
                        composable("home") {
                            HomeScreen(
                                onOpenChat = { sid -> nav.navigate("chat/$sid") },
                                onOpenSettings = { nav.navigate("settings") },
                                onOpenTasks = { nav.navigate("tasks") }
                            )
                        }
                        composable("chat/{sid}") { entry ->
                            val sid = entry.arguments?.getString("sid").orEmpty()
                            ChatScreen(
                                sessionId = sid,
                                onBack = { nav.popBackStack() },
                                onOpenSettings = { nav.navigate("settings") }
                            )
                        }
                        composable("settings") {
                            SettingsScreen(onBack = { nav.popBackStack() })
                        }
                        composable("tasks") {
                            TasksScreen(
                                onBack = { nav.popBackStack() },
                                onOpenChat = { sid -> nav.navigate("chat/$sid") }
                            )
                        }
                    }
                }
            }
        }
    }

    /** 已启动实例再收深链(singleTask):onNewIntent 导航到设置页。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDevaLink(intent)
    }

    /** deva://pair?host=&port=&code= → 预填待配对链接(设置页消费)。 */
    private fun handleDevaLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "deva" || data.host != "pair") return
        val host = data.getQueryParameter("host") ?: return
        val port = data.getQueryParameter("port")?.toIntOrNull() ?: return
        val code = data.getQueryParameter("code")?.takeIf { it.length == 6 } ?: return
        zai.deva.android.AppGraph.pendingPairLink.value =
            zai.deva.android.AppGraph.GeneralPairLink(host, port, code)
        Log.d("deva-dl", "深链入队 host=$host port=$port code=$code")
        navigateToSettings?.invoke()
    }
}
