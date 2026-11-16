import React from 'react'
import ReactDOM from 'react-dom/client'
import './mobile.css'
import { App } from './App'
import { parseWebPageParams } from '../shared/remote-web'

// 页面开着时又扫了一次码（浏览器复用了这个标签页，只改了 # 后面）：带票据的地址要重新走一遍启动流程。
window.addEventListener('hashchange', () => {
  const p = parseWebPageParams(location.hash)
  if (p.p || p.i || p.o) location.reload()
})

/** 手机网页端入口（由桌面端自带的 HTTP 服务或中转托管；见 vite.mobile.config.ts）。 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
