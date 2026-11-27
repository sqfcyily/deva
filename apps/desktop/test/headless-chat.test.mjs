import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// pnpm --filter @deva/desktop build:headless && node --test apps/desktop/test/headless-chat.test.mjs
const bundle = process.env.DEVA_TEST_SERVER ?? fileURLToPath(new URL('../out/headless/server.mjs', import.meta.url))
const host = '127.0.0.1', model = 'fixture-chat', deadline = () => AbortSignal.timeout(8000)
const user = text => ({ role: 'user', text }), assistant = text => ({ role: 'assistant', text })
const close = server => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
async function listen(server) {
  await once(server.listen(0, host), 'listening', { signal: deadline() })
  return server.address().port
}
async function* ndjson(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson\b/)
  let tail = ''
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (tail + chunk).split('\n')
    tail = lines.pop()
    for (const line of lines) yield JSON.parse(line)
  }
  assert.equal(tail, '', 'last NDJSON frame ends with a newline')
}
async function finish(frames, text, reason) {
  const events = []
  for await (const event of frames) events.push(event)
  assert.deepEqual(events.pop(), { type: 'done', reason })
  for (const event of events) assert.deepEqual(event, { type: 'delta', text: event.text })
  assert.equal(events.map(event => event.text).join(''), text)
}

test('compiled headless chat authenticates, streams, stops and resumes stored history', { timeout: 45000 }, async t => {
  assert.ok(isAbsolute(bundle))
  const home = await mkdtemp(join(await realpath(tmpdir()), 'deva-headless-chat-')), inode = await lstat(home)
  const token = randomBytes(32).toString('base64url'), key = randomBytes(24).toString('base64url')
  const calls = [], first = [user('first question'), assistant('complete answer')]
  const stopped = [...first, user('second question'), assistant('visible partial')], third = [...stopped, user('follow-up')]
  let held, child, cookie, port, origin
  const fixture = createServer(async (req, res) => {
    const call = { method: req.method, path: req.url, auth: req.headers.authorization }
    const n = calls.push(call)
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    try {
      let input = ''
      for await (const chunk of req) input += chunk
      call.body = JSON.parse(input)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const sse = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`)
      sse({ role: 'assistant', content: ['complete ', stopped[3].text, 'resumed answer'][n - 1] })
      if (n === 2) { held = res; return } // Leave the actual provider response open until the server aborts it.
      if (n === 1) sse({ content: 'answer' })
      sse({}, 'stop'); res.end('data: [DONE]\n\n')
    } catch (error) { res.destroy(error) }
  })
  async function halt() {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'), force = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.kill('SIGTERM')
    try { await exited } finally { clearTimeout(force) }
  }
  t.after(async () => {
    try { await halt() } finally {
      fixture.closeAllConnections()
      if (fixture.listening) await close(fixture)
      const current = await lstat(home)
      assert.equal(await realpath(home), home)
      assert.ok(current.isDirectory() && current.dev === inode.dev && current.ino === inode.ino)
      await rm(home, { recursive: true })
    }
  })
  assert.equal(inode.mode & 0o777, 0o700)
  const upstream = `http://${host}:${await listen(fixture)}/v1`
  const request = (path, { body, headers, postOrigin = origin } = {}) => fetch(origin + path, {
    redirect: 'manual', signal: deadline(), method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(body !== undefined && postOrigin ? { Origin: postOrigin } : {}), ...headers }
  })
  async function json(path, status = 200, options) {
    const res = await request(path, options), text = await res.text()
    assert.equal(res.status, status, `${res.url} status`)
    assert.ok([token, key, upstream, home, cookie?.split('=')[1]].filter(Boolean).every(value => !text.includes(value)), `${path} exposed a private value`)
    return [JSON.parse(text), res.headers]
  }
  const error = async (path, status, code, options) => assert.deepEqual((await json(path, status, options))[0], { error: code })
  async function boot(retries = 2) {
    if (!port) {
      const reservation = createServer()
      port = await listen(reservation); await close(reservation)
    }
    origin = `http://${host}:${port}`
    const env = { HOME: home, USERPROFILE: home, DEVA_HOME: home, DEVA_HOST: host, DEVA_PORT: String(port),
      DEVA_ORIGIN: origin, DEVA_WEB_TOKEN: token, DEVA_MODEL_BASE_URL: upstream, DEVA_MODEL: model, DEVA_MODEL_API_KEY: key }
    child = spawn(process.execPath, [basename(bundle)], { cwd: dirname(bundle), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', spawnError
    child.on('error', e => { spawnError = e })
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { log += chunk })
    const signal = deadline()
    while (!log.includes(`Deva Web listening on ${origin}\n`)) {
      if (child.exitCode === 1 && retries && log.includes('could not listen on the configured address')) { port = 0; return boot(retries - 1) }
      if (spawnError || child.exitCode !== null || child.signalCode !== null || signal.aborted) throw new Error(`headless CLI startup failed: ${spawnError ?? log}`)
      await delay(25)
    }
    assert.deepEqual((await json('/healthz'))[0], { ok: true })
  }
  const login = async () => {
    const [data, headers] = await json('/api/login', 200, { body: { token } }), value = headers.get('set-cookie')
    assert.deepEqual(data, { ok: true })
    assert.match(value, /;\s*HttpOnly(?:;|$)/i); assert.match(value, /;\s*SameSite=Strict(?:;|$)/i)
    cookie = value.split(';')[0]
    assert.match(cookie, /^[^=;]+=[^=;]+$/)
  }
  const sessions = '/api/sessions'
  await boot()
  const web = await request('/')
  assert.equal(web.status, 200); assert.match(web.headers.get('content-type'), /^text\/html\b/)
  assert.match(await web.text(), /<script[^>]+src="\/assets\/[^"/]+\.js"/)
  await error(sessions, 401, 'auth'); await error(sessions, 401, 'auth', { body: {} })
  await error('/api/login', 401, 'auth', { body: { token: 'wrong' } })
  await login()
  await error(sessions, 401, 'auth', { headers: { Cookie: `${cookie.split('=')[0]}=wrong` } })
  for (const options of [{ postOrigin: `http://localhost:${port}` }, { postOrigin: null }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }])
    await error(sessions, 403, 'origin', { body: {}, ...options })
  await error(`${sessions}?check=1`, 404, 'missing'); await error(`${sessions}-other`, 404, 'missing')
  assert.deepEqual((await json(sessions))[0], { sessions: [], model })
  const [created] = await json(sessions, 201, { body: {} }), { id, title } = created
  assert.match(id, /^web_[0-9a-f-]{36}$/); assert.ok(typeof title === 'string' && title)
  assert.deepEqual(created, { id, title, messages: [], revision: 0, active: null })
  const session = `${sessions}/${id}`, turn = `${session}/turns`, stop = `${session}/stop`
  const state = async () => (await json(session))[0], input = (text, revision) => ({ text, revision, turnId: randomUUID() })
  const send = async body => ndjson(await request(turn, { body }))
  assert.deepEqual(await state(), created); assert.equal(calls.length, 0)
  await finish(await send(input(first[0].text, 0)), first[1].text, 'complete')
  const completed = await state()
  assert.deepEqual(completed, { id, title: completed.title, messages: first, revision: 2, active: null })
  const second = input(stopped[2].text, completed.revision), frames = await send(second)
  assert.deepEqual((await frames.next()).value, { type: 'delta', text: stopped[3].text })
  assert.equal((await state()).active, second.turnId)
  const socket = held.socket
  await error(stop, 409, 'stale', { body: { turnId: randomUUID() } })
  assert.equal(socket.destroyed, false)
  const [, [ack]] = await Promise.all([once(held, 'close', { signal: deadline() }), json(stop, 200, { body: { turnId: second.turnId } })])
  assert.deepEqual(ack, { ok: true }); assert.ok(socket.destroyed && !held.writableEnded, 'upstream closed before fixture finish')
  await finish(frames, '', 'stopped')
  const saved = await state()
  assert.deepEqual(saved, { id, title: saved.title, messages: stopped, revision: 4, active: null })
  await error(turn, 409, 'stale', { body: input('stale send', completed.revision) }); assert.equal(calls.length, 2)
  const oldCookie = cookie
  await halt(); await boot(); await error(sessions, 401, 'auth'); await login()
  assert.notEqual(cookie, oldCookie); assert.deepEqual(await state(), saved)
  assert.deepEqual((await json(sessions))[0], { sessions: [{ id, title: saved.title }], model })
  await finish(await send(input(third[4].text, saved.revision)), 'resumed answer', 'complete')
  const final = await state()
  assert.deepEqual(final, { id, title: final.title, messages: [...third, assistant('resumed answer')], revision: 6, active: null })
  await halt(); assert.equal(calls.length, 3)
  for (const [i, { method, path, auth, body }] of calls.entries()) {
    assert.deepEqual({ method, path, auth }, { method: 'POST', path: '/v1/chat/completions', auth: `Bearer ${key}` })
    assert.equal(body.model, model); assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true }); assert.equal(Object.hasOwn(body, 'tools'), false)
    assert.deepEqual(body.messages, [first.slice(0, 1), stopped.slice(0, 3), third][i].map(({ role, text }) => ({ role, content: text })))
  }
})
