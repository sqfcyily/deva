// 独立 Gradle 工程（不进 pnpm workspace）：安卓客户端的根构建脚本。
// 插件版本集中在这里声明，app/ 里只引用不带货。
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
