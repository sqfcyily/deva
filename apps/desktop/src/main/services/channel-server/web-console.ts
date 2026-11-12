/**
 * Web 控制台（单文件、零依赖、无构建步骤）：channel-server 同端口托管的浏览器接入入口
 * （issue #44「局域网浏览器直接继续对话」）。页面壳免鉴权，数据全部走 Bearer REST/SSE，
 * 配对/限速/Origin 校验与原生客户端同一套——同端口托管使页面 Origin 与双重校验天然匹配。
 * 与原生客户端同口径的两条投影约定：通知/交差轮不上屏用户气泡（turn_start.user.notify/quiet）；
 * 回填不含引擎标记消息（服务端已过滤）。未知事件忽略并计数（协议兼容规则）。
 * 注意：本文件是 TS 模板字面量，页面内脚本一律不用反引号与 ${}，改用字符串拼接。
 */
export const WEB_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Deva Web 控制台</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f2f2f7; } }
  #app { max-width: 720px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #0001; position: sticky; top: 0; background: inherit; z-index: 5; }
  @media (prefers-color-scheme: dark) { header { border-color: #fff2; } }
  header button { border: none; background: none; font-size: 18px; cursor: pointer; color: inherit; padding: 4px 8px; }
  header .t { flex: 1; min-width: 0; }
  header .t .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header .t .sub { font-size: 12px; opacity: .6; }
  main { flex: 1; overflow-y: auto; padding: 12px 14px 90px; }
  .card-panel { margin: 40px auto; max-width: 420px; padding: 22px; border: 1px solid #0002; border-radius: 14px; }
  @media (prefers-color-scheme: dark) { .card-panel { border-color: #fff3; } }
  .card-panel h1 { font-size: 18px; margin: 0 0 6px; }
  .hint { font-size: 13px; opacity: .7; line-height: 1.5; margin: 6px 0 14px; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; opacity: .8; }
  input[type=text], input[type=tel], textarea { width: 100%; padding: 10px 12px; font-size: 15px;
    border: 1px solid #0003; border-radius: 10px; background: transparent; color: inherit; }
  @media (prefers-color-scheme: dark) { input, textarea { border-color: #fff4; } }
  button.primary { width: 100%; margin-top: 16px; padding: 12px; font-size: 15px; border: none;
    border-radius: 10px; background: #0a84ff; color: #fff; cursor: pointer; }
  button.primary:disabled { opacity: .5; }
  .warn { font-size: 12px; opacity: .6; line-height: 1.5; margin-top: 16px; border-top: 1px dashed #0003; padding-top: 10px; }
  @media (prefers-color-scheme: dark) { .warn { border-color: #fff4; } }
  .error { color: #ff453a; font-size: 13px; margin-top: 10px; min-height: 18px; white-space: pre-wrap; }
  .sess { display: flex; flex-direction: column; gap: 8px; }
  .sess .row { border: 1px solid #0002; border-radius: 12px; padding: 12px 14px; cursor: pointer; }
  @media (prefers-color-scheme: dark) { .sess .row { border-color: #fff3; } }
  .sess .row .s1 { display: flex; gap: 8px; align-items: center; font-weight: 600; }
  .sess .row .s2 { font-size: 13px; opacity: .65; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #ff9f0a33; color: #ff9f0a; flex: none; }
  .badge.busy { background: #0a84ff33; color: #0a84ff; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
  .toolbar button { flex: 1; padding: 9px; border-radius: 10px; border: 1px solid #0003; background: none; color: inherit; cursor: pointer; font-size: 14px; }
  @media (prefers-color-scheme: dark) { .toolbar button { border-color: #fff4; } }
  .bubble { max-width: 86%; padding: 9px 12px; border-radius: 14px; margin: 6px 0; white-space: pre-wrap;
    word-break: break-word; line-height: 1.45; font-size: 15px; }
  .bubble.user { background: #0a84ff; color: #fff; margin-left: auto; }
  .bubble.assistant { background: #00000010; }
  @media (prefers-color-scheme: dark) { .bubble.assistant { background: #ffffff18; } }
  .rowline { font-size: 12px; opacity: .6; margin: 4px 0; }
  .note { text-align: center; font-size: 12px; opacity: .55; margin: 6px 0; }
  .cardbox { border: 1px solid #0a84ff66; border-radius: 12px; padding: 12px 14px; margin: 8px 0; }
  .cardbox.resolved { opacity: .55; border-color: #8888; }
  .cardbox .q { font-size: 14px; font-weight: 600; margin: 8px 0 4px; }
  .cardbox label.opt { display: flex; gap: 6px; align-items: center; font-size: 14px; margin: 6px 0; opacity: 1; }
  .cardbox .desc { font-size: 12px; opacity: .6; }
  .cardbox .acts { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .cardbox .acts button { padding: 8px 14px; border-radius: 9px; border: 1px solid #0003; background: none; color: inherit; cursor: pointer; font-size: 14px; }
  @media (prefers-color-scheme: dark) { .cardbox .acts button { border-color: #fff4; } }
  .cardbox .acts button.ok { background: #0a84ff; color: #fff; border-color: #0a84ff; }
  .cardbox .state { font-size: 12px; opacity: .6; margin-top: 8px; }
  .filelink { display: inline-block; margin: 2px 6px 2px 0; font-size: 13px; color: #0a84ff; text-decoration: none; }
  .composer { position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 720px;
    display: flex; gap: 8px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); background: inherit; border-top: 1px solid #0001; }
  @media (prefers-color-scheme: dark) { .composer { border-color: #fff2; } }
  .composer input { flex: 1; }
  .composer button { width: 64px; border: none; border-radius: 10px; background: #0a84ff; color: #fff; font-size: 14px; cursor: pointer; }
  .composer button.stop { background: #ff453a; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div id="app">
  <header class="hidden" id="hdr">
    <button id="btnBack" class="hidden">&#8592;</button>
    <div class="t"><div class="title" id="hTitle">Deva</div><div class="sub" id="hSub"></div></div>
  </header>
  <main id="main">
    <div class="card-panel" id="pairView">
      <h1>Deva Web 控制台</h1>
      <div class="hint">在电脑端 Deva「机器人 → 通用设备 → 生成配对码」，把 6 位码填到下面（5 分钟有效）。配对后本浏览器将记住凭据。</div>
      <label>设备名（电脑端显示）</label>
      <input type="text" id="pName" autocomplete="off">
      <label>6 位配对码</label>
      <input type="tel" id="pCode" maxlength="6" inputmode="numeric" autocomplete="off">
      <button class="primary" id="pBtn">配对</button>
      <div class="error" id="pErr"></div>
      <div class="warn">&#9888; 当前客户端与 Deva 桌面端之间使用局域网 HTTP 明文传输，同网段内可被嗅探；不要在不受信任的网络中使用。</div>
    </div>
    <div class="hidden" id="listView">
      <div class="toolbar">
        <button id="btnNew">+ 新对话</button>
        <button id="btnRefresh">刷新</button>
        <button id="btnLogout">退出配对</button>
      </div>
      <div class="sess" id="sessList"></div>
    </div>
    <div class="hidden" id="chatView">
      <div id="timeline"></div>
    </div>
  </main>
  <div class="composer hidden" id="composer">
    <input type="text" id="cInput" placeholder="发消息…" autocomplete="off">
    <button id="cStop" class="stop hidden">停止</button>
    <button id="cSend">发送</button>
  </div>
</div>
<script>
(function () {
  'use strict'
  var TOKEN_KEY = 'deva.web.token'
  var state = { token: localStorage.getItem(TOKEN_KEY) || '', view: 'pair', sessions: [], sid: null,
    sseAbort: null, lastEventId: 0, activeTurn: null, bubbleByTurn: {}, toolById: {}, cards: {}, unknown: 0, pollTimer: null }
  // 诊断探针：wedge 排查用（SSE 帧到达时刻/计数、重连次数、最近的 fetch 异常）
  window.__wb = { lastFrameAt: 0, frameCount: 0, sseReconnects: 0, sseClosed: 0, lastFetchError: '', frameErrors: [] }

  function $(s) { return document.querySelector(s) }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function show(id) { $(id).classList.remove('hidden') }
  function hide(id) { $(id).classList.add('hidden') }
  function fmtTime(ms) { var d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() }

  function api(path, opts) {
    opts = opts || {}
    opts.headers = Object.assign({ Authorization: 'Bearer ' + state.token }, opts.headers || {})
    if (opts.body && typeof opts.body !== 'string') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.body) }
    // 请求超时（8s）：部分浏览器内核在 SSE 长响应场景下会耗尽同源连接池，请求可能永远排队——
    // 超时后 abort 并提示刷新，绝不挂死按钮。GET 自动重试一次（幂等）；POST 不重试（防双发），超时即报。
    return timedFetch(path, opts, 8000).then(function (r) {
      if (r.status === 401) { logout('凭据已失效，请重新配对。'); throw new Error('unauthorized') }
      return r.json().then(function (j) { return { status: r.status, j: j } })
    })
  }

  function timedFetch(path, opts, budget, retried) {
    var ctl = new AbortController()
    var timer = setTimeout(function () { ctl.abort() }, budget)
    var p = fetch(path, Object.assign({}, opts, { signal: ctl.signal })).then(function (r) { clearTimeout(timer); return r }).catch(function (e) { window.__wb.lastFetchError = path + ': ' + (e.name || e); throw e })
    var mayRetry = !!opts.retryOnce || !opts.method || opts.method === 'GET'
    if (retried || !mayRetry) return p
    return p.catch(function (e) {
      clearTimeout(timer)
      if (e.name === 'AbortError') return timedFetch(path, opts, budget, true)
      throw e
    })
  }

  function logout(msg) {
    localStorage.removeItem(TOKEN_KEY); state.token = ''
    if (state.sseAbort) state.sseAbort.abort()
    if (state.pollTimer) clearInterval(state.pollTimer)
    stopPoll(); showPair(); $('#pErr').textContent = msg || ''
  }

  function showPair() { state.view = 'pair'; hide('#listView'); hide('#chatView'); hide('#composer'); hide('#hdr'); show('#pairView'); $('#pName').value = 'Web-' + Math.random().toString(36).slice(2, 6) }

  function showList() { state.view = 'list'; hide('#pairView'); hide('#chatView'); hide('#composer'); show('#hdr'); show('#listView')
    $('#btnBack').classList.add('hidden'); $('#hTitle').textContent = 'Deva'; $('#hSub').textContent = '会话列表'
    stopSse(); startPoll(); loadSessions() }

  function loadSessions() {
    return api('/api/sessions').then(function (r) {
      if (r.status !== 200) return
      state.sessions = r.j.sessions || []
      var box = $('#sessList'); box.textContent = ''
      if (!state.sessions.length) box.appendChild(el('div', 'note', '没有会话，点上方「+ 新对话」开始。'))
      state.sessions.forEach(function (s) {
        var row = el('div', 'row')
        var s1 = el('div', 's1'); s1.appendChild(el('span', null, s.title || '(无标题)'))
        if (s.busy) s1.appendChild(el('span', 'badge busy', '进行中'))
        if (s.pendingCard) s1.appendChild(el('span', 'badge', '待操作'))
        row.appendChild(s1)
        row.appendChild(el('div', 's2', (s.lastMessage ? s.lastMessage + ' · ' : '') + fmtTime(s.updatedAt)))
        row.onclick = function () { openSession(s.id, s.title) }
        box.appendChild(row)
      })
    })
  }

  function startPoll() { stopPoll(); state.pollTimer = setInterval(function () { if (state.view === 'list') loadSessions() }, 8000) }
  function stopPoll() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null } }

  function openSession(id, title) {
    state.sid = id; state.view = 'chat'; state.lastEventId = 0; state.activeTurn = null
    state.bubbleByTurn = {}; state.toolById = {}; state.cards = {}; state.unknown = 0
    stopPoll(); hide('#listView'); show('#chatView'); show('#composer'); show('#hdr')
    $('#btnBack').classList.remove('hidden'); $('#hTitle').textContent = title || '对话'; $('#hSub').textContent = ''
    $('#timeline').textContent = ''
    backfill(); sseLoop()
  }

  function backfill() {
    var sid = state.sid
    return api('/api/sessions/' + sid + '/messages?limit=200').then(function (r) {
      if (r.status !== 200 || state.sid !== sid) return
      var tl = $('#timeline'); tl.textContent = ''
      ;(r.j.messages || []).forEach(function (m) { renderBackfillItem(m) })
      tl.scrollTop = tl.scrollHeight
    })
  }

  function renderBackfillItem(m) {
    var tl = $('#timeline')
    if (m.card) {
      if (m.card.kind === 'ask') renderAsk(m.card.key, m.card.questions, true)
      else if (m.card.kind === 'plan') renderPlan(m.card.key, m.card.plan, true)
      return
    }
    if (m.role === 'user' && m.text) addBubble('user', m.text)
    if (m.role === 'assistant') {
      if (m.text) addBubble('assistant', m.text)
      ;(m.tools || []).forEach(function (t) { addToolRow('t' + Math.random(), t, null) })
      if (m.attachments) tl.appendChild(el('div', 'rowline', '[' + m.attachments + ' 个附件]'))
      ;(m.files || []).forEach(function (f) { tl.appendChild(fileLink(f)) })
    }
  }

  function fileLink(f) {
    var a = el('a', 'filelink', (f.image ? '\\uD83D\\uDDBC ' : '\\uD83D\\uCCE4 ') + f.name + (f.size != null ? ' (' + Math.round(f.size / 1024) + 'KB)' : ''))
    a.href = '/api/files?path=' + encodeURIComponent(f.path) + '&session=' + encodeURIComponent(state.sid)
    a.target = '_blank'; a.rel = 'noopener'
    return a
  }

  function addBubble(role, text) {
    var b = el('div', 'bubble ' + role, text)
    var tl = $('#timeline'); tl.appendChild(b)
    tl.scrollTop = tl.scrollHeight
    return b
  }

  function addToolRow(id, name, summary) {
    var line = el('div', 'rowline', (summary ? (summary.indexOf('\\u2717') === 0 ? '' : '\\u2713 ') : '\\u2699 ') + name + (summary ? ' — ' + summary : '…'))
    line.id = id
    var tl = $('#timeline'); tl.appendChild(line); tl.scrollTop = tl.scrollHeight
    state.toolById[id] = line
    return line
  }

  function addNote(text) { var tl = $('#timeline'); tl.appendChild(el('div', 'note', text)); tl.scrollTop = tl.scrollHeight }

  function markResolved(key, label) {
    var box = state.cards[key]
    if (!box) return
    box.classList.add('resolved')
    var st = box.querySelector('.state'); if (st) st.textContent = label || '\\u2713 已处理'
    var acts = box.querySelector('.acts'); if (acts) acts.remove()
    ;[].forEach.call(box.querySelectorAll('input,textarea,button'), function (e) { e.disabled = true })
    delete state.cards[key]
  }

  function renderAsk(key, questions, fromBackfill) {
    var box = el('div', 'cardbox'); state.cards[key] = box
    box.appendChild(el('div', 'q', '\\u2753 Deva 有问题想问你'))
    var picks = []
    ;(questions || []).forEach(function (q, i) {
      box.appendChild(el('div', 'q', (i + 1) + '. ' + q.question + (q.required ? ' *' : '') + (q.multiSelect ? '（可多选）' : '')))
      var picked = { v: [] }
      picks.push({ q: q, picked: picked })
      ;(q.options || []).forEach(function (o) {
        var lab = el('label', 'opt')
        var inp = document.createElement('input')
        inp.type = q.multiSelect ? 'checkbox' : 'radio'; inp.name = key + '-' + i; inp.value = o.label
        inp.onchange = function () {
          if (q.multiSelect) { picked.v = [].filter.call(box.querySelectorAll('input[name="' + key + '-' + i + '"]:checked'), function (x) { return x.value }) }
          else picked.v = inp.checked ? [inp.value] : []
        }
        lab.appendChild(inp)
        var span = el('span', null, o.label)
        lab.appendChild(span)
        if (o.description) { var d = el('span', 'desc', ' ' + o.description); lab.appendChild(d) }
        box.appendChild(lab)
      })
      var free = el('input'); free.type = 'text'; free.placeholder = '或自己输入'
      free.oninput = function () { picked.v = free.value ? [free.value] : [] }
      box.appendChild(free)
    })
    var st = el('div', 'state', fromBackfill ? '\\u23F3 等待作答（历史未决卡）' : '\\u23F3 等待你在下方卡片中作答…')
    var acts = el('div', 'acts')
    var submit = el('button', 'ok', '提交')
    submit.onclick = function () {
      var answers = picks.map(function (p) { return p.picked.v[0] != null ? String(p.picked.v[0]) : '' })
      for (var i = 0; i < picks.length; i++) {
        if (picks[i].q.required && !answers[i]) { st.textContent = '第 ' + (i + 1) + ' 题必答'; return }
      }
      submit.disabled = true
      // 应答语义幂等安全：超时重试一次；409 = 服务端已处理过（首次请求实际送达），视为已决
      api('/api/sessions/' + state.sid + '/answer', { method: 'POST', body: { key: key, kind: 'ask', payload: { answers: answers } }, retryOnce: true })
        .then(function (r) {
          if (r.status === 409) { markResolved(key, '\\u2713 已作答'); return }
          if (r.status !== 200) { st.textContent = r.j.error || '提交失败'; submit.disabled = false } else markResolved(key, '\\u2713 已作答')
        })
        .catch(function () { st.textContent = '网络错误——若反复出现请刷新页面重试'; submit.disabled = false })
    }
    var cancel = el('button', null, '取消')
    cancel.onclick = function () {
      cancel.disabled = true
      api('/api/sessions/' + state.sid + '/answer', { method: 'POST', body: { key: key, kind: 'ask', payload: { answers: null } } })
        .then(function () { markResolved(key, '\\u2713 已取消') })
    }
    acts.appendChild(submit); acts.appendChild(cancel)
    box.appendChild(acts); box.appendChild(st)
    var tl = $('#timeline'); tl.appendChild(box); tl.scrollTop = tl.scrollHeight
  }

  function renderPlan(key, plan, fromBackfill) {
    var box = el('div', 'cardbox'); state.cards[key] = box
    box.appendChild(el('div', 'q', '\\uD83D\\uDCCB 计划待批准'))
    var pre = el('div', null, plan || ''); pre.style.whiteSpace = 'pre-wrap'; pre.style.fontSize = '14px'; box.appendChild(pre)
    var fb = el('input'); fb.type = 'text'; fb.placeholder = '反馈（可选）'; box.appendChild(fb)
    var st = el('div', 'state', fromBackfill ? '\\u23F3 等待审批（历史未决卡）' : '\\u23F3 等待审批…')
    var acts = el('div', 'acts')
    function decide(d) {
      ;[].forEach.call(acts.querySelectorAll('button'), function (e) { e.disabled = true })
      var payload = { decision: d }; if (fb.value) payload.feedback = fb.value
      api('/api/sessions/' + state.sid + '/answer', { method: 'POST', body: { key: key, kind: 'plan', payload: payload } })
        .then(function (r) { if (r.status !== 200) { st.textContent = r.j.error || '提交失败'; [].forEach.call(acts.querySelectorAll('button'), function (e) { e.disabled = false }) } else markResolved(key, '\\u2713 已' + (d === 'approve' ? '通过' : d === 'keep' ? '保持' : '忽略')) })
    }
    ;[['通过', 'approve', 'ok'], ['保持', 'keep', ''], ['忽略', 'ignore', '']].forEach(function (p) {
      var b = el('button', p[2], p[0]); b.onclick = function () { decide(p[1]) }; acts.appendChild(b)
    })
    box.appendChild(acts); box.appendChild(st)
    var tl = $('#timeline'); tl.appendChild(box); tl.scrollTop = tl.scrollHeight
  }

  function renderMount(key, tool, path, member) {
    var box = el('div', 'cardbox'); state.cards[key] = box
    box.appendChild(el('div', 'q', '\\uD83D\\uDD17 挂载请求' + (member ? '（' + member + '）' : '')))
    box.appendChild(el('div', 'hint', (tool || '挂载') + ' → ' + (path || '(路径需在电脑端确认)') + '。安全约束：设备端不能直接授权挂载，请在电脑端选择目录，或拒绝。'))
    var st = el('div', 'state', '\\u23F3 等待处理…')
    var acts = el('div', 'acts')
    var decline = el('button', null, '拒绝')
    decline.onclick = function () {
      decline.disabled = true
      api('/api/sessions/' + state.sid + '/answer', { method: 'POST', body: { key: key, kind: 'mount', payload: {} } })
        .then(function () { markResolved(key, '\\u2713 已拒绝') })
    }
    acts.appendChild(decline); box.appendChild(acts); box.appendChild(st)
    var tl = $('#timeline'); tl.appendChild(box); tl.scrollTop = tl.scrollHeight
  }

  function handleFrame(d) {
    window.__wb.lastFrameAt = Date.now()
    window.__wb.frameCount++
    var tl = $('#timeline')
    if (d.type === 'turn_start') {
      var u = d.user || {}
      if (!u.notify && !u.quiet && u.text) addBubble('user', u.text)
      if (d.turnId) state.activeTurn = d.turnId
      setStopMode(true)
    } else if (d.type === 'text_delta') {
      var b = state.bubbleByTurn[d.turnId]
      if (!b) { b = addBubble('assistant', ''); state.bubbleByTurn[d.turnId] = b }
      b.textContent += d.text || ''
      tl.scrollTop = tl.scrollHeight
    } else if (d.type === 'tool_call') {
      state.toolById[d.id] = addToolRow(d.id, d.name || '工具', null)
    } else if (d.type === 'tool_result') {
      var line = state.toolById[d.id]
      if (line) line.textContent = (d.isError ? '\\u2717 ' : '\\u2713 ') + (d.name || '') + (d.summary ? ' — ' + d.summary : '')
    } else if (d.type === 'ask_user') {
      renderAsk(d.key, d.questions, false)
    } else if (d.type === 'plan_review') {
      renderPlan(d.key, d.plan, false)
    } else if (d.type === 'mount_request') {
      renderMount(d.key, d.tool, d.path, d.member)
    } else if (d.type === 'replay_reset') {
      // 协议恢复语义：Last-Event-ID 早于缓冲最老一帧时服务端发本帧并关闭连接，要求客户端
      // 重新拉 /messages 整体回填、且不再带旧 id 续传（否则服务端会再次 reset+关闭，死循环）
      state.lastEventId = 0
      backfill()
    } else if (d.type === 'interaction_resolved') {
      markResolved(d.key, '\\u2713 已处理')
    } else if (d.type === 'done') {
      state.bubbleByTurn = {}
      if (d.stopReason === 'aborted') addNote('已停止')
      else if (d.stopReason && d.stopReason !== 'end_turn') addNote('回合结束（' + d.stopReason + '）')
      state.activeTurn = null; setStopMode(false); loadSessions()
    } else {
      state.unknown++
    }
  }

  function setStopMode(busy) {
    var b = $('#cStop')
    if (busy) b.classList.remove('hidden')
    else b.classList.add('hidden')
  }

  function stopTurn() {
    if (state.activeTurn) api('/api/turns/' + state.activeTurn + '/abort', { method: 'POST' }).catch(function () {})
  }

  function sseLoop() {
    var sid = state.sid
    if (!sid) return
    var ctl = new AbortController(); state.sseAbort = ctl
    var headers = { Authorization: 'Bearer ' + state.token }
    if (state.lastEventId) headers['Last-Event-ID'] = String(state.lastEventId)
    fetch('/api/sessions/' + sid + '/events', { headers: headers, signal: ctl.signal }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('SSE ' + r.status)
      var reader = r.body.getReader(); var dec = new TextDecoder(); var buf = ''
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) throw new Error('stream end')
          buf += dec.decode(chunk.value, { stream: true })
          var idx
          while ((idx = buf.indexOf('\\n\\n')) >= 0) {
            var block = buf.slice(0, idx); buf = buf.slice(idx + 2)
            var dataLine = null
            block.split('\\n').forEach(function (ln) {
              if (ln.indexOf('id:') === 0) state.lastEventId = parseInt(ln.slice(3).trim(), 10) || state.lastEventId
              else if (ln.indexOf('data:') === 0) dataLine = ln.slice(5).trim()
            })
            if (dataLine) { try { handleFrame(JSON.parse(dataLine)) } catch (e) { state.unknown++ } }
          }
          return pump()
        })
      }
      return pump()
    }).catch(function (e) {
      if (ctl.signal.aborted) return
      if (state.sid !== sid) return
      window.__wb.sseClosed++
      window.__wb.sseReconnects++
      window.__wb.lastFetchError = String(e && e.message || e)
      return new Promise(function (res) { setTimeout(res, 3000) }).then(function () {
        if (state.sid !== sid) return
        // 不在此处整体回填：Last-Event-ID 在 ring 内时服务端会原地带回错过的帧（避免与直播帧
        // 双重渲染）；只有服务端判「超出缓冲」时才发 replay_reset，由其处理函数负责整体回填。
        return sseLoop()
      })
    })
  }

  function stopSse() { if (state.sseAbort) { state.sseAbort.abort(); state.sseAbort = null } }

  function send() {
    // 发送永远发消息：回合忙时服务端 busy→insert 回退（与桌面/IM 同语义）；
    // 停止是独立按钮（卡片待答时回合挂着 activeTurn，若把发送兼做停止会误中止回合）
    var inp = $('#cInput'); var text = inp.value.trim()
    if (!text || !state.sid) return
    var b = $('#cSend')
    b.disabled = true
    api('/api/sessions/' + state.sid + '/send', { method: 'POST', body: { text: text } }).then(function (r) {
      b.disabled = false
      if (r.status !== 200) { addNote(r.j.error || '发送失败'); return }
      if (r.j.inserted) addNote('回合进行中，已插入队列')
      inp.value = ''
    }).catch(function () { b.disabled = false; addNote('发送超时或网络错误——若反复出现请刷新页面（连接池可能被浏览器耗尽）') })
  }

  function boot() {
    if (!state.token) { showPair(); return }
    api('/api/info').then(function (r) {
      if (r.status !== 200) return
      var caps = r.j.capabilities || []
      if (r.j.protocol !== 1 || caps.indexOf('session-stream') < 0 || caps.indexOf('answers') < 0) {
        $('#pErr').textContent = '通道协议版本不匹配（服务端 protocol=' + r.j.protocol + '），请升级。'
        return
      }
      showList()
    }).catch(function () {})
  }

  $('#pBtn').onclick = function () {
    var code = $('#pCode').value.trim(); var name = $('#pName').value.trim() || 'Web 控制台'
    if (!code) { $('#pErr').textContent = '请输入 6 位配对码'; return }
    $('#pBtn').disabled = true; $('#pErr').textContent = ''
    fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, deviceName: name }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j } }) })
      .then(function (r) {
        $('#pBtn').disabled = false
        if (r.status !== 200 || !r.j.token) { $('#pErr').textContent = r.j.error || '配对失败'; return }
        state.token = r.j.token; localStorage.setItem(TOKEN_KEY, state.token)
        boot()
      })
      .catch(function () { $('#pBtn').disabled = false; $('#pErr').textContent = '网络错误' })
  }
  $('#btnNew').onclick = function () {
    api('/api/sessions', { method: 'POST', body: {} }).then(function (r) {
      if (r.status === 200 && r.j.id) openSession(r.j.id, r.j.title || '新对话')
    })
  }
  $('#btnRefresh').onclick = loadSessions
  $('#btnLogout').onclick = function () { logout('已退出配对。') }
  $('#btnBack').onclick = function () { state.sid = null; stopSse(); showList() }
  $('#cSend').onclick = send
  $('#cStop').onclick = stopTurn
  $('#cInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') send() })

  boot()
})()
</script>
</body>
</html>`
