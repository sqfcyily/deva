import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n/i18n'
import type { SessionMeta } from '../store/chat'

export function useThreadContinuation(sessions: SessionMeta[], openThread: (id: string) => void) {
  const { t } = useI18n()
  const toast = useToast()

  async function continueThread(id: string): Promise<boolean> {
    try {
      const next = await window.deva.chat.continueSession(id)
      if (!next) throw new Error('Source conversation unavailable')
      openThread(next)
      toast.show({ message: t('cf.continuedChat') })
      return true
    } catch {
      toast.show({ variant: 'error', message: t('cf.continueChatFailed') })
      return false
    }
  }

  async function copyThreadWorkspace(id: string): Promise<void> {
    try {
      const source = sessions.find((session) => session.id === id)
      if (!source) throw new Error('Source conversation unavailable')
      const path = source.focusRoot || (await window.deva.workspace.roleHome(source.personaId ?? '')).path
      await window.deva.clipboard.writeText(path)
      toast.show({ message: t('cf.copiedThreadWorkspace') })
    } catch {
      toast.show({ variant: 'error', message: t('cf.copyThreadWorkspaceFailed') })
    }
  }

  return { continueThread, copyThreadWorkspace }
}
