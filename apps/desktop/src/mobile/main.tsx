import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import './mobile.css'
import { App } from './App'
import { parseWebPageParams } from '../shared/remote-web'
import { hideBoot, prepareIosStartupImage } from './splash'

// 页面开着时又扫了一次码（浏览器复用了这个标签页，只改了 # 后面）：带票据的地址要重新走一遍启动流程。
window.addEventListener('hashchange', () => {
  const p = parseWebPageParams(location.hash)
  if (p.p || p.i || p.o) location.reload()
})

/** 首屏渲染好后撤掉启动底层（index.html 的 #boot）。 */
function Root(): React.JSX.Element {
  useEffect(hideBoot, [])
  return <App />
}

/** 手机网页端入口（由桌面端自带的 HTTP 服务或中转托管；见 vite.mobile.config.ts）。 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
prepareIosStartupImage()
