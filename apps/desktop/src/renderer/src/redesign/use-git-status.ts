import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus } from '../../../shared/git-status'

/** git 是否可用：全应用只探一次（缓存 Promise），避免每次挂载都 spawn 一次 --version。 */
let gitAvailablePromise: Promise<boolean> | null = null

function probeGitAvailable(): Promise<boolean> {
  if (!gitAvailablePromise) {
    gitAvailablePromise = window.deva.git
      .available()
      .then((r) => r.available)
      .catch(() => false)
  }
  return gitAvailablePromise
}

interface GitState {
  available: boolean
  status: GitStatus | null
  busy: boolean
  refresh: () => Promise<void>
}

/**
 * 读取某工作区的 git 状态。不轮询（status 每次 spawn git 进程，且当前无文件监听）：
 * 只在「挂载 / 开菜单 / 每次写操作后」拉取。用 reqRef 防竞态——快速切换工作区时旧结果不覆盖新。
 */
export function useGitStatus(root: string | null): GitState {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++reqRef.current
    if (!root) {
      setAvailable(false)
      setStatus(null)
      return
    }
    const ok = await probeGitAvailable()
    if (seq !== reqRef.current) return
    setAvailable(ok)
    if (!ok) {
      setStatus(null)
      return
    }
    setBusy(true)
    try {
      const st = await window.deva.git.status(root)
      if (seq !== reqRef.current) return
      setStatus(st.isRepo ? st : null)
    } catch {
      if (seq === reqRef.current) setStatus(null)
    } finally {
      if (seq === reqRef.current) setBusy(false)
    }
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { available, status, busy, refresh }
}

