/**
 * 手机版界面文案（界面壳子两种语言；对话内容由电脑端生成，与其界面语言一致）。
 */

const EN = /^en\b/i.test(navigator.language)

const STR = {
  // 通用
  appName: ['Deva', 'Deva'],
  phone: ['手机', 'Phone'],
  timeout: ['操作超时，请重试。', 'Timed out, please try again.'],
  notConnected: ['还没连上电脑。', 'Not connected to the computer.'],
  errorTitle: ['出错了', 'Something went wrong'],
  cancel: ['取消', 'Cancel'],
  close: ['关闭', 'Close'],
  ok: ['好', 'OK'],
  later: ['以后再说', 'Later'],
  yesterday: ['昨天', 'Yesterday'],
  justNow: ['刚刚', 'Just now'],
  // 连接
  connectingTitle: ['正在连接', 'Connecting'],
  stepTicket: ['验证二维码', 'Verify the QR code'],
  stepSecure: ['建立加密连接', 'Set up encryption'],
  stepSync: ['同步对话', 'Sync chats'],
  offlineTitle: ['{pc}不在线', '{pc} is offline'],
  offlineHintNoCache: ['电脑开机并打开 Deva 后自动恢复。', 'Reconnects once Deva is running on the computer.'],
  offlineShort: ['不在线', 'Offline'],
  // 标题后面的连接状态（onboard.tsx LinkStatus）与抽屉里的同步时间
  pcOffline: ['电脑不在线', 'Computer offline'],
  reconnectingShort: ['连接中…', 'Connecting…'],
  syncedAt: ['{t} 同步', 'synced {t}'],
  thisComputer: ['电脑', 'Computer'],
  // 首次 / 失效
  welcomeTitle: ['连接到电脑上的 Deva', 'Connect to Deva on your computer'],
  // 初始页的三步（「」里的词加粗）。
  guide1: ['打开电脑上的 Deva，点左下角的「手机」', 'Open Deva on your computer and click Phone at the bottom left'],
  guide2: ['点 +，添加「Deva 手机版」', 'Click + and add Deva Mobile'],
  guide3: ['用这台手机扫描出现的二维码', 'Scan the QR code that appears with this phone'],
  // 这个页面调不了相机（局域网地址不是 https、浏览器不支持）：没有「扫码连接」按钮，写明用什么扫。
  guide3Sys: ['用手机的「相机」或浏览器的「扫一扫」扫描出现的二维码', 'Scan the QR code that appears with your phone’s camera app or your browser’s scanner'],
  scanSysHint: ['这个页面不能直接扫码，请用手机的相机或浏览器的扫一扫。', 'This page can’t scan directly. Use your phone’s camera app or your browser’s scanner.'],
  e2eNote: ['端到端加密，只有你的手机和电脑能看到对话内容', 'End-to-end encrypted: only your phone and computer can read your chats'],
  connectingTo: ['正在连接 {pc}', 'Connecting to {pc}'],
  expiredTitle: ['二维码已失效', 'This QR code has expired'],
  expiredLead: ['每个二维码只能用一次，2 分钟后会自动换新。请在电脑 Deva 的「手机」里扫描最新的二维码。', 'Each QR code works once and refreshes every 2 minutes. Scan the latest one under Phone in Deva on your computer.'],
  continueWith: ['继续使用「{pc}」', 'Continue with “{pc}”'],
  removedTitle: ['这台手机已断开', 'This phone was disconnected'],
  removedLead: ['电脑上已移除这台手机。要继续使用，请在电脑 Deva 的「手机」里重新扫码。', 'This phone was removed on the computer. To keep using Deva, scan the QR code again under Phone in Deva.'],
  versionTitle: ['需要更新', 'Update needed'],
  scanNow: ['扫码连接', 'Scan to connect'],
  // 首页
  allChats: ['全部对话', 'All chats'],
  tasks: ['定时任务', 'Scheduled tasks'],
  // 定时任务（任务列表与详情；用词同电脑端「定时任务」页）
  tasksEmpty: ['还没有定时任务。可以在对话里让 Deva 帮你创建。', 'No scheduled tasks yet. Ask Deva in a chat to create one.'],
  taskGone: ['这个定时任务已被删除。', 'This scheduled task was deleted.'],
  task_active: ['进行中', 'Active'],
  task_paused: ['已暂停', 'Paused'],
  task_completed: ['已完成', 'Completed'],
  task_error: ['出错', 'Error'],
  run_ok: ['成功', 'Succeeded'],
  run_error: ['失败', 'Failed'],
  run_skipped: ['已跳过', 'Skipped'],
  run_aborted: ['已中止', 'Stopped'],
  taskSchedule: ['日程', 'Schedule'],
  taskNext: ['下次', 'Next'],
  taskLast: ['上次', 'Last'],
  taskRunMode: ['运行方式', 'Runs'],
  taskRunAlone: ['独立运行', 'On its own'],
  taskRunIn: ['在「{name}」中运行', 'In “{name}”'],
  taskModelDefault: ['默认模型', 'Default model'],
  taskNextNever: ['不再触发', 'Not scheduled'],
  taskLastNever: ['尚未运行', 'Never run'],
  taskPause: ['暂停', 'Pause'],
  taskResume: ['恢复', 'Resume'],
  taskRunNow: ['立即运行', 'Run now'],
  taskDelete: ['删除', 'Delete'],
  taskViewChat: ['查看对话', 'View chat'],
  taskStarted: ['已开始运行', 'Started'],
  taskDeleteTitle: ['删除「{name}」？', 'Delete “{name}”?'],
  taskDeleteOwned: ['任务和它的对话一起删除，无法恢复。', 'The task and its chat will be deleted. This can’t be undone.'],
  taskDeleteAlone: ['删除后不再运行，任务的对话会留在对话列表里。', 'It won’t run again. Its chat stays in your chat list.'],
  taskDeleteOk: ['删除任务', 'Delete task'],
  today: ['今天', 'Today'],
  tomorrow: ['明天', 'Tomorrow'],
  task: ['定时任务', 'Scheduled task'],
  personas: ['角色', 'Personas'],
  settings: ['设置', 'Settings'],
  search: ['搜索对话', 'Search chats'],
  searchTasks: ['搜索定时任务', 'Search scheduled tasks'],
  newChat: ['新对话', 'New chat'],
  pickPersona: ['选一个角色开始', 'Pick a persona to start'],
  chatsEmpty: ['还没有对话。点右上角开始一个新对话。', 'No chats yet. Tap the button at the top right to start one.'],
  filterEmpty: ['这里还没有对话。', 'Nothing here yet.'],
  noResult: ['没有匹配的对话', 'No matching chats'],
  waitingFlag: ['[等你决定]', '[Needs you]'],
  me: ['我：', 'Me: '],
  busy: ['处理中', 'Working'],
  // 添加到主屏幕 / 通知
  installTitle: ['把 Deva 添加到主屏幕', 'Add Deva to your home screen'],
  installLead: ['像 App 一样全屏打开，回复完成、需要你决定时能收到通知。', 'Open it full screen like an app, and get notified when replies are done or Deva needs you.'],
  installHow: ['怎么添加', 'Show me how'],
  installAdd: ['添加', 'Add'],
  installSheetTitle: ['添加到主屏幕', 'Add to Home Screen'],
  installSheetSub: ['只需要做一次', 'You only need to do this once'],
  installIos1: ['点 Safari 底部的', 'Tap Safari’s'],
  installIosShare: ['分享', 'Share'],
  installIos2: ['选择', 'Choose'],
  installIosAdd: ['添加到主屏幕', 'Add to Home Screen'],
  installIos3: ['以后从主屏幕的 Deva 打开', 'Open Deva from your home screen from now on'],
  installNote: ['添加后无需再扫码。', 'No need to scan again after adding.'],
  installAndroid: ['点浏览器菜单，选择「添加到主屏幕」或「安装应用」。', 'Open the browser menu and choose “Add to Home screen” or “Install app”.'],
  notifyTitle: ['需要时提醒你', 'Get notified when it matters'],
  notifyLead: ['回复完成、或者 Deva 停下来等你决定时，发通知给你。不推送其他内容。', 'We’ll notify you when a reply is done or Deva is waiting for you. Nothing else.'],
  notifyAllow: ['允许通知', 'Allow notifications'],
  notifyNotNow: ['暂不', 'Not now'],
  notifyDenied: ['通知已被系统拒绝，请在系统设置里允许 Deva 发通知。', 'Notifications are blocked. Allow them for Deva in system settings.'],
  notifyNeedInstall: ['添加到主屏幕后才能开启通知。', 'Add Deva to your home screen to turn on notifications.'],
  notifyNeedHttps: ['仅局域网连接时浏览器不支持通知。', 'Notifications aren’t available on a local-network connection.'],
  notifyUnsupported: ['这个浏览器不支持通知。', 'This browser doesn’t support notifications.'],
  // 对话页
  composer: ['发消息', 'Message'],
  composerBusy: ['补充说明，会插入这一轮', 'Add a note to this turn'],
  send: ['发送', 'Send'],
  stop: ['停止', 'Stop'],
  loadMore: ['查看更早的消息', 'Load earlier messages'],
  chatEmpty: ['还没有消息，发一条开始吧。', 'No messages yet. Say something.'],
  doneMeta: ['用时 {d}', 'Took {d}'],
  more: ['更多', 'More'],
  sendFailed: ['发送失败', 'Couldn’t send'],
  insertMissed: ['这一轮已结束，消息没有送达', 'The turn ended before this was delivered'],
  resend: ['重发', 'Resend'],
  waitingYou: ['等你决定', 'Needs you'],
  attachPhoto: ['照片', 'Photos'],
  attachCamera: ['拍照', 'Camera'],
  attachFile: ['文件', 'Files'],
  uploading: ['上传中', 'Uploading'],
  uploadFailed: ['上传失败', 'Upload failed'],
  attachBusy: ['这一轮还在进行中，带附件的消息请等它结束后再发。', 'This turn is still running. Send attachments after it finishes.'],
  // 对话操作
  archive: ['归档', 'Archive'],
  unarchive: ['取消归档', 'Unarchive'],
  archivedTitle: ['已归档', 'Archived'],
  archivedSnack: ['已归档「{title}」', 'Archived “{title}”'],
  undo: ['撤销', 'Undo'],
  archiveBusy: ['进行中的对话不能归档。', 'A chat that’s still running can’t be archived.'],
  archiveBusyShort: ['进行中', 'Running'],
  delete: ['删除', 'Delete'],
  deleteChat: ['删除对话', 'Delete chat'],
  confirmDelete: ['确认删除', 'Confirm'],
  deleteWarn: ['电脑上的这个对话也会一起删除，无法恢复。进行中的会先停止。', 'This also deletes the chat on your computer and can’t be undone. A running turn is stopped first.'],
  markRead: ['标为已读', 'Mark as read'],
  persona: ['角色', 'Persona'],
  members: ['成员', 'Members'],
  folder: ['文件夹', 'Folder'],
  model: ['模型', 'Model'],
  noModel: ['没有可用的模型', 'No models available'],
  pickModel: ['选择模型', 'Choose a model'],
  // 文件
  filePreview: ['点开预览', 'Tap to preview'],
  fileTruncated: ['内容较长，只显示了前面一部分，完整内容请在电脑上查看。', 'Long file: only the beginning is shown. Open it on the computer for the rest.'],
  fileLoading: ['正在从电脑取文件…', 'Getting the file from your computer…'],
  fileDownload: ['保存 / 分享', 'Save / Share'],
  fileNoPreview: ['这种文件不能直接预览。', 'This file can’t be previewed here.'],
  // 交互卡
  askFrom: ['{who} 想问你', '{who} has a question'],
  submit: ['提交', 'Submit'],
  skip: ['跳过', 'Skip'],
  other: ['自己输入…', 'Type your own…'],
  freeText: ['在此输入', 'Type here'],
  required: ['必答', 'Required'],
  multi: ['可多选', 'Pick any'],
  expand: ['展开', 'Expand'],
  collapse: ['收起', 'Collapse'],
  receiptView: ['查看', 'View'],
  // 成员在等你（主对话末尾的胶囊，只写谁在等什么，同电脑端）与处理完的回执
  mWaitAsk: ['{name}在等你回答', '{name} is waiting for your answer'],
  mWaitPlan: ['{name}在等你批准计划', '{name} is waiting for you to approve a plan'],
  mWaitMount: ['{name}在等你选择文件夹', '{name} is waiting for you to pick a folder'],
  mWaitPick: ['新成员{name}在等你选择文件夹', 'New member {name} is waiting for you to pick a folder'],
  mDoneAsk: ['已回答{name}', 'Answered {name}'],
  mDoneAskSkip: ['已跳过{name}的提问', 'Skipped {name}’s question'],
  mDoneApprove: ['已批准{name}的计划', 'Approved {name}’s plan'],
  mDoneKeep: ['已请{name}继续完善计划', 'Asked {name} to keep refining the plan'],
  mDoneIgnore: ['已忽略{name}的计划', 'Ignored {name}’s plan'],
  mDonePick: ['已为{name}选择文件夹', 'Picked a folder for {name}'],
  mDoneNoLimit: ['{name}不限文件夹', '{name}: any folder'],
  mDoneNoMount: ['{name}暂不挂载', '{name}: no folder for now'],
  // 为成员选文件夹的卡（「不限」的意思；手机上只能选不限）
  mPickQ: ['{name}负责哪个文件夹？', 'Which folder is {name} responsible for?'],
  mNoLimitNone: ['可以在任何位置。选「不限」则在默认工作区里工作。', 'It can be anywhere. With “Any”, it works in the default workspace.'],
  mNoLimitPaths: ['可以在任何位置。选「不限」则{name}继续在默认工作区里工作。', 'It can be anywhere. With “Any”, {name} keeps working in the default workspace.'],
  mPickOnDesk: ['选择具体的文件夹要在电脑上操作。', 'Picking a specific folder has to be done on the computer.'],
  noLimit: ['不限', 'Any'],
  // 设置
  computers: ['电脑', 'Computers'],
  manage: ['管理', 'Manage'],
  done: ['完成', 'Done'],
  removePcTitle: ['删除「{pc}」', 'Remove “{pc}”'],
  connected: ['已连接', 'Connected'],
  addComputer: ['添加另一台电脑', 'Add another computer'],
  addComputerHint: ['在那台电脑的 Deva 里扫码', 'Scan the QR code in Deva on that computer'],
  viaRelay: ['中转', 'Relay'],
  viaLan: ['局域网', 'Local network'],
  e2e: ['端到端加密', 'end-to-end encrypted'],
  remindDisplay: ['提醒与显示', 'Notifications & display'],
  notifications: ['通知', 'Notifications'],
  notifyHint: ['回复完成、需要你决定时提醒', 'When replies are done or Deva needs you'],
  appearance: ['外观', 'Appearance'],
  themeSystem: ['跟随系统', 'System'],
  themeLight: ['浅色', 'Light'],
  themeDark: ['深色', 'Dark'],
  textSize: ['文字大小', 'Text size'],
  sizeSm: ['小', 'Small'],
  sizeMd: ['标准', 'Default'],
  sizeLg: ['大', 'Large'],
  thisPhone: ['这台手机', 'This phone'],
  shownAs: ['在电脑上显示为', 'Shown on the computer as'],
  renamePrompt: ['在电脑上显示的名字', 'Name shown on the computer'],
  renameHint: ['电脑 Deva 的「手机」里用这个名字区分你的设备。', 'Deva on your computer lists your devices under Phone by this name.'],
  save: ['保存', 'Save'],
  disconnect: ['断开这台手机', 'Disconnect this phone'],
  disconnectHint: ['断开后需要在电脑上重新扫码', 'You’ll need to scan again to reconnect'],
  disconnectConfirm: ['断开后，这台手机将不能再使用「{pc}」上的 Deva，要再用需要重新扫码。', 'This phone will no longer be able to use Deva on “{pc}”. You’ll need to scan again to reconnect.'],
  disconnectOk: ['断开', 'Disconnect'],
  version: ['Deva 手机版 · 协议 v{v}', 'Deva mobile · protocol v{v}'],
  // 扫码
  scanTitle: ['扫描电脑上的二维码', 'Scan the QR code on your computer'],
  scanHint: ['在电脑 Deva 左下角的「手机」里找到二维码', 'Find it under Phone at the bottom left of Deva on your computer'],
  scanNoCamera: ['无法使用相机。请允许访问相机，或用系统相机扫码。', 'Can’t use the camera. Allow camera access, or scan with the system camera app.'],
  scanWrong: ['这不是 Deva 的二维码。', 'That isn’t a Deva QR code.']
} as const

export type StrKey = keyof typeof STR

export function t(key: StrKey, vars?: Record<string, string | number>): string {
  let s: string = STR[key][EN ? 1 : 0]
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v))
  return s
}

export const isEn = EN

/** 列表里的时间：今天只显示时分，昨天写「昨天」，更早写月/日。 */
export function fmtListTime(at: number): string {
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('yesterday')
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

/** 用时：52 秒 / 6 分 20 秒 / 1 小时 5 分。 */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (EN) {
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
