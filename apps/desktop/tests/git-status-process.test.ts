import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import {
  cancelGitStatusScans, resolveStatusGitPath, runBoundedGitStatus
} from '../src/main/services/git-status-process'

async function fixture(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'deva-git-process-test-'))
  t.after(async () => {
    const target = resolve(dir)
    assert(target.startsWith(await fs.realpath(tmpdir()) + sep))
    assert(target.includes('deva-git-process-test-'))
    await fs.rm(target, { recursive: true, force: true })
  })
  return dir
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((res) => setTimeout(res, 25))
  }
  throw new Error('condition did not become true before deadline')
}

test('bounded runner captures successful output and reports spawn errors', async () => {
  const ok = await runBoundedGitStatus(process.execPath, process.cwd(), ['-e', 'process.stdout.write("ok")'])
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout, 'ok')
  const missing = await runBoundedGitStatus(join(process.cwd(), 'missing-deva-test-executable'), process.cwd(), [])
  assert.notEqual(missing.code, 0)
  assert.equal(missing.stdout, '')
})

test('Windows status bypasses only the known Git cmd/bin launcher layout', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const dir = await fixture(t)
  const native = join(dir, 'mingw64', 'bin', 'git.exe')
  await fs.mkdir(join(dir, 'cmd'))
  await fs.mkdir(join(dir, 'bin'))
  await fs.mkdir(join(dir, 'mingw64', 'bin'), { recursive: true })
  await fs.writeFile(native, 'fixture, never executed')
  assert.equal(resolveStatusGitPath(join(dir, 'cmd', 'git.exe')), native)
  assert.equal(resolveStatusGitPath(join(dir, 'bin', 'git.exe')), native)
  assert.equal(resolveStatusGitPath(native), native)
  const custom = join(dir, 'my-git.exe')
  assert.equal(resolveStatusGitPath(custom), custom)
})

test('combined stdout/stderr cap terminates instead of retaining partial status', async () => {
  const result = await runBoundedGitStatus(process.execPath, process.cwd(), [
    '-e', 'process.stdout.write("x".repeat(768)); process.stderr.write("y".repeat(768)); setInterval(()=>{},1000)'
  ], { maxOutputBytes: 1024, timeoutMs: 3000 })
  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /safety limit/)
})

test('timeout kills the owned descendant tree, not unrelated processes', { timeout: 15_000 }, async (t) => {
  const dir = await fixture(t)
  const pidFile = join(dir, 'descendant.pid')
  const grandchild = 'setInterval(()=>{},1000)'
  const parentScript = `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',windowsHide:true});
    c.on('spawn',()=>fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)));
    setInterval(()=>{},1000);
  `
  const unrelated = spawn(process.execPath, ['-e', grandchild], { windowsHide: true, stdio: 'ignore' })
  await new Promise<void>((res, rej) => { unrelated.once('spawn', res); unrelated.once('error', rej) })
  t.after(() => { unrelated.kill('SIGKILL') })
  let descendant = 0
  t.after(() => {
    if (descendant && alive(descendant)) {
      try { process.kill(descendant, 'SIGKILL') } catch { /* already exited */ }
    }
  })
  const pending = runBoundedGitStatus(process.execPath, dir, ['-e', parentScript], { timeoutMs: 1500 })
  await waitUntil(async () => {
    descendant = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0'))
    return descendant > 0
  })
  const result = await pending
  assert.match(result.stderr, /timed out/)
  await waitUntil(async () => !alive(descendant))
  assert.equal(alive(unrelated.pid!), true)
})

test('application shutdown cancels an active owned status process', async () => {
  const pending = runBoundedGitStatus(process.execPath, process.cwd(), [
    '-e', 'setInterval(()=>{},1000)'
  ])
  cancelGitStatusScans()
  const result = await pending
  assert.match(result.stderr, /cancelled/)
})
