import React from 'react'
import ReactDOM from 'react-dom/client'
import './mobile.css'
import { App } from './App'

/** 手机网页端入口（由桌面端自带的 HTTP 服务或中转托管；见 vite.mobile.config.ts）。 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
