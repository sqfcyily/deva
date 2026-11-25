import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import test from 'node:test'
import type { GitParsedStatus, GitStatusOptions } from '../src/shared/git-status'
import { createGitStatusService, isUnsafeStatusRoot, readGitMetadata } from '../src/main/services/git-status'
import { resolveStatusGitPath } from '../src/main/services/git-status-process'

const parsed: GitParsedStatus = {
  branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0,
  staged: [], unstaged: [], conflicts: []
}

async function fixture(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'deva-git-status-test-'))
  t.after(async () => {
    // A test may only recursively remove the concrete temporary directory it created.
    const target = resolve(dir)
    const parent = await fs.realpath(tmpdir())
    assert(target.startsWith(parent + sep), 'cleanup must stay below the temporary directory')
    assert(target.includes('deva-git-status-test-'))
    await fs.rm(target, { recursive: true, force: true })
  })
  await fs.mkdir(join(dir, '.git'))
  await fs.writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
}

function dependencies() {
  return {
    assertInside: (_path: string) => {},
    insideRootFlags: async (paths: string[]) => paths.map(() => true),
    resolveGitPath: () => 'git',
    parseStatus: (_stdout: string, _root: string) => parsed
  }
}

function success(cwd: string, args: string[]) {
  return { code: 0, stdout: args[0] === 'rev-parse' ? cwd + '\n' : '', stderr: '' }
}

test('metadata finds branch/unborn HEAD and parent repository without walking files', async (t) => {
  const dir = await fixture(t)
  const nested = join(dir, 'nested', 'child')
  await fs.mkdir(nested, { recursive: true })
  // An unreadable/non-file index must be irrelevant to metadata discovery.
  await fs.mkdir(join(dir, '.git', 'index'))
  const result = await readGitMetadata(nested)
  assert.equal(result.root, await fs.realpath(dir))
  assert.equal(result.branch, 'main')
  assert.equal(result.scanState, 'not-scanned')
  assert.deepEqual(result.unstaged, [])
})

test('metadata supports linked worktree pointers, detached HEAD and merge state', async (t) => {
  const dir = await fixture(t)
  const worktree = join(dir, 'worktree')
  const metadata = join(dir, '.git', 'worktrees', 'test')
  await fs.mkdir(worktree)
  await fs.mkdir(metadata, { recursive: true })
  await fs.writeFile(join(worktree, '.git'), 'gitdir: ../.git/worktrees/test\n')
  await fs.writeFile(join(metadata, 'HEAD'), 'a'.repeat(40) + '\n')
  await fs.writeFile(join(metadata, 'MERGE_HEAD'), 'b'.repeat(40))
  const result = await readGitMetadata(worktree)
  assert.equal(result.root, await fs.realpath(worktree))
  assert.equal(result.detached, true)
  assert.equal(result.mergeInProgress, true)
})

test('oversized/malformed HEAD and gitfiles fail closed', async (t) => {
  const dir = await fixture(t)
  for (const head of ['x'.repeat(4097), 'ref: invalid\n', 'not-a-head']) {
    await fs.writeFile(join(dir, '.git', 'HEAD'), head)
    assert.equal((await readGitMetadata(dir)).isRepo, false)
  }
  const child = join(dir, 'child')
  await fs.mkdir(child)
  await fs.writeFile(join(child, '.git'), 'gitdir: ' + 'x'.repeat(4097))
  assert.equal((await readGitMetadata(child)).isRepo, false)
  await fs.writeFile(join(child, '.git'), 'gitdir: missing-metadata\n')
  assert.equal((await readGitMetadata(child)).isRepo, false)
})

test('default/background and non-boolean scan options never resolve or spawn Git', async (t) => {
  const dir = await fixture(t)
  let calls = 0
  const service = createGitStatusService({
    ...dependencies(),
    resolveGitPath: () => { calls++; throw new Error('background must not locate Git') },
    run: async () => { calls++; throw new Error('background must not spawn Git') }
  })
  for (const options of [
    undefined, {}, { scan: false }, null, { scan: 'true' }, { scan: 1 }
  ]) {
    const result = await service.status(dir, options as GitStatusOptions)
    assert.equal(result.scanState, 'not-scanned')
  }
  assert.equal(calls, 0)
})

test('trust checks happen before filesystem discovery or scans', async () => {
  let called = false
  const service = createGitStatusService({
    ...dependencies(),
    assertInside: () => { throw new Error('untrusted') },
    run: async () => { called = true; throw new Error('must not run') }
  })
  await assert.rejects(service.status('untrusted', { scan: true }), /untrusted/)
  assert.equal(called, false)
})

test('explicit scanning cannot expand a trusted subfolder to an untrusted parent', async (t) => {
  const dir = await fixture(t)
  const child = join(dir, 'child')
  await fs.mkdir(child)
  let calls = 0
  const service = createGitStatusService({
    ...dependencies(),
    assertInside: (path) => {
      if (resolve(path) !== resolve(child)) throw new Error('untrusted repository root')
    },
    run: async () => { calls++; throw new Error('must not run') }
  })
  const result = await service.status(child, { scan: true })
  assert.equal(result.scanState, 'failed')
  assert.match(result.scanError!, /untrusted/)
  assert.equal(calls, 0)
})

test('same-root concurrent scans coalesce and a different root fails fast', async (t) => {
  const first = await fixture(t)
  const second = await fixture(t)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((res) => { release = res })
  const running = new Promise<void>((res) => { started = res })
  let calls = 0
  const service = createGitStatusService({
    ...dependencies(),
    run: async (_git, cwd, args) => {
      calls++
      if (args.includes('status')) { started(); await gate }
      return args[0] === 'remote' ? { code: 0, stdout: 'origin\n', stderr: '' } : success(cwd, args)
    }
  })
  const one = service.status(first, { scan: true })
  await running
  const two = service.status(join(first, '.'), { scan: true })
  const blocked = await service.status(second, { scan: true })
  assert.equal(blocked.scanState, 'failed')
  assert.match(blocked.scanError!, /already running/)
  assert.equal(calls, 2)
  release()
  const [a, b] = await Promise.all([one, two])
  assert.equal(a, b)
  assert.equal(a.scanState, 'complete')
  assert.deepEqual(a.remotes, ['origin'])
  assert.equal(calls, 3) // rev-parse + status + remote, not one triplet per caller
  assert.equal((await service.status(second, { scan: true })).scanState, 'complete')
})

test('command failures are unknown, never clean, and release the scan slot', async (t) => {
  const dir = await fixture(t)
  let fail = true
  const service = createGitStatusService({
    ...dependencies(),
    run: async (_git, cwd, args) => fail
      ? { code: 1, stdout: '', stderr: 'scan timed out' }
      : success(cwd, args)
  })
  const result = await service.status(dir, { scan: true })
  assert.equal(result.isRepo, true)
  assert.equal(result.scanState, 'failed')
  assert.match(result.scanError!, /timed out/)
  fail = false
  assert.equal((await service.status(dir, { scan: true })).scanState, 'complete')
})

test('missing Git and thrown runner errors remain failed scans', async (t) => {
  const dir = await fixture(t)
  const missing = createGitStatusService({ ...dependencies(), resolveGitPath: () => null })
  assert.equal((await missing.status(dir, { scan: true })).scanState, 'failed')
  const throwing = createGitStatusService({
    ...dependencies(),
    run: async () => { throw new Error('spawn failed') }
  })
  for (let i = 0; i < 2; i++) {
    const result = await throwing.status(dir, { scan: true })
    assert.equal(result.scanState, 'failed')
    assert.match(result.scanError!, /spawn failed/)
  }
})

test('background metadata does not join an already running manual scan', async (t) => {
  const dir = await fixture(t)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((res) => { release = res })
  const running = new Promise<void>((res) => { started = res })
  const service = createGitStatusService({
    ...dependencies(),
    run: async (_git, cwd, args) => {
      if (args.includes('status')) { started(); await gate }
      return success(cwd, args)
    }
  })
  const pending = service.status(dir, { scan: true })
  await running
  const metadata = await service.status(dir)
  assert.equal(metadata.scanState, 'not-scanned')
  release()
  assert.equal((await pending).scanState, 'complete')
})

test('explicit scan preserves -uall/NUL semantics and filters untrusted paths', async (t) => {
  const dir = await fixture(t)
  const file = (name: string) => ({
    path: join(dir, name), rel: name, name, dir: '', letter: 'U' as const,
    staged: false, unstaged: true, conflicted: false, untracked: true
  })
  const service = createGitStatusService({
    ...dependencies(),
    parseStatus: () => ({ ...parsed, unstaged: [file('safe.txt'), file('outside')] }),
    insideRootFlags: async (paths) => paths.map((p) => p !== join(dir, 'outside')),
    run: async (_git, cwd, args, limits) => {
      assert.equal(cwd, await fs.realpath(dir))
      assert(limits!.timeoutMs! <= 10_000)
      if (args.includes('status')) {
        assert(args.includes('--untracked-files=all'))
        assert(args.includes('-z'))
        assert(args.includes('core.fsmonitor=false'))
      }
      return success(cwd, args)
    }
  })
  const result = await service.status(dir, { scan: true })
  assert.deepEqual(result.unstaged.map((f) => f.rel), ['safe.txt'])
})

test('a Git configuration redirect cannot turn a project scan into an ancestor scan', async (t) => {
  const dir = await fixture(t)
  let calls = 0
  const service = createGitStatusService({
    ...dependencies(),
    run: async () => {
      calls++
      return { code: 0, stdout: dirname(dir) + '\n', stderr: '' }
    }
  })
  const result = await service.status(dir, { scan: true })
  assert.equal(result.scanState, 'failed')
  assert.match(result.scanError!, /worktree differs/)
  assert.equal(calls, 1)
})

test('drive roots, user profiles and system directories cannot be status scan roots', () => {
  assert.equal(isUnsafeStatusRoot(parse(homedir()).root), true)
  assert.equal(isUnsafeStatusRoot(homedir()), true)
  assert.equal(isUnsafeStatusRoot(join(homedir(), 'project')), false)
  if (process.platform === 'win32') {
    assert.equal(isUnsafeStatusRoot(dirname(homedir())), true)
    if (process.env.SystemRoot) assert.equal(isUnsafeStatusRoot(process.env.SystemRoot), true)
  }
})

test('integration: explicit scan handles real Git output in a tiny disposable repository', async (t) => {
  const dir = await fixture(t)
  // fixture's hand-written metadata is a valid starting point for git init.
  const git = resolveStatusGitPath(process.env.DEVA_TEST_GIT || 'git')
  execFileSync(git, ['init', '--quiet', dir], { windowsHide: true })
  await fs.writeFile(join(dir, 'space and unicode-\u6d4b\u8bd5.txt'), 'hello\n')
  const service = createGitStatusService({
    ...dependencies(),
    resolveGitPath: () => git,
    parseStatus: (output) => {
      assert(output.includes('? space and unicode-\u6d4b\u8bd5.txt\0'))
      return parsed
    }
  })
  assert.equal((await service.status(dir)).scanState, 'not-scanned')
  assert.equal((await service.status(dir, { scan: true })).scanState, 'complete')
})
