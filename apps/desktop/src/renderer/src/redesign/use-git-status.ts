import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus } from '../../../shared/git-status'

/** Mount/root changes never launch Git; only explicit refresh requests enumerate files. */
export function useGitStatus(root: string | null): {
  status: GitStatus | null
  busy: boolean
  refresh: (scan?: boolean) => Promise<GitStatus | null>
} {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const refresh = useCallback(async (scan = false): Promise<GitStatus | null> => {
    const seq = ++reqRef.current
    if (!root) {
      setStatus(null)
      setBusy(false)
      return null
    }
    setBusy(true)
    try {
      const st = await window.deva.git.status(root, { scan })
      if (seq !== reqRef.current) return null
      setStatus(st.isRepo ? st : null)
      return st
    } catch {
      if (seq === reqRef.current && !scan) setStatus(null)
      return null
    } finally {
      if (seq === reqRef.current) setBusy(false)
    }
  }, [root])

  useEffect(() => {
    void refresh()
    return () => { reqRef.current++ }
  }, [refresh])

  return { status, busy, refresh }
}
