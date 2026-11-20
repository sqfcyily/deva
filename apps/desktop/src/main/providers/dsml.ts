import { randomUUID } from 'node:crypto'
import type { StopReason } from '../../shared/chat-protocol'
import { settleBrokenCalls, type StreamEvent } from './types'

/**
 * DeepSeek 工具调用标记（DSML）漏进正文的兜底（issue #75）。
 *
 * DeepSeek V3.2 / V4 系在模型内部用 DSML 写工具调用，本应由服务端解析成结构化的 tool_calls：
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="read_file">
 *   <｜DSML｜parameter name="path" string="true">a.txt</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 * 模型写走样时（｜DSML｜ 后多了空格、竖线成了半角或双竖线、包裹名写成 calls、缺收尾标签）服务端认不出，
 * 整段标记当正文发来、finish_reason 为 stop：工具没执行，这一步被当成最终回复，本轮就此停下；标记还留在
 * 历史里，诱使模型此后照着写。官方 API 与各家中转都见过，各协议都可能漏，故在适配器之上统一处理：
 * 正文里一出现 DSML 开头就扣下不发，流结束时整段解析，认得出就改发成工具调用（stop → tool_use，
 * 循环照常执行），认不出原样放回正文。
 *
 * 只认**正文末尾**的一整段：模型只会把工具调用写在回复最后。代码块里、行内代码里的不算，标记段之后还有
 * 别的文字也不算——免得模型在回复里讲解这种格式时被当成调用执行。
 */

/** 任一 DSML 标签的前缀，规整成 `<DSML:` / `</DSML:`（闭合标签的 / 见过写在竖线前，也容许写在后面）。 */
const MARK = /<(\/?)\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(\/?)\s*/g
/** 开头标记（流式中据此开始扣留）。 */
const OPEN = /<\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/g
/** 正文结尾是不是开头标记的前半截（分块切在标记中间）：是就先扣下，等下一块再定。 */
const PARTIAL = /^<[\s｜|]*(?:D(?:S(?:M(?:L[\s｜|]*)?)?)?)?$/
const PARTIAL_MAX = 16

/** 规整后的标签（粘性匹配，从游标处开始）。包裹名三种都见过：function_calls（V3.2）/ tool_calls（V4）/ calls（走样）。 */
const WRAP_OPEN = /\s*<DSML:(?:tool_|function_)?calls\s*>/y
const WRAP_CLOSE = /\s*<\/DSML:(?:tool_|function_)?calls\s*>/y
const INVOKE_OPEN = /\s*<DSML:invoke\s+name\s*=\s*"([^"\s]+)"\s*>/y
const INVOKE_CLOSE = /\s*<\/DSML:invoke\s*>/y
const PARAM_OPEN = /\s*<DSML:parameter\s+name\s*=\s*"([^"]+)"(?:\s+string\s*=\s*"(true|false)")?\s*>/y
const PARAM_CLOSE = '</DSML:parameter'

export interface DsmlCall {
  name: string
  args: Record<string, unknown>
  /** 写到了 </invoke>。没写到但参数都完整时仍可执行（模型漏写收尾标签），撞上输出上限时则按残缺处理。 */
  closed: boolean
  /** 参数残缺（某个参数没写完）或 string="false" 的值不是合法 JSON：不可执行。 */
  broken: boolean
}

/** 参数值：string="true" 原样取（去掉紧贴标签的一个换行）；string="false" 须是 JSON；没标的先试 JSON。 */
function paramValue(raw: string, kind: string | undefined): { value: unknown } | null {
  if (kind === 'true') return { value: raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '') }
  try {
    return { value: JSON.parse(raw.trim()) }
  } catch {
    return kind === 'false' ? null : { value: raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '') }
  }
}

/**
 * 解析一整段 DSML 工具调用（从开头标记到正文结尾）。不像完整的一段（夹着别的文字、标签认不出、一个调用都没有）
 * 返回 null，由调用方原样放回正文。
 */
export function parseDsmlCalls(block: string): DsmlCall[] | null {
  const s = block.replace(MARK, (_m, a: string, b: string) => `<${a || b}DSML:`)
  let pos = 0
  const at = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = pos
    const m = re.exec(s)
    if (m) pos = re.lastIndex
    return m
  }
  const restBlank = (): boolean => s.slice(pos).trim() === ''
  at(WRAP_OPEN) // 包裹标签可有可无
  const calls: DsmlCall[] = []
  let wrapClosed = false
  while (!wrapClosed) {
    if (at(WRAP_CLOSE) || restBlank()) break
    const inv = at(INVOKE_OPEN)
    if (!inv) return null
    const call: DsmlCall = { name: inv[1], args: {}, closed: false, broken: false }
    calls.push(call)
    for (;;) {
      if (at(INVOKE_CLOSE)) {
        call.closed = true
        break
      }
      // 漏写 </invoke> 直接收包裹：参数都完整，照常可执行。
      if (at(WRAP_CLOSE)) {
        wrapClosed = true
        break
      }
      if (restBlank()) break
      const p = at(PARAM_OPEN)
      if (!p) return null
      const close = s.indexOf(PARAM_CLOSE, pos)
      if (close < 0) {
        call.broken = true // 参数写到一半流就断了
        pos = s.length
        break
      }
      const parsed = paramValue(s.slice(pos, close), p[2])
      const gt = s.indexOf('>', close)
      pos = gt < 0 ? s.length : gt + 1
      if (!parsed) {
        call.broken = true
        continue
      }
      // 同名参数写了两遍（见过先写 action=evaluate、紧接一个空的 action）：空值不覆盖已有的值。
      const blank = typeof parsed.value === 'string' && parsed.value.trim() === ''
      if (!(blank && p[1] in call.args)) call.args[p[1]] = parsed.value
    }
    if (call.broken && pos >= s.length) break
  }
  return calls.length && restBlank() ? calls : null
}

/** 流式扣留：正文一出现 DSML 开头标记（且不在代码里），此后的正文全部扣下，等流结束再定。 */
class DsmlGuard {
  private text = ''
  /** 已放行到的位置。 */
  private sent = 0
  /** 扣下的标记段起点；-1 = 未扣。 */
  private held = -1
  /** 已判定不算数的开头标记（在代码里）之后：再找从这里起。 */
  private skipTo = 0

  /** 喂入一段正文增量，返回此刻可以放行的正文。 */
  feed(delta: string): string {
    this.text += delta
    if (this.held >= 0) return ''
    OPEN.lastIndex = Math.max(this.sent, this.skipTo)
    for (let m = OPEN.exec(this.text); m; m = OPEN.exec(this.text)) {
      if (this.inCode(m.index)) {
        this.skipTo = OPEN.lastIndex
        continue
      }
      this.held = m.index
      return this.release(m.index)
    }
    // 没有开头标记：结尾若可能是半截标记，先留着它。
    let end = this.text.length
    const lt = this.text.lastIndexOf('<')
    if (lt >= this.sent && lt >= this.skipTo && end - lt <= PARTIAL_MAX && PARTIAL.test(this.text.slice(lt)))
      end = lt
    return this.release(end)
  }

  /** 流结束：tail = 还没放行的普通正文，block = 扣下的标记段（没有则 null）。 */
  finish(): { tail: string; block: string | null } {
    if (this.held < 0) return { tail: this.release(this.text.length), block: null }
    return { tail: '', block: this.text.slice(this.held) }
  }

  private release(end: number): string {
    const out = this.text.slice(this.sent, end)
    this.sent = end
    return out
  }

  /** 位置 i 是否在代码里：紧跟在反引号后（行内代码），或之前的 ``` 是奇数个（代码块中）。 */
  private inCode(i: number): boolean {
    if (this.text[i - 1] === '`') return true
    return (this.text.slice(0, i).match(/```/g)?.length ?? 0) % 2 === 1
  }
}

/** 收尾：扣下的标记段解析成工具调用改发，认不出原样放回正文。 */
function* settle(guard: DsmlGuard, stopReason: StopReason): Generator<StreamEvent> {
  const { tail, block } = guard.finish()
  if (tail) yield { type: 'text_delta', text: tail }
  const calls = block === null ? null : parseDsmlCalls(block)
  if (!calls) {
    if (block) yield { type: 'text_delta', text: block }
    yield { type: 'done', stopReason }
    return
  }
  // 中止 / 出错：本步不会执行工具，标记段直接丢掉，不进历史。
  if (stopReason === 'aborted' || stopReason === 'error') {
    yield { type: 'done', stopReason }
    return
  }
  console.warn(`[providers] 正文里漏出 DSML 工具调用，已恢复为调用：${calls.map((c) => c.name).join(', ')}`)
  const broken: { id: string; name: string; raw: string }[] = []
  for (const c of calls) {
    const id = `call_${randomUUID()}`
    if (c.broken || (!c.closed && stopReason === 'max_tokens'))
      broken.push({ id, name: c.name, raw: JSON.stringify(c.args) })
    else yield { type: 'tool_call', id, name: c.name, args: c.args }
  }
  const next: StopReason = stopReason === 'end_turn' || stopReason === 'stop' ? 'tool_use' : stopReason
  yield* settleBrokenCalls(broken, next)
  yield { type: 'done', stopReason: next }
}

/** 包一层适配器的事件流：正文里漏出的 DSML 工具调用改发成工具调用事件，其余事件原样透传。 */
export async function* recoverDsmlCalls(source: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
  const guard = new DsmlGuard()
  for await (const ev of source) {
    if (ev.type === 'text_delta') {
      const text = guard.feed(ev.text)
      if (text) yield { type: 'text_delta', text }
    } else if (ev.type === 'done') {
      yield* settle(guard, ev.stopReason)
      return
    } else yield ev
  }
  // 适配器总以 done 收尾；万一没有，别吞掉扣下的正文。
  const { tail, block } = guard.finish()
  if (tail || block) yield { type: 'text_delta', text: tail + (block ?? '') }
}
