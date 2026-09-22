import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './App'
import { ThemeProvider } from './theme/ThemeContext'
import { I18nProvider } from './i18n/i18n'
import { DialogProvider } from './components/DialogProvider'
import { ToastProvider } from './components/ToastProvider'
import { ModelsProvider } from './store/models'
import { ExtensionsProvider } from './store/extensions'
import { WorkspaceProvider } from './store/workspace'
import { ChatProvider } from './store/chat'
import { TasksProvider } from './store/tasks'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <DialogProvider>
          <ToastProvider>
            <ModelsProvider>
              <ExtensionsProvider>
                <WorkspaceProvider>
                  <ChatProvider>
                    <TasksProvider>
                      <App />
                    </TasksProvider>
                  </ChatProvider>
                </WorkspaceProvider>
              </ExtensionsProvider>
            </ModelsProvider>
          </ToastProvider>
        </DialogProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>
)
