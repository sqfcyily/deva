import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  HISTORY_MERGE_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  DROP_COMMAND,
  RootNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  createEditor,
  mergeRegister,
  type EditorConfig,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { $canShowPlaceholder } from '@lexical/text'
import { mentionRanges } from '../../../shared/mention'
import { slashTokens } from '../../../shared/slash'

/*
 * 对话输入框的编辑器内核（Lexical 纯文本模式，取代原 textarea）。
 * 换成 contentEditable 是为了能给**会生效**的片段单独上色——textarea 只有一整段纯文本，做不到局部样式：
 *  · `/指令`：开头或正文中间的已启用技能，以及整条只有它的 /compact /rewind。认法与主进程 chat.ts sendMessage
 *    一致（shared/slash.ts：`/` 在开头或空白之后，名字取最长的 [A-Za-z0-9_-]+），再由调用方判定是否认得（isToken）；
 *  · 正文任意位置的 `@名字`（本对话成员、可 @ 的角色、@新建成员），认法同主进程 handleMentions（见 shared/mention.ts）：
 *    显示成成员标签（头像 + 名字，见 MentionNode）；还可能接着敲成更长名字时先只上色（见 $syncTokens）。
 * 输入框里始终只有一个段落：纯文本模式下回车 / 粘贴的换行都是段内 LineBreakNode。
 */

/**
 * 被识别为会生效的 `/指令`（以及还在敲、尚未定形的 `@名字`）：独立文本节点，只换颜色，仍可照常逐字编辑。
 * 紧挨着它键入的字符会先并进它，再由 $syncTokens 切回普通文本。
 */
export class SlashTokenNode extends TextNode {
  $config() {
    return this.config('slash-token', { extends: TextNode })
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config)
    el.classList.add('cf-slash-token')
    return el
  }
}

const $isSlashTokenNode = (node: LexicalNode | null | undefined): node is SlashTokenNode =>
  node instanceof SlashTokenNode

/** 各编辑器的 @ 标签头像来源（createDOM 里只拿得到 editor，取不到外层 React 的 handlers）。 */
const mentionFaces = new WeakMap<LexicalEditor, (name: string) => string | null>()

/**
 * 输入框里的成员标签：一个整体（光标不进入、退格整枚删除、方向键跨过），画成「头像 + 名字」，不写 @。
 * 文本内容仍是 `@名字`——发送、复制、主进程认人都照纯文本走，与没做成标签时一致。
 */
export class MentionNode extends DecoratorNode<null> {
  __mention: string

  $config() {
    return this.config('mention', { extends: DecoratorNode })
  }

  constructor(mention = '', key?: NodeKey) {
    super(key)
    this.__mention = mention
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode)
    this.__mention = prevNode.__mention
  }

  getTextContent(): string {
    return this.getLatest().__mention
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const name = this.__mention.slice(1)
    const el = document.createElement('span')
    el.className = 'cf-mention'
    el.contentEditable = 'false'
    const face = mentionFaces.get(editor)?.(name)
    if (face) {
      const img = document.createElement('img')
      img.className = 'cf-mention__face'
      img.src = face
      img.alt = ''
      img.draggable = false
      el.append(img)
    }
    el.append(document.createTextNode(name))
    return el
  }

  updateDOM(): boolean {
    return false
  }

  decorate(): null {
    return null
  }

  isInline(): boolean {
    return true
  }

  /** 方向键直接跨过，不选中整枚（退格同样直接删除，见 Lexical deleteCharacter 的内联 decorator 分支）。 */
  isKeyboardSelectable(): boolean {
    return false
  }
}

const $isMentionNode = (node: LexicalNode | null | undefined): node is MentionNode => node instanceof MentionNode

/**
 * 用 next 原位替换 node，并把落在 node 上的光标按原偏移挪到 next 上
 * （LexicalNode.replace 默认把光标甩到新节点末尾，打字中途会跳光标）。
 */
function $swapTextNode(node: TextNode, next: TextNode): void {
  const sel = $getSelection()
  const key = node.getKey()
  const keep = $isRangeSelection(sel)
    ? (['anchor', 'focus'] as const).filter((p) => sel[p].key === key).map((p) => [p, sel[p].offset] as const)
    : []
  node.replace(next)
  const after = $getSelection()
  if ($isRangeSelection(after)) for (const [p, offset] of keep) after[p].set(next.getKey(), offset, 'text')
}

/** 光标在段落全文里的位置（未折叠或不在本段时为 null）。 */
function $caretOffset(block: LexicalNode | null, leaves: LexicalNode[]): number | null {
  const sel = $getSelection()
  if (!$isRangeSelection(sel) || !sel.isCollapsed() || !block) return null
  const { anchor } = sel
  let offset = 0
  if (anchor.type === 'element') {
    if (anchor.key !== block.getKey()) return null
    for (let i = 0; i < anchor.offset && i < leaves.length; i++) offset += leaves[i].getTextContentSize()
    return offset
  }
  for (const n of leaves) {
    if (n.getKey() === anchor.key) return offset + anchor.offset
    offset += n.getTextContentSize()
  }
  return null
}

/**
 * 从 start 处的 @ 到光标之间是不是还在敲名字：中间没有空白，且还有更长的名字以它开头
 * （「@后端」后面可能接着敲成「@后端接口与数据库」）。是的话先只上色，不急着做成标签。
 */
function stillTyping(text: string, start: number, caret: number | null, names: readonly string[]): boolean {
  if (caret === null || caret <= start) return false
  const typed = text.slice(start + 1, caret)
  if (/\s/.test(typed)) return false
  return names.some((n) => n.length > typed.length && n.startsWith(typed))
}

/** 把一段普通文本换成成员标签；光标原本在这段上的，挪到标签之后。 */
function $swapForMention(piece: TextNode): void {
  const sel = $getSelection()
  const key = piece.getKey()
  const onPiece = $isRangeSelection(sel) && (sel.anchor.key === key || sel.focus.key === key)
  const chip = new MentionNode(piece.getTextContent())
  piece.replace(chip)
  if (onPiece) chip.selectNext(0, 0)
}

/**
 * 让文档里的特殊节点与「会生效的片段」保持一致：`/指令` 与还在敲的 `@名字` 是 SlashTokenNode（只上色），
 * 定形的 `@名字` 是 MentionNode（成员标签）。位置或文字不对的降回普通文本，该有却没有的从所在文本节点里切出来
 * 换上。每次只改一处后返回——改动会再次弄脏 root，Lexical 先合并相邻普通文本再重跑本变换，直到收敛。
 * 返回值：是否还有只上色、未成标签的 `@名字`（光标移开时要再同步一次把它定形）。
 */
function $syncTokens(isToken: (name: string, whole: string) => boolean, mentionNames: readonly string[]): boolean {
  const root = $getRoot()
  const block = root.getFirstChild()
  const leaves = $isElementNode(block) ? block.getChildren() : []
  const text = leaves.map((n) => n.getTextContent()).join('')
  const want: { start: number; end: number; chip: boolean }[] = []
  const whole = root.getTextContent().trim()
  for (const tk of slashTokens(text))
    if (isToken(tk.name, whole)) want.push({ start: tk.start, end: tk.end, chip: false })
  const caret = $caretOffset(block, leaves)
  for (const r of mentionRanges(text, mentionNames))
    if (!want.some((w) => r.start < w.end && w.start < r.end))
      want.push({ ...r, chip: !stillTyping(text, r.start, caret, mentionNames) })
  const pending = want.some((w) => !w.chip && text[w.start] === '@')

  let offset = 0
  const settled = new Set<number>()
  for (const node of leaves) {
    const size = node.getTextContentSize()
    if ($isSlashTokenNode(node) || $isMentionNode(node)) {
      // 已成标签的只要位置与文字仍对得上就保留（光标挪回它后面也不拆回文字）；只上色的须仍是「只上色」。
      const chip = $isMentionNode(node)
      const i = want.findIndex(
        (w, k) => !settled.has(k) && w.start === offset && w.end === offset + size && (chip || !w.chip)
      )
      if (i >= 0) settled.add(i)
      else {
        if (chip) node.replace($createTextNode(node.getTextContent()))
        else $swapTextNode(node, $createTextNode(node.getTextContent()))
        return pending
      }
    }
    offset += size
  }
  const next = want.find((_, k) => !settled.has(k))
  if (!next) return pending

  offset = 0
  for (const node of leaves) {
    const size = node.getTextContentSize()
    if (offset + size > next.start) {
      // 区段须整个落在同一个普通文本节点内；横跨多个节点说明合并尚未发生，等下一轮。
      if (!$isTextNode(node) || !node.isSimpleText() || offset + size < next.end) return pending
      const start = next.start - offset
      const end = next.end - offset
      const parts = start === 0 ? node.splitText(end) : node.splitText(start, end)
      const piece = parts[start === 0 ? 0 : 1]
      if (piece) {
        if (next.chip) $swapForMention(piece)
        else $swapTextNode(piece, new SlashTokenNode(piece.getTextContent()))
      }
      return pending
    }
    offset += size
  }
  return pending
}

/**
 * 光标所在的「词」以 `/` 或 `@` 开头（在开头或空白之后）：外层据此弹出技能 / 成员联想。
 * query = `/` `@` 之后到光标的部分；end = 这个词的末尾（采纳时并不整个换掉，换到哪里见 triggerReplaceEnd）；
 * alone = 除了这个词，输入框里没有别的内容（/compact、/rewind 只在这时可选）。
 */
export interface ComposerTrigger {
  char: '/' | '@'
  query: string
  start: number
  end: number
  alone: boolean
}

/** 光标处的联想触发词（见 ComposerTrigger）；没有或选区未折叠时为 null。 */
function $triggerAt(): ComposerTrigger | null {
  const block = $getRoot().getFirstChild()
  const leaves = $isElementNode(block) ? block.getChildren() : []
  const caret = $caretOffset(block, leaves)
  if (caret === null) return null
  const text = leaves.map((n) => n.getTextContent()).join('')
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const char = text[start]
  if (char !== '/' && char !== '@') return null
  const query = text.slice(start + 1, caret)
  const word = char === '/' ? /[A-Za-z0-9_-]/ : /[^\s@]/
  if (![...query].every((c) => word.test(c))) return null
  let end = caret
  while (end < text.length && word.test(text[end])) end++
  return { char, query, start, end, alone: !text.slice(0, start).trim() && !text.slice(end).trim() }
}

/**
 * 采纳联想 name（不含 `/` `@`）时要换掉的区间终点：`/` `@` 与已敲的部分，再加上光标后与名字余下部分对得上的字
 * （光标落在词中间时，如「@后|端」采纳「后端」）。光标后的其余文字是用户原有的内容，不能当成这个词一并换掉——
 * 中文不靠空格分词，在一段话前敲 @ 时，这个「词」会一直延伸到整段话的末尾。
 */
export function triggerReplaceEnd(text: string, trigger: ComposerTrigger, name: string): number {
  const caret = trigger.start + 1 + trigger.query.length
  const typed = trigger.query.toLowerCase()
  const full = name.toLowerCase()
  const rest = full.startsWith(typed) ? full.slice(typed.length) : ''
  const after = text.slice(caret, trigger.end).toLowerCase()
  let k = 0
  while (k < rest.length && k < after.length && rest[k] === after[k]) k++
  return caret + k
}

const sameTrigger = (a: ComposerTrigger | null, b: ComposerTrigger | null): boolean =>
  a === b ||
  (!!a && !!b && a.char === b.char && a.query === b.query && a.start === b.start && a.end === b.end && a.alone === b.alone)

/** 输入框交给外层处理的按键（其余按键走 Lexical 纯文本默认行为）。 */
export type ComposerKey = 'enter' | 'up' | 'down' | 'tab' | 'escape'

export interface ComposerEditorHandlers {
  /** 文本变化（含程序写入）；内容未变的更新（如仅移动光标）不触发。 */
  onChange: (text: string) => void
  /** 光标处的联想触发词变了（打字、移动光标都会；见 ComposerTrigger）。 */
  onTrigger: (trigger: ComposerTrigger | null) => void
  /** 返回 true = 已处理（须自行 preventDefault），false = 交还编辑器默认行为。 */
  onKey: (key: ComposerKey, e: KeyboardEvent) => boolean
  /** 粘贴：返回 true = 已接管（如粘贴文件转附件），false = 按纯文本粘贴。 */
  onPaste: (e: ClipboardEvent) => boolean
  /** 开头 `/name` 是否会生效（name 为去掉斜杠的原文，whole 为去首尾空白的整条消息）。 */
  isToken: (name: string, whole: string) => boolean
  /** 正文里 `@名字` 会生效的名字（本对话成员、可 @ 的角色、新建成员标记）；空 = 不认 @。 */
  mentionNames: readonly string[]
  /** 成员标签的头像（图片地址，名字不含 @）；null = 不放头像（如「新建成员」）。 */
  mentionFace: (name: string) => string | null
}

export interface ComposerEditor {
  /** 挂到 contentEditable 元素上的 ref 回调。 */
  rootRef: (el: HTMLDivElement | null) => void
  /** 内容为空且不在输入法组字中：外层据此显示占位提示。 */
  empty: boolean
  /** 当前全文（先落定未提交的编辑，发送时用它而不是可能滞后一拍的 React 状态）。 */
  getText: () => string
  /** 整体替换内容，光标置于末尾；focus=true 时顺带聚焦。 */
  setText: (text: string, focus?: boolean) => void
  /** 把全文 [start, end) 换成 text，光标放在换上的内容之后，并聚焦（采纳联想用，其余内容不动）。 */
  replaceRange: (start: number, end: number, text: string) => void
  /** 清空撤销历史（发送后调用，免得撤销把已发出的内容找回来）。 */
  clearHistory: () => void
  /** isToken / mentionNames 的判定依据（技能列表、附件数、成员名单）变了：重新识别要上色的片段与成员标签。 */
  refreshToken: () => void
}

export function useComposerEditor(handlers: ComposerEditorHandlers): ComposerEditor {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const [editor] = useState<LexicalEditor>(() =>
    createEditor({
      namespace: 'deva-composer',
      nodes: [SlashTokenNode, MentionNode],
      onError: (err) => console.error('[composer]', err)
    })
  )
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    mentionFaces.set(editor, (name) => handlersRef.current.mentionFace(name))
    let lastText = ''
    /** 组字期间跳过了指令识别（改动正在组字的节点会打断输入法），组字结束后补一次。 */
    let skipped = false
    /** 还有只上色、未成标签的 @名字：光标移开时再同步一次，把它做成标签。 */
    let pending = false
    let lastTrigger: ComposerTrigger | null = null
    const key = <E extends KeyboardEvent | null>(command: LexicalCommand<E>, name: ComposerKey) =>
      editor.registerCommand(
        command,
        (e: E) => (e === null || e.isComposing ? false : handlersRef.current.onKey(name, e)),
        COMMAND_PRIORITY_HIGH
      )
    // 空文档先放一个段落：根节点下没有块时，首次键入没有可落脚的位置。
    editor.update(
      () => {
        const root = $getRoot()
        if (root.isEmpty()) root.append($createParagraphNode())
      },
      { tag: [HISTORY_MERGE_TAG, SKIP_DOM_SELECTION_TAG] }
    )
    return mergeRegister(
      registerPlainText(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
      editor.registerNodeTransform(RootNode, () => {
        if (editor.isComposing()) skipped = true
        else pending = $syncTokens(handlersRef.current.isToken, handlersRef.current.mentionNames)
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          if (pending && !editor.isComposing())
            editor.update(() => $getRoot().markDirty(), { tag: HISTORY_MERGE_TAG })
          return false
        },
        COMMAND_PRIORITY_LOW
      ),
      editor.registerUpdateListener(({ editorState }) => {
        const [text, blank, trigger] = editorState.read(
          () => [$getRoot().getTextContent(), $canShowPlaceholder(editor.isComposing()), $triggerAt()] as const
        )
        setEmpty(blank)
        const textChanged = text !== lastText
        const triggerChanged = !sameTrigger(trigger, lastTrigger)
        lastText = text
        lastTrigger = trigger
        // 同步刷新外层：下一次按键（如紧跟的 Enter）读到的联想 / 发送状态已是最新文本，与受控 textarea 一致。
        if (textChanged || triggerChanged)
          flushSync(() => {
            if (textChanged) handlersRef.current.onChange(text)
            if (triggerChanged) handlersRef.current.onTrigger(trigger)
          })
        if (skipped && !editor.isComposing()) {
          skipped = false
          editor.update(() => $getRoot().markDirty(), { tag: HISTORY_MERGE_TAG })
        }
      }),
      key(KEY_ENTER_COMMAND, 'enter'),
      key(KEY_ARROW_UP_COMMAND, 'up'),
      key(KEY_ARROW_DOWN_COMMAND, 'down'),
      key(KEY_TAB_COMMAND, 'tab'),
      key(KEY_ESCAPE_COMMAND, 'escape'),
      editor.registerCommand(
        PASTE_COMMAND,
        (e) => e instanceof ClipboardEvent && handlersRef.current.onPaste(e),
        COMMAND_PRIORITY_HIGH
      ),
      // 拖入文件：不让 Lexical 按文本落入，事件继续冒泡，由外层在窗口级统一转成附件。
      editor.registerCommand(
        DROP_COMMAND,
        (e) => Boolean(e.dataTransfer?.types.includes('Files')),
        COMMAND_PRIORITY_HIGH
      )
    )
  }, [editor])

  const rootRef = useCallback((el: HTMLDivElement | null) => editor.setRootElement(el), [editor])

  const getText = useCallback(() => editor.read(() => $getRoot().getTextContent()), [editor])

  /**
   * 程序改内容：未聚焦时不同步 DOM 选区——Lexical 写 DOM 选区会顺带把焦点抢进输入框。
   * 要聚焦时 editor.focus() 只恢复选区，焦点仍可能留在刚点过的按钮上，故再显式 focus 根元素（同 Lexical AutoFocusPlugin）。
   */
  const update = useCallback(
    (fn: () => void, tags: string[], focus: boolean) => {
      const root = editor.getRootElement()
      const focused = root !== null && root.contains(document.activeElement)
      editor.update(fn, {
        tag: focus || focused ? tags : [...tags, SKIP_DOM_SELECTION_TAG],
        onUpdate: focus
          ? () =>
              editor.focus(() => {
                const el = editor.getRootElement()
                if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
              })
          : undefined
      })
    },
    [editor]
  )

  const setText = useCallback(
    (text: string, focus = false) =>
      update(
        () => {
          const root = $getRoot()
          root.clear()
          const p = $createParagraphNode()
          root.append(p)
          p.select()
          const sel = $getSelection()
          if (text && $isRangeSelection(sel)) sel.insertRawText(text)
        },
        [],
        focus
      ),
    [update]
  )

  const replaceRange = useCallback(
    (start: number, end: number, text: string) =>
      update(
        () => {
          const block = $getRoot().getFirstChild()
          const leaves = $isElementNode(block) ? block.getChildren() : []
          // 通常整段落在一个文本节点里（正在敲的词）：就地替换，光标随之移到新内容之后，别处的标签不动。
          let offset = 0
          for (const n of leaves) {
            const size = n.getTextContentSize()
            if ($isTextNode(n) && offset <= start && end <= offset + size) {
              n.spliceText(start - offset, end - start, text, true)
              return
            }
            offset += size
          }
          // 跨了节点（少见）：整段重写，光标放在新内容之后。
          const all = leaves.map((n) => n.getTextContent()).join('')
          const root = $getRoot()
          root.clear()
          const p = $createParagraphNode()
          root.append(p)
          p.select()
          const sel = $getSelection()
          if (!$isRangeSelection(sel)) return
          sel.insertRawText(all.slice(0, start) + text)
          const caret = $getSelection()?.clone() ?? null
          const tail = all.slice(end)
          if (tail) {
            const after = $getSelection()
            if ($isRangeSelection(after)) after.insertRawText(tail)
            if (caret) $setSelection(caret)
          }
        },
        [],
        true
      ),
    [update]
  )

  const clearHistory = useCallback(
    () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
    [editor]
  )

  const refreshToken = useCallback(
    () => update(() => $getRoot().markDirty(), [HISTORY_MERGE_TAG], false),
    [update]
  )

  return { rootRef, empty, getText, setText, replaceRange, clearHistory, refreshToken }
}
