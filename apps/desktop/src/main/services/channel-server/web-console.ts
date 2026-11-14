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
  /* 用户气泡按内容宽度收缩（短句不拉满整行），并且不许被逐字拆行 */
  .bubble.user { background: #0a84ff; color: #fff; margin-left: auto; width: fit-content;
    max-width: 86%; word-break: normal; overflow-wrap: break-word; }
  .bubble.assistant { background: #00000010; }
  @media (prefers-color-scheme: dark) { .bubble.assistant { background: #ffffff18; } }
  /* 消息行：头像 + 正文两列（照桌面 .cf-msg 的 32px 栅格） */
  .msg { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; margin: 10px 0; min-width: 0; }
  .msg .ava { width: 32px; height: 32px; border-radius: 50%; overflow: hidden; background: #00000012; position: relative; }
  @media (prefers-color-scheme: dark) { .msg .ava { background: #ffffff18; } }
  .msg .ava img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .msg .ava .dot { position: absolute; top: -2px; right: -2px; width: 9px; height: 9px; border-radius: 50%;
    background: #ff453a; box-shadow: 0 0 0 2px #f5f5f7; }
  @media (prefers-color-scheme: dark) { .msg .ava .dot { box-shadow: 0 0 0 2px #1c1c1e; } }
  .msg__body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  /* 处理条：名字 + 标题 + 箭头同一行、无框（照桌面 .msg__process-row） */
  .process-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; min-width: 0; min-height: 22px; }
  .process-row .pname { font-size: 13px; font-weight: 700; color: inherit; }
  .process-head { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; width: fit-content;
    padding: 2px 0; border: none; background: none; color: inherit; opacity: .6;
    font-size: 12.5px; text-align: left; cursor: pointer; }
  .process-time { font-variant-numeric: tabular-nums; }
  .process-caret { width: 11px; height: 11px; transition: transform .15s; }
  .process-fold.is-open .process-caret { transform: rotate(180deg); }
  .process-body { display: none; padding: 6px 0 0; }
  .process-fold.is-open .process-body { display: block; }
  /* 运行中的当前步骤行（照桌面 preview）：spinner + 工具名 */
  .stepline { display: flex; align-items: center; gap: 8px; font-size: 12.5px; opacity: .65; min-width: 0; }
  .stepline .spin { width: 12px; height: 12px; flex: none; border: 1.5px solid #8886; border-top-color: #0a84ff;
    border-radius: 50%; animation: wb-spin .8s linear infinite; }
  @keyframes wb-spin { to { transform: rotate(360deg); } }
  .stepline .arg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 待插入胶囊（照桌面 .cf-ins__pill）：输入框上方一行，右侧可撤回 */
  .ins-pill { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; padding: 5px 6px 5px 10px;
    border: 1px solid #0002; border-radius: 10px; font-size: 12px; background: #00000008; }
  @media (prefers-color-scheme: dark) { .ins-pill { border-color: #fff3; background: #ffffff10; } }
  .ins-pill .tag { color: #0a84ff; font-weight: 600; flex: none; }
  .ins-pill .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
  .ins-pill button { flex: none; border: 1px solid #0003; background: none; color: inherit;
    border-radius: 7px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
  @media (prefers-color-scheme: dark) { .ins-pill button { border-color: #fff4; } }
  /* 交付文件卡（照桌面 DeliveryCards：回合结束后排在最后） */
  .files { border: 1px solid #0002; border-radius: 12px; margin: 8px 0; overflow: hidden; }
  @media (prefers-color-scheme: dark) { .files { border-color: #fff3; } }
  .files .fh { padding: 8px 12px; font-size: 12px; font-weight: 600; opacity: .65; border-bottom: 1px solid #0001; }
  @media (prefers-color-scheme: dark) { .files .fh { border-color: #fff2; } }
  .files a { display: flex; gap: 8px; align-items: center; padding: 9px 12px; font-size: 13.5px;
    color: #0a84ff; text-decoration: none; border-bottom: 1px solid #0001; }
  @media (prefers-color-scheme: dark) { .files a { border-color: #fff2; } }
  .files a:last-child { border-bottom: none; }
  .files .ext { width: 34px; height: 26px; border-radius: 7px; background: #00000010; display: inline-flex;
    align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: inherit; opacity: .6; flex: none; }
  @media (prefers-color-scheme: dark) { .files .ext { background: #ffffff14; } }
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
  .composer input { min-width: 0; }
  .composer button { padding: 0 16px; height: 40px; border: none; border-radius: 10px; background: #0a84ff;
    color: #fff; font-size: 14px; cursor: pointer; flex: none; }
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
    <div class="ins-pill hidden" id="insPill"><span class="tag">待插入</span><span class="txt" id="insTxt"></span><button id="insWd" type="button">撤回</button></div>
    <input type="text" id="cInput" placeholder="交代一个目标…" autocomplete="off">
    <button id="cSend">发送</button>
  </div>
</div>
<script>
(function () {
  'use strict'
  var TOKEN_KEY = 'deva.web.token'
  var state = { token: localStorage.getItem(TOKEN_KEY) || '', view: 'pair', sessions: [], sid: null,
    sseAbort: null, lastEventId: 0, activeTurn: null, bubbleByTurn: {}, toolById: {}, cards: {}, unknown: 0, pollTimer: null,
    // 移动端打磨（外部网关移植）：personaId→头像 dataURI 缓存；待插入队列；本回合起点锚；
    // 已读标记（列表红点）；当前消息角色名
    avatarByPersona: {}, inserts: [], turnStartedAt: 0, turnElapsed: 0, readAt: {}, pname: '', procTimer: null,
    procEl: null, procSteps: 0, procThinking: false, curToolRunning: [] }
  // 诊断探针：wedge 排查用（SSE 帧到达时刻/计数、重连次数、最近的 fetch 异常）
  window.__wb = { lastFrameAt: 0, frameCount: 0, sseReconnects: 0, sseClosed: 0, lastFetchError: '', frameErrors: [] }

  function $(s) { return document.querySelector(s) }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function show(id) { $(id).classList.remove('hidden') }
  function hide(id) { $(id).classList.add('hidden') }
  function fmtTime(ms) { var d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() }
  // 秒 →「1 分 12 秒」（照桌面 chat.process.*：高位为 0 省略、秒恒显示）
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec))
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60
    return h ? h + ' 小时 ' + m + ' 分 ' + r + ' 秒' : m ? m + ' 分 ' + r + ' 秒' : r + ' 秒'
  }
  // 已读标记：本设备看过某会话「完成」的时间，localStorage 持久（手机锁屏回来也不丢）
  function markRead(sid, at) {
    if (!sid) return
    try {
      var all = JSON.parse(localStorage.getItem('deva.web.read') || '{}')
      all[sid] = Math.max(all[sid] || 0, at || Date.now())
      localStorage.setItem('deva.web.read', JSON.stringify(all))
    } catch (e) {}
  }
  function isUnread(s) {
    if (s.busy) return false
    var all = {}
    try { all = JSON.parse(localStorage.getItem('deva.web.read') || '{}') } catch (e) {}
    return (s.completedAt || 0) > (all[s.id] || 0)
  }
  // 角色徽标：用角色首字 + FNV 配色的圆形占位（配色取样与 shared/avatar-shape 同源思路）。
  // 真 Humation 头像只在渲染层能画；接它需要通道新增端点，见 PR 描述的后续建议。
  function avatarFor(personaId, name) {
    var seed = personaId || name || '?'
    var h = 0x811c9dc5
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193) }
    var hue = (h >>> 0) % 360
    var ch = (name || seed || '?').trim().slice(0, 1).toUpperCase() || '?'
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" fill="hsl(' + hue + ',58%,52%)"/>' +
      '<text x="16" y="21" text-anchor="middle" font-family="system-ui" font-size="14" font-weight="700" fill="#fff">' +
      ch.replace('&', '&amp;').replace('<', '&lt;') + '</text></svg>')
  }

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
        row.style.display = 'flex'; row.style.gap = '10px'
        var ava = el('span', 'ava')
        ava.style.cssText = 'width:36px;height:36px;border-radius:50%;overflow:hidden;position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff'
        var img = document.createElement('img')
        img.src = avatarFor(s.personaId, (s.personaName || s.title || '?').slice(0, 1))
        img.alt = ''; img.style.cssText = 'width:100%;height:100%;object-fit:cover'
        ava.appendChild(img)
        if (isUnread(s)) ava.appendChild(el('span', 'dot'))
        row.appendChild(ava)
        var body = el('div', null)
        body.style.cssText = 'flex:1;min-width:0'
        var s1 = el('div', 's1')
        var tt = el('span', null, s.title || '(无标题)')
        tt.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        s1.appendChild(tt)
        // 右上角色名（照桌面列表）
        var pn = el('span', null, s.personaName || '')
        pn.style.cssText = 'font-size:11px;opacity:.6;flex:none;white-space:nowrap'
        if (s.personaName) s1.appendChild(pn)
        if (s.busy) s1.appendChild(el('span', 'badge busy', '进行中'))
        if (s.pendingCard) s1.appendChild(el('span', 'badge', '待操作'))
        body.appendChild(s1)
        body.appendChild(el('div', 's2', (s.lastMessage ? s.lastMessage + ' · ' : '') + fmtTime(s.updatedAt)))
        row.appendChild(body)
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
    state.liveWrap = null; state.inserts = []; state.liveThinking = false
    stopPoll(); hide('#listView'); show('#chatView'); show('#composer'); show('#hdr')
    $('#btnBack').classList.remove('hidden'); $('#hTitle').textContent = title || '对话'; $('#hSub').textContent = ''
    $('#timeline').textContent = ''
    // 会话详情带 personaName（server.ts 已有），取来给消息行和列表用
    api('/api/sessions/' + id).then(function (r) {
      if (r.status === 200 && r.j.personaName) state.pname = r.j.personaName
    }).catch(function () {})
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
    if (m.role === 'user' && (m.text || m.attachments)) addBubble('user', m.text || '')
    if (m.role === 'assistant') {
      // 照桌面 ProcessFold：名字 + 「已处理 X · N 步」同一行、默认收起，最终回答在外
      var steps = (m.tools || []).length
      var wrap = assistantMsg(m.durationMs || 0, steps, false)
      var bodyEl = wrap.querySelector('.msgbd')
      if (m.text) bodyEl.appendChild(el('div', 'bubble assistant', m.text))
      if ((m.files || []).length) bodyEl.appendChild(filesCard(m.files))
      tl.appendChild(wrap)
    }
  }

  /**
   * 助手消息容器（照桌面 .cf-msg）：头像 + 角色/处理条同行 + 正文区。
   * live=true 时标题为「处理中 · N 步 · X 秒」并每秒走表；结束后由 done 帧的 durationMs 定格「已处理」。
   */
  function assistantMsg(durationMs, steps, live, personaName) {
    var pn = personaName || state.pname || 'Deva'
    var wrap = el('div', 'msg')
    var ava = el('span', 'ava')
    var img = document.createElement('img')
    img.src = avatarFor(state.pAvatarId, pn)
    img.alt = ''
    ava.appendChild(img)
    wrap.appendChild(ava)
    var bodyEl = el('div', 'msgbd')
    var fold = el('div', 'process-fold')
    var row = el('div', 'process-row')
    row.appendChild(el('span', 'pname', pn))
    var head = el('button', 'process-head')
    head.type = 'button'
    head.innerHTML = '<span class="plabel"></span><svg class="process-caret" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 4.5 3 3 3-3"/></svg>'
    row.appendChild(head)
    fold.appendChild(row)
    var foldBody = el('div', 'process-body')
    fold.appendChild(foldBody)
    bodyEl.appendChild(fold)
    wrap.appendChild(bodyEl)
    wrap.__fold = fold; wrap.__plabel = head.querySelector('.plabel'); wrap.__foldBody = foldBody
    paintProcess(wrap, { live: live, durationMs: durationMs, steps: steps })
    head.onclick = function () { fold.classList.toggle('is-open') }
    return wrap
  }

  /** 填处理条标题：live=处理中+计时；否则已处理/已执行/已思考（照桌面 blocks.tsx 2051-2065）。 */
  function paintProcess(wrap, o) {
    if (!wrap || !wrap.__plabel) return
    var n = o.steps || 0
    var count = n ? ' · ' + n + ' 步' : ''
    var label
    if (o.live) label = '处理中' + count + ' · ' + fmtDuration((Date.now() - (state.turnStartedAt || Date.now())) / 1000)
    else if (o.durationMs > 0) label = (n === 1 && o.thoughtOnly ? '已思考 ' : '已处理 ') + fmtDuration(o.durationMs / 1000) + (o.thoughtOnly ? '' : count)
    else label = n ? '已执行 ' + n + ' 步' : '已思考'
    wrap.__plabel.textContent = label
  }

  /** 运行中每秒只刷新处理条文字（不重绘时间线，不冲掉卡片输入）。 */
  function startProcTimer(wrap, stepsOf) {
    stopProcTimer()
    state.procEl = wrap
    state.procSteps = stepsOf
    state.procTimer = setInterval(function () {
      if (!state.activeTurn || !state.procEl || !state.procEl.isConnected) { stopProcTimer(); return }
      paintProcess(state.procEl, { live: true, steps: stepsOf() })
    }, 1000)
  }
  function stopProcTimer() { if (state.procTimer) { clearInterval(state.procTimer); state.procTimer = null } }

  function fileLink(f) {
    // 注意：不要先把文件名当 a 的文本，否则会与下面的 meta 各渲染一份（截图上文件名叫了两遍）
    var a = el('a')
    a.href = '/api/files?path=' + encodeURIComponent(f.path) + '&session=' + encodeURIComponent(state.sid)
    a.target = '_blank'; a.rel = 'noopener'
    var ext = ((f.name || '').split('.').pop() || '?').toUpperCase().slice(0, 4)
    a.appendChild(el('span', 'ext', ext))
    var meta = el('span', null, f.name || '文件')
    meta.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    a.appendChild(meta)
    if (f.size != null) a.appendChild(el('span', null, Math.round(f.size / 1024) + 'KB'))
    return a
  }

  /** 把一组交付文件合成一张卡（照桌面 DeliveryCards：回合结束后排在回复末尾）。 */
  function filesCard(files) {
    var box = el('div', 'files')
    box.appendChild(el('div', 'fh', '交付文件 · ' + files.length))
    files.forEach(function (f) { box.appendChild(fileLink(f)) })
    return box
  }

  function addBubble(role, text) {
    var b = el('div', 'bubble ' + role, text)
    var tl = $('#timeline'); tl.appendChild(b)
    tl.scrollTop = tl.scrollHeight
    return b
  }

  /**
   * live 回合容器：assistantMsg + 当前步骤行（照桌面 preview——正在运行的工具一并列出，最多 5 行）。
   * 工具行挂进 .process-body（折叠体里，点开看全部），当前步骤行挂在折叠条下方。
   */
  function liveMsg() {
    var wrap = assistantMsg(0, 0, true, state.pname)
    wrap.__steps = []
    var stepBox = el('div')
    wrap.__stepBox = stepBox
    wrap.__foldBody.parentElement.insertBefore(stepBox, wrap.__foldBody)
    state.liveWrap = wrap
    $('#timeline').appendChild(wrap)
    $('#timeline').scrollTop = $('#timeline').scrollHeight
    startProcTimer(wrap, function () { return wrap.__steps.length })
    return wrap
  }

  /** 把一条工具写进 live 回合：折叠体一行 + 若在运行则同时是「当前步骤」行。 */
  function liveTool(id, name, summary, running) {
    var wrap = state.liveWrap
    if (!wrap) return null
    var line = el('div', 'rowline', (running ? '⚙ ' : '✓ ') + name + (summary ? ' — ' + summary : '…'))
    wrap.__foldBody.appendChild(line)
    wrap.__steps.push({ id: id, name: name, summary: summary, running: running, line: line })
    paintCurrentSteps(wrap)
    $('#timeline').scrollTop = $('#timeline').scrollHeight
    return line
  }

  /** 当前步骤行（照桌面 currentSteps：运行中的并列出，最多 5 行；无运行中且末步后无正文则露末步）。 */
  function paintCurrentSteps(wrap) {
    if (!wrap || !wrap.__stepBox) return
    var running = wrap.__steps.filter(function (x) { return x.running })
    var box = wrap.__stepBox
    box.textContent = ''
    if (state.liveThinking) return // 思考中标题已写「思考中」，不重复节点
    if (running.length) {
      running.slice(-5).forEach(function (s) {
        var line = el('div', 'stepline')
        line.appendChild(el('span', 'spin'))
        line.appendChild(el('span', 'arg', s.name + (s.summary ? ' · ' + s.summary : '')))
        box.appendChild(line)
        s.liveLine = line
      })
    } else if (wrap.__steps.length) {
      var last = wrap.__steps[wrap.__steps.length - 1]
      var line = el('div', 'stepline')
      line.appendChild(el('span', 'spin'))
      line.appendChild(el('span', 'arg', last.name + (last.summary ? ' · ' + last.summary : '')))
      box.appendChild(line)
    }
  }

  function addToolRow(id, name, summary) {
    // live 回合期间：工具行进折叠体 + 当前步骤行；回填时退回旧的平铺行
    if (state.liveWrap) return liveTool(id, name, summary, true)
    var line = el('div', 'rowline', '⚙ ' + name + (summary ? ' — ' + summary : '…'))
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
    if (d.type === 'turn_start') {
      var u = d.user || {}
      if (!u.notify && !u.quiet && u.text) addBubble('user', u.text)
      if (d.turnId) state.activeTurn = d.turnId
      // 计时锚点：本地收到 turn_start 的时刻（协议帧暂不带 startedAt；误差可接受，见 PR 描述）
      state.turnStartedAt = Date.now()
      state.turnElapsed = 0
      var sess = state.sessions.find(function (x) { return x.id === state.sid })
      state.pname = (sess && sess.personaName) || state.pname || 'Deva'
      liveMsg()
      setStopMode(true)
    } else if (d.type === 'text_delta') {
      var wrap = state.liveWrap
      if (!wrap) { var bb = addBubble('assistant', ''); bb.textContent += d.text || ''; return }
      var bodyEl = wrap.querySelector('.msgbd')
      var b = bodyEl.querySelector('.bubble.assistant:last-child')
      if (!b) { b = el('div', 'bubble assistant', ''); bodyEl.appendChild(b) }
      b.textContent += d.text || ''
      // 最后一步之后已在输出正文 → 收起当前步骤行（照桌面 currentSteps 语义）
      wrap.__stepBox.textContent = ''
      $('#timeline').scrollTop = $('#timeline').scrollHeight
    } else if (d.type === 'thinking_delta') {
      state.liveThinking = true
      var wl = state.liveWrap
      if (wl && wl.__plabel) wl.__plabel.textContent = '思考中'
    } else if (d.type === 'tool_call') {
      state.liveThinking = false
      addToolRow(d.id, d.name || '工具', null)
    } else if (d.type === 'tool_result') {
      var wrap2 = state.liveWrap
      var steps = wrap2 ? wrap2.__steps : []
      var st = null
      for (var si = steps.length - 1; si >= 0; si--) if (steps[si].id === d.id) { st = steps[si]; break }
      if (st) { st.running = false; st.summary = d.summary || ''; if (st.line) st.line.textContent = (d.isError ? '✗ ' : '✓ ') + (d.name || '') + (d.summary ? ' — ' + d.summary : '') }
      if (wrap2) paintCurrentSteps(wrap2)
      // present_files 完成：拉 deliveries 清单合成一张卡（照桌面 DeliveryCards）
      if (d.name === 'present_files' && !d.isError && wrap2 && state.sid) {
        api('/api/sessions/' + state.sid + '/deliveries?toolUseId=' + encodeURIComponent(d.id))
          .then(function (r) {
            if (r.status !== 200 || !r.j.files || !r.j.files.length) return
            var bd = wrap2.querySelector('.msgbd')
            if (bd && wrap2.isConnected) bd.appendChild(filesCard(r.j.files))
          }).catch(function () {})
      }
    } else if (d.type === 'ask_user') {
      renderAsk(d.key, d.questions, false)
    } else if (d.type === 'plan_review') {
      renderPlan(d.key, d.plan, false)
    } else if (d.type === 'mount_request') {
      renderMount(d.key, d.tool, d.path, d.member)
    } else if (d.type === 'inserts') {
      // 待插入队列（桌面 inserts 事件同帧）：显示胶囊
      state.inserts = Array.isArray(d.pending) ? d.pending : []
      var pill = $('#insPill')
      if (pill) {
        pill.classList.toggle('hidden', state.inserts.length === 0)
        if (state.inserts.length) $('#insTxt').textContent = state.inserts[state.inserts.length - 1] + (state.inserts.length > 1 ? ' +' + (state.inserts.length - 1) : '')
      }
    } else if (d.type === 'replay_reset') {
      state.lastEventId = 0
      backfill()
    } else if (d.type === 'interaction_resolved') {
      markResolved(d.key, '✓ 已处理')
    } else if (d.type === 'done') {
      // 定格处理条：done 带净耗时（扣除等答题等），照桌面「已处理 X · N 步」
      var fw = state.liveWrap
      if (fw) paintProcess(fw, { live: false, durationMs: d.durationMs || 0, steps: fw.__steps.length })
      stopProcTimer()
      state.liveWrap = null
      state.bubbleByTurn = {}
      if (d.stopReason === 'aborted') addNote('已停止')
      else if (d.stopReason && d.stopReason !== 'end_turn') addNote('回合结束（' + d.stopReason + '）')
      state.activeTurn = null; setStopMode(false)
      var cur = state.sessions.find(function (x) { return x.id === state.sid })
      if (cur) { cur.busy = false; cur.completedAt = Date.now() }
      markRead(state.sid, Date.now())
      loadSessions()
    } else {
      state.unknown++
    }
  }

  /**
   * 单键三态（照桌面 canInsert = streaming && 输入框有字）：
   *   空闲 → 「发送」；流式中输入框有字 → 「发送」（实为插入当前轮）；流式中空 → 「停止」。
   * 要停止就先清空输入框——桌面刻意的设计，避免想补话时误触停止。
   */
  function setStopMode(busy) {
    var b = $('#cSend')
    var inp = $('#cInput')
    if (!b || !inp) return
    var stopMode = busy && !inp.value.trim()
    b.textContent = stopMode ? '停止' : '发送'
    b.classList.toggle('stop', stopMode)
    inp.placeholder = busy ? '补充或纠正，当前步骤结束后交给 ' + (state.pname || 'Deva') + '…' : '交代一个目标…'
  }
  $('#cInput').addEventListener('input', function () {
    if (state.activeTurn) setStopMode(true)
  })

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
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, idx); buf = buf.slice(idx + 2)
            var dataLine = null
            block.split('\n').forEach(function (ln) {
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

  /**
   * 同一枚键的分发（照桌面 canInsert = streaming && 输入框有字）：
   *   空闲 → 发新消息；运行中 + 有字 → 插入当前轮（服务端 busy→insert）；
   *   运行中 + 空   → 停止当前轮。要停止就先清空输入框。
   */
  function onSendClick() {
    if (state.activeTurn && !$('#cInput').value.trim()) { stopTurn(); return }
    send()
  }

  function send() {
    var inp = $('#cInput'); var text = inp.value.trim()
    if (!text || !state.sid) return
    var b = $('#cSend')
    b.disabled = true
    api('/api/sessions/' + state.sid + '/send', { method: 'POST', body: { text: text } }).then(function (r) {
      b.disabled = false
      if (r.status !== 200) { addNote(r.j.error || '发送失败'); return }
      if (r.j.inserted) addNote('已排队，当前步骤结束后交给 ' + (state.pname || 'Deva'))
      inp.value = ''
      setStopMode(!!state.activeTurn)
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
  $('#btnBack').onclick = function () { state.sid = null; stopSse(); stopProcTimer(); showList() }
  $('#cSend').onclick = send
  $('#cSend').onclick = onSendClick
  $('#cInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') onSendClick() })
  // 撤回本轮未送达的插入（桌面 chat.withdrawInserts 同语义：原文还回输入框）
  $('#insWd').onclick = function () {
    if (!state.sid) return
    api('/api/sessions/' + state.sid + '/withdraw-inserts', { method: 'POST' }).then(function (r) {
      if (r.status === 200 && r.j && r.j.text) {
        var inp = $('#cInput')
        inp.value = inp.value.trim() ? r.j.text + ' ' + inp.value : r.j.text
      }
      state.inserts = []
      $('#insPill').classList.add('hidden')
      setStopMode(!!state.activeTurn)
    }).catch(function () {})
  }

  boot()
})()
</script>
</body>
</html>`
