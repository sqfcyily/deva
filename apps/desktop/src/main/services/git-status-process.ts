import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'

export interface GitStatusCommandResult {
  code: number
  stdout: string
  stderr: string
}

export const STATUS_TIMEOUT_MS = 10_000
export const STATUS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const activeScans = new Set<(reason: string) => void>()

/** Git for Windows cmd/bin launchers can outlive execFile's direct-child timeout. */
export function resolveStatusGitPath(executable: string): string {
  if (process.platform !== 'win32' || win32.basename(executable).toLowerCase() !== 'git.exe') {
    return executable
  }
  const parent = win32.dirname(executable)
  if (!['cmd', 'bin'].includes(win32.basename(parent).toLowerCase())) return executable
  const root = win32.dirname(parent)
  for (const arch of ['mingw64', 'mingw32']) {
    const native = win32.join(root, arch, 'bin', 'git.exe')
    if (existsSync(native)) return native
  }
  return executable
}

/** Only terminate the tree/group created by this invocation; never kill Git by name. */
function killOwnedTree(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid
  if (!pid) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 64 * 1024
    }, (error) => {
      if (error) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
      resolve()
    })
  })
}

export function cancelGitStatusScans(): void {
  for (const stop of activeScans) stop('Git status scan cancelled')
}

/**
 * Read-only status commands get their own small budget, separate from writes/remotes.
 * The byte cap bounds captured output, not Git's own RSS. Avoiding automatic scans is
 * the primary memory protection; deadlines and owned-tree cleanup are a second line.
 */
export function runBoundedGitStatus(
  executable: string,
  cwd: string,
  args: string[],
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<GitStatusCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(resolveStatusGitPath(executable), args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure = ''
    let cleanup: Promise<void> | undefined
    const stop = (reason: string): void => {
      if (failure) return
      failure = reason
      cleanup = killOwnedTree(child)
    }
    activeScans.add(stop)
    const timer = setTimeout(() => stop('Git status scan timed out'), limits.timeoutMs ?? STATUS_TIMEOUT_MS)
    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (failure) return
      bytes += chunk.length
      if (bytes > (limits.maxOutputBytes ?? STATUS_MAX_OUTPUT_BYTES)) {
        stop('Git status output exceeded the safety limit')
        return
      }
      target.push(chunk)
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error) => { failure ||= error.message })
    child.once('close', (code) => {
      clearTimeout(timer)
      activeScans.delete(stop)
      void Promise.resolve(cleanup).then(() => resolve({
        code: failure ? 1 : code ?? 1,
        stdout: failure ? '' : Buffer.concat(stdout).toString('utf8'),
        stderr: failure || Buffer.concat(stderr).toString('utf8')
      }))
    })
  })
}
