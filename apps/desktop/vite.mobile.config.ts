import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 手机网页端（src/mobile）：独立的 Vite 构建，产物到 out/mobile，由桌面端自带的 HTTP 服务托管
 * （services/remote/web/server.ts），部署中转时也把这个目录整个复制到中转的静态资源里（apps/relay）。
 * base 用相对路径：同一份产物既能挂在根路径，也能挂在子路径或经反代访问。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  publicDir: resolve(__dirname, 'src/mobile/public'),
  resolve: {
    // 复用渲染层的头像组件（components/humation.tsx）等。
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') }
  },
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    target: 'es2020'
  }
})
