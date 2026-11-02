/**
 * 注入网页执行的脚本（以源码字符串经 executeJavaScript 运行，故不参与主进程类型检查，须自包含、只用浏览器 API）。
 *
 * 元素编号：snapshot 给可操作元素分配 e1、e2…，编号 → 元素存在页面里的 window.__devaRefs（WeakRef，不改 DOM，
 * 不触发网页自己的 MutationObserver）。同一元素再次 snapshot 沿用原编号；页面导航后编号表随页面一起消失。
 */

/** 把函数源码与参数拼成一段可执行的表达式。 */
export function callScript(fnSource: string, ...args: unknown[]): string {
  return `(${fnSource})(${args.map((a) => JSON.stringify(a ?? null)).join(',')})`
}

/**
 * 页面结构快照：按阅读顺序列出文字与可操作元素，可操作元素带编号。
 * 入参 { maxChars }；返回 { title, url, text, truncated, scroll: { y, h, vh }, dialogs }。
 */
export const SNAPSHOT_FN = String.raw`(opts) => {
  const MAX = (opts && opts.maxChars) || 12000
  // 从当前可视区域开始列出（scroll 之后用）：跳过整块位于可视区域上方的元素
  const FROM_VIEW = !!(opts && opts.fromView)
  const W = window
  if (!W.__devaRefs) { W.__devaRefs = new Map(); W.__devaRefOf = new WeakMap(); W.__devaRefSeq = 0 }
  const refs = W.__devaRefs, refOf = W.__devaRefOf
  const out = []
  let size = 0, truncated = false
  const clean = (s, n) => {
    // 零宽字符（网页常用来防抓取或占位）去掉，否则会出现看起来为空的名字
    s = String(s == null ? '' : s).replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim()
    return n && s.length > n ? s.slice(0, n) + '…' : s
  }
  const q = (s) => '"' + s.replace(/"/g, '\\"') + '"'
  const push = (depth, s) => {
    if (truncated) return
    const line = '  '.repeat(depth) + '- ' + s
    if (size + line.length + 1 > MAX) { truncated = true; return }
    out.push(line); size += line.length + 1
  }
  const refFor = (el) => {
    let r = refOf.get(el)
    if (!r) { r = 'e' + (++W.__devaRefSeq); refOf.set(el, r) }
    refs.set(r, new WeakRef(el))
    return r
  }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'svg', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'PATH'])
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'spinbutton', 'file', 'clickable'])
  const CONTAINER = new Set(['navigation', 'main', 'form', 'dialog', 'alertdialog', 'list', 'table', 'banner', 'contentinfo', 'complementary', 'menu', 'menubar', 'tablist', 'listbox', 'tree', 'grid', 'region', 'search'])
  const implicitRole = (el) => {
    const t = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (t === 'a') return el.hasAttribute('href') ? 'link' : null
    if (t === 'button' || t === 'summary') return 'button'
    if (t === 'input') {
      if (type === 'hidden') return 'hidden'
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'file') return 'file'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (t === 'textarea') return 'textbox'
    if (t === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (/^h[1-6]$/.test(t)) return 'heading'
    if (t === 'img') return 'img'
    if (t === 'nav') return 'navigation'
    if (t === 'main') return 'main'
    if (t === 'form') return 'form'
    if (t === 'dialog') return 'dialog'
    if (t === 'table') return 'table'
    if (t === 'ul' || t === 'ol') return 'list'
    if (t === 'iframe' || t === 'frame') return 'iframe'
    if (el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox'
    return null
  }
  const nameOf = (el, role) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return clean(aria, 100)
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const s = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText || n.textContent : '' }).join(' ')
      if (clean(s)) return clean(s, 100)
    }
    const t = el.tagName.toLowerCase()
    if (el.labels && el.labels.length) {
      const s = clean(el.labels[0].innerText || el.labels[0].textContent, 100)
      if (s) return s
    }
    if (role === 'img') return clean(el.getAttribute('alt') || el.getAttribute('title'), 100)
    if (t === 'input' && ['button', 'submit', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()))
      return clean(el.value || el.getAttribute('title'), 100)
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') {
      if (t === 'select') return clean(el.getAttribute('title') || el.getAttribute('name'), 60)
      if (t === 'input' || t === 'textarea') return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name'), 60)
    }
    return clean(el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '', 100)
  }
  const hasBox = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  // 链接去向只在有用时列出，省篇幅：外站链接只给域名；同站链接有名字就不列；没有名字的链接列路径（解码中文）
  const linkTarget = (el, named) => {
    const href = el.getAttribute('href') || ''
    if (!href || href.startsWith('javascript:') || href === '#') return ''
    try {
      const u = new URL(href, location.href)
      if (u.origin !== location.origin) return u.host
      if (named) return ''
      let s = u.pathname + u.search
      try { s = decodeURI(s) } catch (e) {}
      return s.length > 50 ? s.slice(0, 50) + '…' : s
    } catch (e) { return '' }
  }
  const describe = (el, role) => {
    const t = el.tagName.toLowerCase()
    const name = nameOf(el, role)
    let s = (role === 'clickable' ? 'clickable' : role) + (name ? ' ' + q(name) : '')
    s += ' [' + refFor(el) + ']'
    if (t === 'input' || t === 'textarea') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (role === 'checkbox' || role === 'radio') s += el.checked ? ' checked' : ' unchecked'
      else if (type === 'password') s += el.value ? ' value=●●●' : ' (password)'
      else if (role !== 'button' && role !== 'file') s += ' value=' + q(clean(el.value, 80))
    } else if (t === 'select') {
      const sel = Array.from(el.selectedOptions || []).map((o) => clean(o.textContent, 30)).join(', ')
      s += ' value=' + q(sel)
      const opts = Array.from(el.options || []).slice(0, 20).map((o) => clean(o.textContent, 30))
      if (opts.length) s += ' options: ' + opts.join(' / ') + (el.options.length > 20 ? ' …' : '')
    } else if (role === 'link') {
      const href = linkTarget(el, !!name)
      if (href) s += ' → ' + href
    }
    const ac = el.getAttribute('aria-checked'), ae = el.getAttribute('aria-expanded'), as = el.getAttribute('aria-selected')
    if (ac && t !== 'input') s += ac === 'true' ? ' checked' : ' unchecked'
    if (ae) s += ae === 'true' ? ' expanded' : ' collapsed'
    if (as === 'true') s += ' selected'
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s += ' disabled'
    return s
  }
  // 子节点（含开放的 shadow root）
  const kids = (n) => {
    const a = []
    if (n.shadowRoot) a.push(...n.shadowRoot.childNodes)
    a.push(...n.childNodes)
    return a
  }
  const isPointer = (el, st) => st.cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer')
  const BLOCK = /^(block|flex|grid|table|list-item|table-row|table-cell|flow-root)/
  let buf = '', bufDepth = 0
  const flush = () => {
    const s = clean(buf, 300)
    if (s) push(bufDepth, 'text: ' + s)
    buf = ''
  }
  const tableRow = (tr) => Array.from(tr.cells || []).map((c) => clean(c.innerText || c.textContent, 60)).join(' | ')
  // skipText：关联了表单控件的 <label> 里的文字已作为控件名字列出，不再重复
  const walk = (node, depth, skipText) => {
    for (const child of kids(node)) {
      if (truncated) return
      if (child.nodeType === 3) {
        if (skipText) continue
        const s = child.textContent
        if (s && s.trim()) { if (!buf) bufDepth = depth; buf += ' ' + s }
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child
      if (SKIP.has(el.tagName)) continue
      if (el.getAttribute('aria-hidden') === 'true') continue
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') continue
      if (FROM_VIEW && st.position !== 'fixed' && st.position !== 'sticky') {
        const rr = el.getBoundingClientRect()
        if (rr.height > 0 && rr.bottom < 0) continue
      }
      let role = (el.getAttribute('role') || '').split(/\s+/)[0] || implicitRole(el)
      if (role === 'hidden' || role === 'presentation' || role === 'none') { if (role === 'hidden') continue; role = null }
      const block = BLOCK.test(st.display)
      if (role && INTERACTIVE.has(role)) {
        if (!hasBox(el) && !(el.tagName === 'INPUT' && el.labels && el.labels.length)) continue
        flush()
        push(depth, describe(el, role))
        // 链接 / 按钮里的文字已体现在名字里；只有内部还嵌着其他可操作元素时才往下看
        if (el.querySelector('a[href],button,input,select,textarea,[role=button],[role=link]')) walk(el, depth + 1)
        continue
      }
      if (!role && isPointer(el, st) && hasBox(el) && clean(el.innerText || '').length) {
        flush()
        push(depth, describe(el, 'clickable'))
        if (el.querySelector('a[href],button,input,select,textarea')) walk(el, depth + 1)
        continue
      }
      if (role === 'heading') {
        flush()
        const lvl = el.tagName.match(/^H([1-6])$/) ? el.tagName.slice(1) : el.getAttribute('aria-level') || ''
        push(depth, 'heading ' + q(nameOf(el, role)) + (lvl ? ' (h' + lvl + ')' : ''))
        if (el.querySelector('a[href],button,input')) walk(el, depth + 1)
        continue
      }
      if (role === 'img') {
        const alt = nameOf(el, role)
        if (alt && hasBox(el)) { flush(); push(depth, 'img ' + q(alt)) }
        continue
      }
      if (role === 'iframe') {
        flush()
        let src = el.getAttribute('src') || ''
        if (src.length > 60) src = src.slice(0, 60) + '…'
        push(depth, 'iframe' + (src ? ' ' + src : '') + '（框架内容未展开）')
        continue
      }
      if (role === 'table') {
        flush()
        push(depth, 'table')
        for (const tr of Array.from(el.rows || [])) {
          if (truncated) break
          if (tr.querySelector('a[href],button,input,select,textarea,[role=button]')) {
            push(depth + 1, 'row')
            walk(tr, depth + 2)
            flush()
          } else {
            const r = tableRow(tr)
            if (r.replace(/[|\s]/g, '')) push(depth + 1, 'row: ' + r)
          }
        }
        continue
      }
      if (role && CONTAINER.has(role)) {
        flush()
        const name = el.getAttribute('aria-label')
        push(depth, role + (name ? ' ' + q(clean(name, 60)) : ''))
        walk(el, depth + 1)
        flush()
        continue
      }
      if (block) flush()
      walk(el, depth, skipText || (el.tagName === 'LABEL' && !!el.control))
      if (block) flush()
    }
  }
  if (document.body) walk(document.body, 0)
  flush()
  const dialogs = W.__devaDialogs || []
  W.__devaDialogs = []
  return {
    title: document.title,
    url: location.href,
    text: out.join('\n'),
    truncated,
    scroll: { y: Math.round(window.scrollY), h: Math.round(document.documentElement.scrollHeight), vh: Math.round(window.innerHeight) },
    dialogs
  }
}`

/**
 * 按编号定位元素：滚到可视区域中央，返回中心点坐标与命中检测结果。
 * 返回 { ok, x, y, tag, type, editable, blocker } 或 { error: 'stale' | 'invisible' }。
 */
export const LOCATE_FN = String.raw`(ref) => {
  const m = window.__devaRefs
  const w = m && m.get(ref)
  const el = w && w.deref()
  if (!el || !el.isConnected) return { error: 'stale' }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  let target = el
  let r = el.getBoundingClientRect()
  // 被标签包住、自身不可见的复选框 / 单选框：改点它的标签
  if ((r.width === 0 || r.height === 0) && el.labels && el.labels.length) { target = el.labels[0]; r = target.getBoundingClientRect() }
  if (r.width === 0 || r.height === 0) return { error: 'invisible' }
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  let hit = document.elementFromPoint(x, y)
  while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner }
  const within = (a, b) => { for (let n = a; n; n = n.parentNode || n.host) if (n === b) return true; return false }
  const ok = !!hit && (within(hit, target) || within(target, hit) || (el.labels && Array.from(el.labels).some((l) => within(hit, l))))
  let blocker = ''
  if (!ok && hit) {
    const t = (hit.innerText || hit.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    blocker = hit.tagName.toLowerCase() + (t ? ' "' + t.slice(0, 40) + '"' : '')
  }
  const tag = el.tagName.toLowerCase()
  // 给界面看的元素名字（时间轴上「已点击「退款」」）：同 snapshot 的取名顺序，简化版
  const lbl = (el.getAttribute('aria-label') || (el.labels && el.labels.length ? el.labels[0].innerText : '') ||
    (tag === 'input' && ['button', 'submit', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()) ? el.value : '') ||
    el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '')
    .replace(/[​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim()
  return {
    ok, x, y, tag,
    label: lbl.length > 30 ? lbl.slice(0, 30) + '…' : lbl,
    type: (el.getAttribute('type') || '').toLowerCase(),
    editable: tag === 'textarea' || (tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes((el.getAttribute('type') || '').toLowerCase())) || el.isContentEditable,
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    blocker
  }
}`

/** 输入前：聚焦元素，需要清空时选中其全部内容（随后 insertText 会替换选区）。 */
export const FOCUS_FN = String.raw`(ref, clear) => {
  const m = window.__devaRefs
  const w = m && m.get(ref)
  const el = w && w.deref()
  if (!el || !el.isConnected) return { error: 'stale' }
  el.focus()
  if (clear) {
    if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select()
    else if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el)
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
    }
  }
  const a = document.activeElement
  return { ok: a === el || el.contains(a) || (el.shadowRoot && el.shadowRoot.activeElement != null) }
}`

/** 下拉框选择：按选项的值或显示文字匹配，触发 input / change 事件。 */
export const SELECT_FN = String.raw`(ref, values) => {
  const m = window.__devaRefs
  const w = m && m.get(ref)
  const el = w && w.deref()
  if (!el || !el.isConnected) return { error: 'stale' }
  if (el.tagName !== 'SELECT') return { error: 'not-select' }
  const want = values.map((v) => String(v).trim())
  const opts = Array.from(el.options)
  const picked = []
  for (const o of opts) {
    const hit = want.some((v) => v === o.value || v === o.textContent.replace(/\s+/g, ' ').trim())
    if (el.multiple) o.selected = hit
    else if (hit && !picked.length) o.selected = true
    if (hit && (el.multiple || !picked.length)) picked.push(o.textContent.replace(/\s+/g, ' ').trim())
  }
  if (!picked.length) return { error: 'no-match', options: opts.slice(0, 30).map((o) => o.textContent.replace(/\s+/g, ' ').trim()) }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, picked }
}`

/**
 * 新文档开始时注入（CDP Page.addScriptToEvaluateOnNewDocument）：接管 alert / confirm / prompt，
 * 不弹原生对话框（离屏页面里会卡住或弹到桌面），只记下内容，下次读取页面时一并告知模型。
 * confirm / prompt 默认「取消」——删除这类操作不会被悄悄确认掉；模型确实要继续时用 dialog 动作设定一次性应答
 * （window.__devaDialogAnswer），再重做触发它的操作。记录以「待定：」开头的表示按默认取消了，结果里会附上处理办法。
 */
export const DIALOG_SHIM = String.raw`(() => {
  const rec = (kind, msg, answer) => {
    try { (window.__devaDialogs = window.__devaDialogs || []).push(kind + '「' + String(msg == null ? '' : msg).slice(0, 200) + '」，' + answer) } catch (e) {}
  }
  const take = () => { const a = window.__devaDialogAnswer; window.__devaDialogAnswer = undefined; return a }
  window.alert = (m) => { rec('提示框', m, '已关闭') }
  window.confirm = (m) => {
    const a = take()
    if (a && a.accept === true) { rec('确认框', m, '已按你的设定点了「确定」'); return true }
    rec('确认框', m, a ? '已按你的设定点了「取消」' : '待定：已默认点「取消」'); return false
  }
  window.prompt = (m, d) => {
    const a = take()
    if (a && a.accept === true) { rec('输入框', m, '已按你的设定填入并确定'); return a.text != null ? String(a.text) : (d == null ? '' : String(d)) }
    rec('输入框', m, a ? '已按你的设定点了「取消」' : '待定：已默认点「取消」'); return null
  }
})()`
