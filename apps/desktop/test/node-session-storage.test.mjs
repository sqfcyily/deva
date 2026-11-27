import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// Exercise the production TypeScript modules in fresh Node processes, outside the checkout.
// No Electron alias, GUI, test server or copy of the storage format is involved.
test('plain Node can save and reopen desktop configuration and a conversation under DEVA_HOME', async t => {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'deva-store-'))
  const original = await lstat(root)
  t.after(async () => {
    const current = await lstat(root)
    assert.equal(await realpath(root), root)
    assert.equal(dirname(root), parent)
    assert.ok(current.isDirectory() && current.dev === original.dev && current.ino === original.ino)
    await rm(root, { recursive: true })
  })
  const cwd = join(root, 'bundle')
  const source = name => fileURLToPath(new URL(`../src/main/services/${name}.ts`, import.meta.url))
  await build({ configFile: false, logLevel: 'silent', build: {
    ssr: true, outDir: cwd, rollupOptions: {
      input: { config: source('config'), chats: source('chat-store') },
      output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name]-[hash].cjs' }
    }
  } })
  const env = { ...process.env, HOME: root, USERPROFILE: root, DEVA_HOME: join(root, 'data') }
  for (const k of ['NODE_PATH', 'NODE_OPTIONS', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[k]
  const run = (code, childEnv = env) => execFileSync(process.execPath, ['--no-addons', '-e', `
    const assert = require('node:assert/strict'), config = require('./config.cjs'), chats = require('./chats.cjs');
    assert.equal(process.versions.electron, undefined);
    ${code}
  `], { cwd, env: childEnv, timeout: 10000 })

  run(`config.setUserHomeResolver(() => { throw Error('DEVA_HOME must take precedence') });
    assert.equal(config.getDevaHome(), process.env.DEVA_HOME);
    config.setConfig({locale:'en'});
    const s = chats.ensureSession('sess_node_smoke');
    s.title = 'Storage check'; s.messages.push({role:'user', content:'Persist me'});
    chats.save(s.id);`)
  run(`assert.equal(config.getConfig().locale, 'en');
    assert.deepEqual(chats.listSessions().map(s => [s.id, s.title]), [['sess_node_smoke', 'Storage check']]);
    assert.deepEqual(chats.getSession('sess_node_smoke').messages, [{role:'user', content:'Persist me'}]);`)
  run(`assert.equal(config.getDevaHome(), require('node:path').join(require('node:os').homedir(), '.deva'));
    assert.deepEqual(config.getConfig(), {}); assert.deepEqual(chats.listSessions(), []);`, { ...env, DEVA_HOME: '' })
  run(`const path = require('node:path');
    config.setUserHomeResolver(() => path.join(process.env.HOME, 'desktop-home'));
    assert.equal(config.getDevaHome(), path.join(process.env.HOME, 'desktop-home', '.deva'));`, { ...env, DEVA_HOME: '' })
})
