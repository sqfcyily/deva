import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './features/browser/browser.css'
import { ThemeProvider } from './theme/ThemeContext'
import { I18nProvider } from './i18n/i18n'
import { BrowserChrome } from './features/browser/BrowserChrome'

/** 「Deva 浏览器」窗口的外框界面（主进程 browser/host.ts 载入 browser.html）。 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <BrowserChrome />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
)
