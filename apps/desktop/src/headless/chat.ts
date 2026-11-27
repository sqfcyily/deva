import { randomUUID } from 'node:crypto'
import { streamOpenAI } from '../main/providers/openai'
import { deriveTitle, listPlainSessionIds, PlainSessionSyncError, readPlainSession, savePlainSession } from '../main/services/chat-store'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const SESSION_ID = new RegExp(`^web_${UUID}(?![\\s\\S])`)
const TURN_ID = new RegExp(`^${UUID}(?![\\s\\S])`)
const INPUT = 8 * 1024, OUTPUT = 64 * 1024, HISTORY = 256 * 1024
const SESSIONS = 64, TURNS = 128, CONCURRENT = 2, DEADLINE = 120_000, WIRE = 1024 * 1024
const errors = {
  invalid_request: [400, 'Invalid chat request'], invalid_id: [400, 'Invalid session ID'],
  missing: [404, 'Chat not found'], stale: [409, 'Chat revision or turn changed'],
  busy: [409, 'Chat capacity is busy'], limit: [413, 'Chat limit reached'],
  upstream: [502, 'Model response failed'], storage: [503, 'Chat storage is unavailable']
} as const

export class ChatError extends Error {
  readonly status: number
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1])
    this.status = errors[code][0]
  }
}

type Role = 'user' | 'assistant'
type TextMessage = { role: Role; content: [{ type: 'text'; text: string }] }
type Session = { id: string; title: string; createdAt: number; updatedAt: number; messages: TextMessage[]; webText: true }
export type View = { id: string; title: string; messages: { role: Role; text: string }[]; revision: number; active: string | null }
type Send = { text: string; revision: number; turnId: string }
type Outcome = 'complete' | 'stopped'
type Sink = (text: string) => Promise<void>

function message(role: Role, text: string): TextMessage {
  return { role, content: [{ type: 'text', text }] }
}

function disk<T>(action: () => T): T {
  try { return action() } catch { throw new ChatError('storage') }
}

function load(id: string): Session | undefined {
  // JSON may escape each UTF-8 byte to six ASCII bytes; reserve space for the native envelope.
  const s = disk(() => readPlainSession(id, 6 * HISTORY + 32 * 1024)) as Session | undefined
  if (!s || s.id !== id || s.webText !== true || Object.keys(s).length !== 6 ||
      typeof s.title !== 'string' || s.title.length > 31 || !Number.isSafeInteger(s.createdAt) ||
      !Number.isSafeInteger(s.updatedAt) || !Array.isArray(s.messages) || s.messages.length > 2 * TURNS) return
  let bytes = 0, users = 0, previous: Role | undefined
  for (const m of s.messages) {
    if (!m || Object.keys(m).length !== 2 || !Array.isArray(m.content) || m.content.length !== 1 ||
        (m.role !== 'user' && (m.role !== 'assistant' || previous !== 'user'))) return
    const p = m.content[0]
    if (!p || Object.keys(p).length !== 2 || p.type !== 'text' || typeof p.text !== 'string' || !p.text) return
    const size = Buffer.byteLength(p.text)
    if (size > (m.role === 'user' ? INPUT : OUTPUT) || (bytes += size) > HISTORY) return
    if (m.role === 'user' && (++users > TURNS || p.text !== p.text.trim())) return
    previous = m.role
  }
  return s
}

const transport = {
  textOnly: true,
  describeNetError: () => 'Model transport failed',
  async fetchModel(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, { ...init, redirect: 'error' })
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Invalid model response')
    }
    let bytes = 0, cr = false
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, sink) {
        if ((bytes += chunk.byteLength) > WIRE) throw new Error('Model response exceeded byte limit')
        if (!chunk.length) return
        // Keep CRLF in one read even if the upstream split the line ending across chunks.
        if (cr) {
          const joined = new Uint8Array(chunk.length + 1)
          joined[0] = 13
          joined.set(chunk, 1)
          chunk = joined
        }
        cr = chunk.at(-1) === 13
        sink.enqueue(cr ? chunk.subarray(0, -1) : chunk)
      }
    })))
  }
}

async function emit(onDelta: Sink, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let abort!: () => void
  try {
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    await Promise.race([Promise.resolve().then(() => onDelta(text)), interrupted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function createTextChat({ baseURL, model, apiKey }: { baseURL: string; model: string; apiKey: string }) {
  // Private single-writer home: load the bounded native file set once; publish only after a strict write.
  let slots: Map<string, Session | undefined> | undefined
  const active = new Map<string, { turnId: string; abort: () => void }>()
  let closed = false, uncertain = false

  function sessions() {
    if (uncertain) throw new ChatError('storage')
    if (slots) return slots
    const ids = disk(() => listPlainSessionIds(id => SESSION_ID.test(id), SESSIONS, 512))
    if (ids.length > SESSIONS) throw new ChatError('limit')
    return slots = new Map(ids.map(id => [id, load(id)] as const))
  }

  function get(id: string): Session {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new ChatError('invalid_id')
    const s = sessions().get(id)
    if (!s) throw new ChatError('missing')
    return s
  }

  function view(s: Session): View {
    return { id: s.id, title: s.title, messages: s.messages.map(m => ({ role: m.role, text: m.content[0].text })),
      revision: s.messages.length, active: active.get(s.id)?.turnId ?? null }
  }

  function commit(s: Session): void {
    const registry = sessions()
    try { savePlainSession(s) } catch (e) {
      if (e instanceof PlainSessionSyncError) uncertain = true
      throw new ChatError('storage')
    }
    registry.set(s.id, s)
  }

  return {
    list: () => [...sessions().values()].filter((s): s is Session => !!s)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title }) => ({ id, title })),
    create(): View {
      if (closed) throw new ChatError('storage')
      if (sessions().size >= SESSIONS) throw new ChatError('limit')
      let id: string
      do { id = `web_${randomUUID()}` } while (sessions().has(id))
      const now = Date.now()
      const s: Session = { id, title: 'New chat', createdAt: now, updatedAt: now, messages: [], webText: true }
      commit(s)
      return view(s)
    },
    read: (id: string): View => view(get(id)),
    begin(id: string, input: Send) {
      if (!input || typeof input.text !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
          typeof input.turnId !== 'string' || !TURN_ID.test(input.turnId)) throw new ChatError('invalid_request')
      const text = input.text.trim()
      if (!text) throw new ChatError('invalid_request')
      const bytes = Buffer.byteLength(text)
      if (bytes > INPUT) throw new ChatError('limit')
      if (closed) throw new ChatError('storage')
      const s = get(id)
      if (active.has(id)) throw new ChatError('busy')
      if (s.messages.length !== input.revision) throw new ChatError('stale')
      if (active.size >= CONCURRENT) throw new ChatError('busy')
      if (s.messages.filter(m => m.role === 'user').length >= TURNS ||
          s.messages.reduce((sum, m) => sum + Buffer.byteLength(m.content[0].text), bytes + OUTPUT) > HISTORY)
        throw new ChatError('limit')
      const next = { ...s, updatedAt: Date.now(), title: s.messages.length ? s.title : deriveTitle(text),
        messages: [...s.messages, message('user', text)] }
      const controller = new AbortController()
      let stopped = false, running: Promise<Outcome> | undefined
      const release = () => { clearTimeout(timer); if (active.get(id) === turn) active.delete(id) }
      const cancel = (owner: boolean) => {
        if (controller.signal.aborted) return
        stopped = owner
        controller.abort()
        if (!running) release()
      }
      const turn = { turnId: input.turnId, abort: () => cancel(true) }
      const timer = setTimeout(() => cancel(false), DEADLINE)
      timer.unref()
      active.set(id, turn)
      try { commit(next) } catch (e) { release(); throw e }

      async function run(onDelta: Sink): Promise<Outcome> {
        let output = '', size = 0
        try {
          controller.signal.throwIfAborted()
          for await (const event of streamOpenAI({ baseURL, apiKey }, {
            model, maxTokens: 4096, messages: next.messages, signal: controller.signal
          }, transport)) {
            controller.signal.throwIfAborted()
            if (event.type === 'text_delta') {
              if ((size += Buffer.byteLength(event.text)) > OUTPUT) throw new ChatError('limit')
              output += event.text
              await emit(onDelta, event.text, controller.signal)
            } else if (event.type === 'done' && event.stopReason === 'max_tokens') {
              throw new ChatError('limit')
            } else if (event.type === 'error' || event.type === 'tool_call' || event.type === 'tool_call_truncated' ||
                       (event.type === 'done' && event.stopReason !== 'end_turn' && event.stopReason !== 'refusal')) {
              throw new ChatError('upstream')
            }
          }
          controller.signal.throwIfAborted()
          if (!output) throw new ChatError('upstream')
          return 'complete'
        } catch (e) {
          if (stopped) return 'stopped'
          throw e instanceof ChatError && e.code === 'limit' ? e : new ChatError('upstream')
        } finally {
          controller.abort()
          try {
            if (output) commit({ ...next, updatedAt: Date.now(), messages: [...next.messages, message('assistant', output)] })
          } finally { release() }
        }
      }
      return { run: (onDelta: Sink) => running ??= run(onDelta), abort: turn.abort }
    },
    stop(id: string, turnId: string): void {
      get(id)
      if (typeof turnId !== 'string' || !TURN_ID.test(turnId)) throw new ChatError('invalid_request')
      const turn = active.get(id)
      if (turn && turn.turnId !== turnId) throw new ChatError('stale')
      turn?.abort()
    },
    close(): void {
      closed = true
      for (const turn of active.values()) turn.abort()
    }
  }
}
