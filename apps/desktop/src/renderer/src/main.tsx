import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './App'
import { ThemeProvider } from './theme/ThemeContext'
import { I18nProvider } from './i18n/i18n'
import { DialogProvider } from './components/DialogProvider'
import { UIProvider } from './store/ui'
import { ModelsProvider } from './store/models'
import { ExtensionsProvider } from './store/extensions'
import { WorkspaceProvider } from './store/workspace'
import { GitProvider } from './store/git'
import { ChatProvider } from './store/chat'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <DialogProvider>
          <ModelsProvider>
            <ExtensionsProvider>
              <WorkspaceProvider>
                <GitProvider>
                  <ChatProvider>
                    <UIProvider>
                      <App />
                    </UIProvider>
                  </ChatProvider>
                </GitProvider>
              </WorkspaceProvider>
            </ExtensionsProvider>
          </ModelsProvider>
        </DialogProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
)
