// Mock OpenAI 兼容端点 v3：通用设备通道协议门禁（scripts/general-device-gate.mjs）专用，兼作历史 E2E。
// 监听 127.0.0.1:43190（门禁前置第 2 项）。按最后一条用户消息分流：
//   · 「问一下」/ask → tool_call ask_user（两题：必答单选 + 选填自由输入），finish=tool_calls
//   · 「做个计划」/plan → tool_call exit_plan（计划正文），finish=tool_calls
//   · 最后一条是 tool 结果 → 文本回显「已收到：<内容前 60 字>」收尾（验证作答后回合继续）
//   · 「交付」/deliver → tool_call present_files（paths 指向 /tmp 样例，通道门禁不触发此分支）
//   · 「数到」/"count to N" → 慢速数字流（25 帧×120ms + 首帧 1.5s ≈ 4.5s 忙窗：门禁 ⑥ busy→insert
//     与 SSE 捕获窗依赖此分支——换用其他 mock 必须保留 ASCII 触发词，只有中文「数到」的话 ⑥ 会 race 败）
//   · 其余 → 快速文本回复
import http from 'node:http'

const PORT = 43190

const chunk = (extra) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: extra, finish_reason: null }] })}\n\n`
const textChunk = (t) => chunk({ content: t })
const toolChunk = (name, args, id) =>
  chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] })
const finishChunk = (reason) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`
const DONE = 'data: [DONE]\n\n'

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .filter((p) => p && p.type === 'text')
      .map((p) => p.text)
      .join(' ')
  return ''
}

const server = http.createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let msgs = []
    try {
      msgs = JSON.parse(body).messages ?? []
    } catch {}
    let lastUser = ''
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = textOf(msgs[i].content)
        break
      }
    }
    const lastMsg = msgs[msgs.length - 1]

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })

    const sendText = (text, delayMs) => {
      setTimeout(() => {
        if (res.writableEnded) return
        res.write(textChunk(text))
        res.write(finishChunk('stop'))
        res.write(DONE)
        res.end()
      }, delayMs)
    }

    // 工具结果回显：作答后回合继续的第二跳
    if (lastMsg && lastMsg.role === 'tool') {
      const echoed = textOf(lastMsg.content).slice(0, 60)
      sendText(`已收到：${echoed}`, 300)
      return
    }
    if (lastUser.includes('交付') || lastUser.includes('deliver')) {
      res.write(toolChunk('present_files', JSON.stringify({ paths: ['/tmp/deva-p5-e2e/sample.png'] }), 'call_file'))
      res.write(finishChunk('tool_calls'))
      res.end()
      return
    }
    if (lastUser.includes('问一下') || /\bask\b/i.test(lastUser)) {
      res.write(
        toolChunk(
          'ask_user',
          JSON.stringify({
            questions: [
              { question: '用哪个平台？', options: ['Kotlin', 'Java'], multiSelect: false },
              { question: '有什么补充？', options: [], required: false }
            ]
          }),
          'call_ask_' + Date.now().toString(36)
        )
      )
      res.write(finishChunk('tool_calls'))
      res.write(DONE)
      res.end()
      return
    }
    if (lastUser.includes('做个计划') || /\bplan\b/i.test(lastUser)) {
      res.write(
        toolChunk(
          'exit_plan',
          JSON.stringify({ plan: '# 手机端联调计划\n1. 配对并连通\n2. 发消息看流式\n3. 答卡片验证同步' }),
          'call_plan_' + Date.now().toString(36)
        )
      )
      res.write(finishChunk('tool_calls'))
      res.write(DONE)
      res.end()
      return
    }
    if (lastUser.includes('数到') || /\bcount\b/i.test(lastUser)) {
      let i = 1
      setTimeout(function tick() {
        if (res.writableEnded) return
        res.write(textChunk(`\n${i}`))
        if (i++ >= 25) {
          res.write(finishChunk('stop'))
          res.write(DONE)
          res.end()
          return
        }
        setTimeout(tick, 120)
      }, 1500)
      return
    }
    sendText('OK，这就回你。', 800)
  })
  req.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm v3 on ${PORT}`))
