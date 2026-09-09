import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 两个主进程入口：常规 main 与运行 node-pty 的 Utility Process 宿主。
        // 分别产出 out/main/index.js 与 out/main/pty-host.js（均 CJS、externalize 依赖）。
        input: {
          index: resolve('src/main/index.ts'),
          'pty-host': resolve('src/main/pty-host.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    // 固定绑定 IPv4 回环：Node 18+ 下 localhost 常先解析到 IPv6(::1)，
    // 而 Electron 主进程加载 URL 走 127.0.0.1，二者错位会导致
    // dev 模式 ERR_CONNECTION_REFUSED。显式绑 127.0.0.1 + 定端口即可根治。
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    }
  }
})
