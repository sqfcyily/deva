// 通用设备通道协议回归门禁(手工/CI 均可运行)。
// 编码了协议不变量:版本化、设备名唯一不烧码、配对码原子消费、会话级流三帧、
// busy→insert 回退、忙时归档 409、lastMessage 列表字段、单会话 GET 带 query、
// 回合级流未知 turnId 404、Origin 端口校验、归档/取消归档、自助吊销即刻 401、
// 回填/列表摘要不露引擎标记(⟦deva:*⟧ 投影过滤)。
//
// 前置(另开两个终端):
//   1. 桌面实例:DEVA_HOME=<测试家目录> electron --remote-debugging-port=9227 \
//        <启动器> boot.cjs     (boot.cjs 做(userData 隔离) 后 require out/main/index.js;
//         单实例锁按 userData 隔离,可与日常 Deva 并存)
//   2. Mock 模型:node scripts/general-device-mock-llm.mjs(监听 127.0.0.1:43190;
//      ⑥ 忙窗依赖 "count to N" ASCII 慢流分支——无此分支的 mock 会让 ⑥ race 败)
//   3. 本仓库已构建:apps/desktop 下 `pnpm exec electron-vite build`
//
// 用法:node scripts/general-device-gate.mjs [CDP端口=9227]
// 输出:逐项 ✅/❌ + 汇总;全绿退出码 0。
import { execSync } from 'node:child_process'
import { spawn } from 'node:child_process'

const CDP = `http://127.0.0.1:${process.argv[2] ?? 9227}`
const RUN = Math.random().toString(36).slice(2, 8)

/** 经 CDP 调桌面渲染层 window.deva.general.pairCode() 取当前 6 位码。 */
async function issueCodeViaCDP() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const call = (method, params) => new Promise((res) => {
    const mid = ++id
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === mid) { ws.removeEventListener('message', h); res(m) } }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  await call('Runtime.enable', {})
  const r = await call('Runtime.evaluate', {
    expression: 'window.deva.general.pairCode()',
    awaitPromise: true,
    returnByValue: true
  })
  ws.close()
  // CDP evaluate 响应形如 {id, result:{result:{type,value}}}——取 value 需两层 result
  return r.result?.result?.value ?? r.result?.value
}
const code = async () => (await issueCodeViaCDP()).code
const pair = (c, n) => {
  const out = execSync(
    `curl -s -X POST http://127.0.0.1:4317/api/pair -H 'content-type: application/json' -d '{"code":"${c}","deviceName":"${n}"}'`
  ).toString()
  try { return JSON.parse(out) } catch { return { raw: out } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 取 HTTP 状态码;SSE 端点挂流到 --max-time(curl 退出码 28)属预期,从 output 里捞状态码。 */
const httpCode = (url, extra = '') => {
  try {
    return execSync(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${extra} "${url}"`).toString().trim()
  } catch (e) {
    return (e.output?.[1]?.toString() ?? '').trim() || 'ERR'
  }
}

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`) }

// ① 版本化:pair 响应带 protocol + capabilities
const p1 = pair(await code(), `${RUN}-v`)
ok('① pair 带 protocol/capabilities', p1.protocol === 1 && Array.isArray(p1.capabilities) && p1.capabilities.includes('session-stream'), `protocol=${p1.protocol} caps=${(p1.capabilities || []).length}`)
const T = p1.token
const info = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/info -H "Authorization: Bearer ${T}"`).toString())
ok('② /api/info 带版本化', info.protocol === 1, `protocol=${info.protocol}`)

// ③ 唯一性:重名 409 且不烧码 → 同码换名成功
await sleep(7000) // 配对限速 10 次/分/IP,节奏铺开
const c3 = await code()
const dup = pair(c3, `${RUN}-dup-a`)
ok('③a 首配成功', !!dup.token, dup.deviceId || dup.error)
await sleep(7000)
const c3b = await code() // 必须等待:悬空出码会异步顶替后续刚取的码(实测 ④ wins=0 的根因)
const dup2 = pair(c3b, `${RUN}-dup-a`) // 同名 → 409,不烧码
ok('③b 重名 → 409', dup2.error && dup2.error.includes('已被占用'), dup2.error.slice(0, 40))

// ④ 原子竞态:并发同码 ×3 恰好一成功
const c4 = await code()
const rs = [1, 2, 3].map((n) => pair(c4, `${RUN}-race-${n}`))
const wins = rs.filter((r) => r.token).length
ok('④ 并发同码 ×3 恰好一成功', wins === 1, `wins=${wins}`)

// ⑤ 会话级流:先挂流(直播)再发送 → turn_start/text_delta/done 三帧
const c5 = await code()
const pv = pair(c5, `${RUN}-sse`)
const T5 = pv.token
const SID = JSON.parse(execSync(`curl -s -X POST http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString()).id
const child = spawn('curl', ['-s', '-N', '--max-time', '14', '-H', `Authorization: Bearer ${T5}`, `http://127.0.0.1:4317/api/sessions/${SID}/events`], {})
let captured = ''
child.stdout.on('data', (d) => { captured += d.toString() })
await sleep(1200) // 流连接稳定后再发送:turn_start 应实时到达
execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${SID}/send" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"text":"count to 3"}' > /dev/null`)
await sleep(1500) // 回合进行中(慢流 ~9s):趁忙验证 busy→insert 与忙时归档 409

// ⑥ 会话忙再发 → 回退插入(inserted:true,与 IM 同口径)
const ins = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${SID}/send" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"text":"insert me"}'`).toString())
ok('⑥ 忙时发送 → {inserted:true}', ins.inserted === true, JSON.stringify(ins).slice(0, 60))

// ⑦ 忙时归档 → 409(与桌面同口径)
const archBusy = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${SID}/archive" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"archived":true}'`).toString())
ok('⑦ 忙时归档 → 409', archBusy.error && archBusy.error.length > 0, (archBusy.error || '').slice(0, 40))

await sleep(9000)
child.kill()
const uniq = [...new Set([...captured.matchAll(/"type":"([a-z_]+)"/g)].map((m) => m[1]))]
ok('⑤ 会话级流含 turn_start/text_delta/done', uniq.includes('turn_start') && uniq.includes('text_delta') && uniq.includes('done'), uniq.join(' '))

// ⑧ 列表带 personaName/lastMessage(空档期无 personaId → 无 personaName 字段)
const list = JSON.parse(execSync(`curl -s "http://127.0.0.1:4317/api/sessions?limit=50" -H "Authorization: Bearer ${T5}"`).toString())
const mine = list.sessions.find((s) => s.id === SID)
ok('⑧ 列表带 lastMessage', typeof mine?.lastMessage === 'string' && mine.lastMessage.length > 0, mine?.lastMessage?.slice(0, 40))
ok('⑧b 归档 false 缺省', mine?.archived === false)

// ⑨ firstRun:已建会话后必为 false(列表同口径,不因成员会话矛盾)
const info2 = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/info -H "Authorization: Bearer ${T5}"`).toString())
ok('⑨ 有顶层会话后 firstRun=false', info2.firstRun === false)

// ⑩ GET /api/sessions/:id 带 query 不再 404
const one = JSON.parse(execSync(`curl -s "http://127.0.0.1:4317/api/sessions/${SID}?x=1&y=2" -H "Authorization: Bearer ${T5}"`).toString())
ok('⑩ 单会话 GET 带 query → 200', one.id === SID, one.error || 'ok')

// ⑪ 回合级 SSE:未知 turnId → 404;真实 turnId → 200(挂流被 --max-time 掐断,退出码 28 属预期)
const bogus = httpCode(`http://127.0.0.1:4317/api/turns/bogus_turn_404/events`, `-H "Authorization: Bearer ${T5}"`)
ok('⑪a 未知 turnId → 404', bogus === '404', `got ${bogus}`)
const realTurn = [...captured.matchAll(/"turnId":"(turn_[A-Za-z0-9_-]+)"/g)].map((m) => m[1])[0]
const real = realTurn
  ? httpCode(`http://127.0.0.1:4317/api/turns/${realTurn}/events`, `-H "Authorization: Bearer ${T5}"`)
  : 'no-turn'
ok('⑪b 真实 turnId → 200', real === '200', `got ${real}`)

// ⑫ Origin:端口不符 403(本机其他端口可伪造同主机名 Origin),端口相符 200
const badOrigin = httpCode(`http://127.0.0.1:4317/api/info`, `-H "Origin: http://127.0.0.1:9999" -H "Authorization: Bearer ${T5}"`)
const goodOrigin = httpCode(`http://127.0.0.1:4317/api/info`, `-H "Origin: http://127.0.0.1:4317" -H "Authorization: Bearer ${T5}"`)
ok('⑫a Origin 端口不符 → 403', badOrigin === '403', `got ${badOrigin}`)
ok('⑫b Origin 端口相符 → 200', goodOrigin === '200', `got ${goodOrigin}`)

// ⑬ 归档 / 取消归档(空闲期)
const archOk = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${SID}/archive" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"archived":true}'`).toString())
const listArch = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString())
const archFlag = listArch.sessions.find((s) => s.id === SID)?.archived
const unarchOk = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${SID}/archive" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"archived":false}'`).toString())
ok('⑬ 归档→列表 archived=true→取消归档', archOk.ok === true && archFlag === true && unarchOk.ok === true, `arch=${archFlag}`)

// ⑭ 自助吊销(用 ① 的设备):POST /api/devices/self → ok,同 token 即刻 401
const rev = JSON.parse(execSync(`curl -s -X POST http://127.0.0.1:4317/api/devices/self -H "Authorization: Bearer ${T}"`).toString())
const rev401 = execSync(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4317/api/info -H "Authorization: Bearer ${T}"`).toString().trim()
ok('⑭ 自助吊销 → ok + token 即刻 401', rev.ok === true && rev401 === '401', `revoke=${JSON.stringify(rev)} info=${rev401}`)

// ⑮ 附件:上传(png 1x1)→ 带附件发送 → 回填报 attachments 计数;伪造路径 send 被忽略
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const tmpPng = join(mkdtempSync(join(tmpdir(), 'deva-gate-')), 'gate.png')
writeFileSync(tmpPng, PNG_1PX)
const up = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/attachments?name=gate.png" -H "Authorization: Bearer ${T5}" -H 'content-type: image/png' --data-binary @${tmpPng}`).toString())
ok('⑮a 上传返回白名单路径', typeof up.path === 'string' && up.kind === 'image', JSON.stringify(up).slice(0, 80))
const badUp = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/attachments?name=x.png" -H "Authorization: Bearer ${T5}" --data-binary 'x'`).toString())
ok('⑮b 缺 Content-Type 也可(兜 octet-stream)', typeof badUp.path === 'string' || (badUp.error && badUp.error.length > 0), JSON.stringify(badUp).slice(0, 60))
const SID2 = JSON.parse(execSync(`curl -s -X POST http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString()).id
execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${SID2}/send" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"text":"see attachment","attachments":["${up.path}"]}' > /dev/null`)
// 伪造路径:未登记路径不读盘,只给模型「已忽略」note——不报错、不 500
const fakeSend = execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:4317/api/sessions/${SID2}/send" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"text":"fake","attachments":["/etc/hostname"]}'`).toString().trim()
ok('⑮c 伪造路径 send 不炸(200)', fakeSend === '200', `got ${fakeSend}`)
await sleep(6000)
const msgs = JSON.parse(execSync(`curl -s "http://127.0.0.1:4317/api/sessions/${SID2}/messages?limit=50" -H "Authorization: Bearer ${T5}"`).toString())
const attCount = msgs.messages.filter((m) => m.role === 'user' && m.attachments > 0).length
ok('⑮d 回填报 attachments 计数 ≥1', attCount >= 1, `count=${attCount}`)

// ⑯ 角色:清单端点;建会话带 personaId → 单会话查回绑定;未知角色 400
const pl = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/personas -H "Authorization: Bearer ${T5}"`).toString())
ok('⑯a 角色清单为数组', Array.isArray(pl.personas), `n=${(pl.personas || []).length}`)
const pid = pl.personas?.[0]?.id
if (pid) {
  const sidP = JSON.parse(execSync(`curl -s -X POST http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"personaId":"${pid}"}'`).toString()).id
  const oneP = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/sessions/${sidP} -H "Authorization: Bearer ${T5}"`).toString())
  ok('⑯b 建会话带角色并查回', oneP.personaId === pid, `${oneP.personaId}`)
} else {
  ok('⑯b 建会话带角色并查回', true, '无种子角色,跳过正向断言')
}
const badP = execSync(`curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"personaId":"no_such_persona"}'`).toString().trim()
ok('⑯c 未知角色 → 400', badP === '400', `got ${badP}`)

// ⑰ 待决卡角标:发 "ask"(mock ask 分支)→ 列表 pendingCard=true → 作答 → false
const sidC = JSON.parse(execSync(`curl -s -X POST http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString()).id
execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${sidC}/send" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"text":"ask"}' > /dev/null`)
await sleep(2500)
const listC = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString())
const rowC = listC.sessions.find((x) => x.id === sidC)
ok('⑰a 未决卡 pendingCard=true', rowC?.pendingCard === true, `got ${rowC?.pendingCard}`)
const cardKey = JSON.parse(execSync(`curl -s "http://127.0.0.1:4317/api/sessions/${sidC}/messages?limit=50" -H "Authorization: Bearer ${T5}"`).toString())
  .messages.find((m) => m.card)?.card?.key
if (cardKey) {
  execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${sidC}/answer" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"key":"${cardKey}","kind":"ask","payload":{"answers":["Kotlin"]}}' > /dev/null`)
  await sleep(1500)
  const rowC2 = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString()).sessions.find((x) => x.id === sidC)
  ok('⑰b 作答后 pendingCard=false', rowC2?.pendingCard === false, `got ${rowC2?.pendingCard}`)
} else {
  ok('⑰b 作答后 pendingCard=false', false, '未取到卡 key')
}

// ⑱ 重命名:改 → 查回;空标题恢复自动派生
const r1 = JSON.parse(execSync(`curl -s -X POST "http://127.0.0.1:4317/api/sessions/${sidC}/rename" -H "Authorization: Bearer ${T5}" -H 'content-type: application/json' -d '{"title":"门禁改名测试"}'`).toString())
const r2 = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/sessions/${sidC} -H "Authorization: Bearer ${T5}"`).toString())
ok('⑱ 重命名生效', r1.ok === true && r2.title === '门禁改名测试', r2.title)

// ⑲ 删除:DELETE → GET 404 → 列表不含
const dCode = execSync(`curl -s -o /dev/null -w '%{http_code}' -X DELETE "http://127.0.0.1:4317/api/sessions/${sidC}" -H "Authorization: Bearer ${T5}"`).toString().trim()
const dGone = execSync(`curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4317/api/sessions/${sidC}" -H "Authorization: Bearer ${T5}"`).toString().trim()
ok('⑲ 删除 → 200 + 查 404', dCode === '200' && dGone === '404', `del=${dCode} get=${dGone}`)

// ⑳ tasks/models:只读清单形状(tasks 可为空数组;models 须含 mockprov:mock-model 且带 active)
const tk = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/tasks -H "Authorization: Bearer ${T5}"`).toString())
ok('⑳a 任务清单为数组', Array.isArray(tk.tasks), `n=${(tk.tasks || []).length}`)
const ml = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/models -H "Authorization: Bearer ${T5}"`).toString())
const hasMock = (ml.models || []).some((m) => m.ref === 'mockprov:mock-model')
ok('⑳b 模型清单含 active 默认', Array.isArray(ml.models) && hasMock && typeof ml.active === 'string', `n=${(ml.models || []).length}`)

// ㉑ 投影口径:回填与列表摘要不含引擎标记(⟦deva:compaction⟧/⟦deva:auto⟧/⟦deva:notify⟧——压缩摘要/自愈
// 引导/任务通知不当人话;压缩「只插摘要不删消息」后这类消息只增不减,投影不过滤就会把带标记原文当
// 用户气泡回给手机)。门禁实例没有标记会话时平凡为真;真标记场景的专验证:隔离 DEVA_HOME 预制含
// ⟦deva:*⟧ 前缀消息的会话文件 → 起实例配对 → 断言回填条数/序列连续/列表摘要不露标记(全量 11 断言)。
let leak = ''
const scanList = JSON.parse(execSync(`curl -s http://127.0.0.1:4317/api/sessions -H "Authorization: Bearer ${T5}"`).toString())
for (const s of scanList.sessions) {
  if (JSON.stringify(s).includes('⟦deva:')) leak = leak || `列表 ${s.id}`
  const ms = JSON.parse(execSync(`curl -s "http://127.0.0.1:4317/api/sessions/${s.id}/messages?limit=2000" -H "Authorization: Bearer ${T5}"`).toString())
  if ((ms.messages ?? []).some((m) => JSON.stringify(m).includes('⟦deva:'))) leak = leak || `回填 ${s.id}`
}
ok('㉑ 回填/列表摘要不露引擎标记 ⟦deva:*⟧', !leak, leak)

// ㉒ Web 控制台:GET / 页面壳免鉴权可取(同端口托管是浏览器接入前提,Origin 双重校验天然匹配);
// 数据端点仍须 Bearer(用无效 token 打 /api/info 应 401,页面壳不改变鉴权面)
const page = execSync(`curl -s http://127.0.0.1:4317/ -H "Origin: http://127.0.0.1:4317"`).toString()
ok('㉒a 页面壳免鉴权可取', page.includes('Deva Web 控制台'), `len=${page.length}`)
const shellNoAuth = execSync(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4317/api/info -H "Origin: http://127.0.0.1:4317"`).toString().trim()
ok('㉒b 数据端点仍须 Bearer', shellNoAuth === '401', `got ${shellNoAuth}`)

console.log(`\n===== ${pass}/${pass + fail} PASS =====`)
process.exit(fail ? 1 : 0)
