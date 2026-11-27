// Runs inside the shipping container before and after `docker compose up --force-recreate`.
// Only the fixed, local fixture below is accepted; this check never contacts a real provider.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

const { DEVA_ORIGIN: origin, DEVA_WEB_TOKEN: token, DEVA_SMOKE_SESSION: existing } = process.env
assert.equal(process.env.DEVA_MODEL, 'deva-compose-fixture')
assert.equal(process.env.DEVA_MODEL_BASE_URL, 'http://127.0.0.1:18795/v1')
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) && !process.env.DEVA_MODEL_API_KEY)
const prompt = existing ? 'continue after restart' : 'hello from compose'
const first = [{ role: 'user', text: 'hello from compose' }, { role: 'assistant', text: 'fixture reply' }]
let cookie, calls = 0
const fixture = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST'); calls++
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, process.env.DEVA_MODEL); assert.ok(!body.tools)
    assert.deepEqual(body.messages, [...(existing ? first : []), { role: 'user', text: prompt }].map(m => ({ role: m.role, content: m.text })))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"fixture reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  } catch (err) { console.error(err.message); res.destroy() }
})
async function api(path, body) {
  const res = await fetch(`${origin}/api/${path}`, { method: body ? 'POST' : 'GET', headers: {
    ...(cookie && { Cookie: cookie }), ...(body && { Origin: origin, 'Content-Type': 'application/json' })
  }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  assert.ok(res.ok, `${path} returned ${res.status}`); return res
}
try {
  await once(fixture.listen(18795, '127.0.0.1'), 'listening')
  const login = await api('login', { token }); cookie = login.headers.get('set-cookie').split(';')[0]; await login.json()
  const sid = existing || (await (await api('sessions', {})).json()).id
  assert.match(sid, /^web_[a-f0-9-]{36}$/u)
  const path = `sessions/${sid}`, view = await (await api(path)).json()
  assert.deepEqual(view.messages, existing ? first : [])
  const stream = await api(`${path}/turns`, { text: prompt, revision: view.revision, turnId: randomUUID() })
  const events = (await stream.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events, [{ type: 'delta', text: 'fixture reply' }, { type: 'done', reason: 'complete' }])
  assert.equal(calls, 1)
  assert.deepEqual((await (await api(path)).json()).messages, [...view.messages, { role: 'user', text: prompt }, { role: 'assistant', text: 'fixture reply' }])
  console.log(sid)
} finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
