/**
 * 内置浏览器界面共用的文案拼装（「Deva 浏览器」窗口的状态条、主窗口的胶囊）。
 * 动词沿用时间轴的 chat.flow.doing.browser*（与执行步骤里的说法一致）。
 */

/** browser 工具的 action → 时间轴动词键。 */
const DOING_KEY: Record<string, string> = {
  open: 'browserOpen',
  snapshot: 'browserRead',
  click: 'browserClick',
  type: 'browserType',
  select: 'browserSelect',
  press: 'browserPress',
  scroll: 'browserScroll',
  back: 'browserBack',
  forward: 'browserForward',
  reload: 'browserReload',
  wait: 'browserWait',
  screenshot: 'browserShot',
  evaluate: 'browserEval'
}

/** 对象写成「…」的动作（元素名）；open 的对象是网站，原样写。 */
const QUOTED = new Set(['click', 'type', 'select'])

/** 「正在点击「退款」」「正在打开网页 works.inca.co.kr」。 */
export function doingText(t: (key: string) => string, action: string, label?: string): string {
  const key = DOING_KEY[action]
  const verb = t(key ? `chat.flow.doing.${key}` : 'chat.flow.doing.browser')
  if (!label) return verb
  return QUOTED.has(action) ? `${verb}「${label}」` : `${verb} ${label}`
}

/** 标签显示的标题：网页标题 → 网址里的站点 → 「加载中…」。 */
export function tabTitle(t: (key: string) => string, tab: { title: string; url: string }): string {
  if (tab.title) return tab.title
  try {
    if (tab.url) return new URL(tab.url).host || tab.url
  } catch {
    /* 非标准网址：原样 */
  }
  return tab.url || t('browser.untitled')
}

/**
 * 网页所在的站点（主机名，国际化域名保持 xn-- 编码，仿冒域名更容易看出来）与是否加密；非 http(s) 网页返回 null。
 * 等用户登录时的提示条、标签悬停提示用。
 */
export function siteOf(url: string): { host: string; secure: boolean } | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' || u.protocol === 'http:') return { host: u.host, secure: u.protocol === 'https:' }
  } catch {
    /* 非标准网址 */
  }
  return null
}

/** 胶囊列表里显示的网址：解码中文，去掉 http(s):// 前缀。 */
export function displayUrl(url: string): string {
  let s = url
  try {
    s = decodeURI(url)
  } catch {
    /* 解码失败原样显示 */
  }
  return s.replace(/^https?:\/\//, '')
}
