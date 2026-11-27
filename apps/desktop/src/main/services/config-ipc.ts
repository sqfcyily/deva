import { app, ipcMain } from 'electron'
import { getConfig, setConfig, setUserHomeResolver } from './config'

// 在主入口装配桌面路径，只注册取值函数，不提前访问磁盘。
setUserHomeResolver(() => app.getPath('home'))

export function registerConfigIpc(): void {
  getConfig()
  // 渲染层首帧同步读取主题/语言以避免闪烁；其余调用沿用异步接口。
  ipcMain.on('config:get-sync', (evt) => {
    evt.returnValue = getConfig()
  })
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, patch: Record<string, unknown>) => {
    setConfig(patch)
    return { ok: true as const }
  })
}
