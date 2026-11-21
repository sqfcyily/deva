import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import type { GitParsedStatus, GitStatus, GitStatusOptions } from '../../shared/git-status'
import { runBoundedGitStatus, STATUS_TIMEOUT_MS } from './git-status-process'

const MAX_METADATA_BYTES = 4096
const MAX_ANCESTORS = 64

function emptyStatus(root: string): GitStatus {
  return {
    isRepo: false, root, branch: null, detached: false, upstream: null,
    ahead: 0, behind: 0, remotes: [], mergeInProgress: false,
    staged: [], unstaged: [], conflicts: [], scanState: 'not-scanned'
  }
}

/** Never read an index, enumerate a directory, or load an arbitrarily large gitfile/HEAD. */
async function readSmallFile(path: string): Promise<string | null> {
  const before = await fs.stat(path)
  if (!before.isFile() || before.size > MAX_METADATA_BYTES) return null
  const handle = await fs.open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return null
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > MAX_METADATA_BYTES ? null : buffer.subarray(0, bytesRead).toString('utf8').trim()
  } finally {
    await handle.close()
  }
}

/** Background discovery is bounded metadata I/O only, including linked worktrees. */
export async function readGitMetadata(dir: string): Promise<GitStatus> {
  const absolute = resolve(dir)
  let root = await fs.realpath(absolute).catch(() => absolute)
  for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
    const marker = join(root, '.git')
    let foundMarker = false
    try {
      const stat = await fs.stat(marker)
      foundMarker = true
      let gitDir = marker
      if (!stat.isDirectory()) {
        if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return emptyStatus(absolute)
        const pointer = await readSmallFile(marker)
        const match = pointer && /^gitdir: ([^\r\n\0]+)$/.exec(pointer)
        if (!match) return emptyStatus(absolute)
        gitDir = resolve(root, match[1])
      }
      const head = await readSmallFile(join(gitDir, 'HEAD'))
      const branch = head && /^ref: refs\/heads\/([^\x00-\x20\x7f]+)$/.exec(head)
      const detached = Boolean(head && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head))
      if (!branch && !detached) return emptyStatus(absolute)
      return {
        ...emptyStatus(root),
        isRepo: true,
        branch: branch ? branch[1] : null,
        detached,
        mergeInProgress: await fs.stat(join(gitDir, 'MERGE_HEAD')).then((s) => s.isFile(), () => false)
      }
    } catch (error) {
      // A broken gitfile/HEAD is not permission to discover a wider parent repo.
      if (foundMarker || (error as NodeJS.ErrnoException).code !== 'ENOENT') return emptyStatus(absolute)
    }
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  return emptyStatus(absolute)
}

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** A mistakenly initialized home/drive repository must not enumerate the whole disk. */
export function isUnsafeStatusRoot(root: string): boolean {
  const home = homedir()
  const blocked = [parse(root).root, home]
  if (process.platform === 'win32') {
    blocked.push(dirname(home))
    for (const name of ['USERPROFILE', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      const value = process.env[name]
      if (value) blocked.push(value)
    }
  }
  return blocked.some((path) => pathKey(path) === pathKey(root))
}

function failedStatus(summary: GitStatus, message: string): GitStatus {
  return { ...summary, scanState: 'failed', scanError: message.slice(0, 4000) }
}

interface StatusDependencies {
  assertInside: (path: string) => void
  insideRootFlags: (paths: string[]) => Promise<boolean[]>
  resolveGitPath: () => string | null
  parseStatus: (stdout: string, root: string) => GitParsedStatus
  run?: typeof runBoundedGitStatus
}

/** One in-flight scan app-wide; same-repository callers share it, others fail fast. */
export function createGitStatusService(deps: StatusDependencies): {
  status: (dir: string, options?: GitStatusOptions) => Promise<GitStatus>
} {
  let active: { key: string; promise: Promise<GitStatus> } | undefined
  const requested = new Map<string, Promise<GitStatus>>()
  const run = deps.run ?? runBoundedGitStatus

  async function scan(summary: GitStatus): Promise<GitStatus> {
    try {
      // Do not expand a trusted subfolder into a scan of an untrusted ancestor.
      deps.assertInside(summary.root)
      const git = deps.resolveGitPath()
      if (!git) return failedStatus(summary, 'Git is not available')
      const deadline = Date.now() + STATUS_TIMEOUT_MS
      const command = async (args: string[]): Promise<string> => {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('Git status scan timed out')
        const result = await run(git, summary.root, args, { timeoutMs: remaining })
        if (result.code !== 0) throw new Error(result.stderr || 'Git status scan failed')
        return result.stdout
      }
      // core.worktree / inherited GIT_* settings must not silently redirect the scan.
      const top = (await command(['rev-parse', '--show-toplevel'])).trim()
      const actualRoot = top && await fs.realpath(top)
      if (!actualRoot || pathKey(actualRoot) !== pathKey(summary.root)) {
        throw new Error('Git worktree differs from the opened repository; open its project root explicitly')
      }
      const output = await command([
        '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'
      ])
      const parsed = deps.parseStatus(output, summary.root)
      const keepInside = async (list: GitStatus['staged']): Promise<GitStatus['staged']> => {
        const ok = await deps.insideRootFlags(list.map((file) => file.path))
        return list.filter((_, i) => ok[i])
      }
      const [staged, unstaged, conflicts] = await Promise.all([
        keepInside(parsed.staged), keepInside(parsed.unstaged), keepInside(parsed.conflicts)
      ])
      const remotes = (await command(['remote'])).split(/\r?\n/).filter(Boolean)
      return { ...summary, ...parsed, staged, unstaged, conflicts, remotes, scanState: 'complete' }
    } catch (error) {
      return failedStatus(summary, error instanceof Error ? error.message : 'Git status scan failed')
    }
  }

  async function manualStatus(dir: string): Promise<GitStatus> {
    const summary = await readGitMetadata(dir)
    if (!summary.isRepo) return summary
    if (isUnsafeStatusRoot(summary.root)) {
      return failedStatus(summary, 'Open a project repository instead of a drive, home or system directory')
    }
    const key = pathKey(summary.root)
    if (active) {
      return active.key === key
        ? active.promise
        : failedStatus(summary, 'Another Git status scan is already running; try again when it finishes')
    }
    // scan starts in a microtask so the slot exists even if a dependency throws.
    const promise = Promise.resolve().then(() => scan(summary))
    active = { key, promise }
    try {
      return await promise
    } finally {
      if (active?.promise === promise) active = undefined
    }
  }

  return {
    async status(dir, options) {
      deps.assertInside(dir)
      // Strict opt-in: old callers, null options and truthy strings cannot start Git.
      if (options?.scan !== true) return readGitMetadata(dir)
      const key = pathKey(dir)
      const existing = requested.get(key)
      if (existing) return existing
      // Coalesce before metadata I/O too, so a quick scan cannot race its duplicate.
      const promise = manualStatus(dir)
      requested.set(key, promise)
      try {
        return await promise
      } finally {
        if (requested.get(key) === promise) requested.delete(key)
      }
    }
  }
}
