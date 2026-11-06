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

/*
 * 对话输入框的编辑器内核（Lexical 纯文本模式，取代原 textarea）。
 * 换成 contentEditable 是为了能给**会生效**的片段单独上色——textarea 只有一整段纯文本，做不到局部样式：
 *  · 消息开头的 `/指令`（已启用技能、整条只有它的 /compact /rewind）。识别规则与主进程 chat.ts sendMessage 一致：
 *    去掉前导空白后以 `/` 开头、取最长的 [A-Za-z0-9_-]+ 作为名字，再由调用方判定是否认得（isToken）；
 *  · 正文任意位置的 `@名字`（本对话成员、可 @ 的角色、@新成员），认法同主进程 handleMentions（见 shared/mention.ts）：
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

/** 开头指令：去掉前导空白后的 `/name`（name 取最长的 [A-Za-z0-9_-]+，同主进程的贪婪匹配）。 */
const LEADING_SLASH_RE = /^(\s*)\/([A-Za-z0-9_-]+)/

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
 * 让文档里的特殊节点与「会生效的片段」保持一致：开头 `/指令` 与还在敲的 `@名字` 是 SlashTokenNode（只上色），
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
  const m = LEADING_SLASH_RE.exec(text)
  if (m && isToken(m[2], root.getTextContent().trim()))
    want.push({ start: m[1].length, end: m[0].length, chip: false })
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

/** 输入框交给外层处理的按键（其余按键走 Lexical 纯文本默认行为）。 */
export type ComposerKey = 'enter' | 'up' | 'down' | 'tab' | 'escape'

export interface ComposerEditorHandlers {
  /** 文本变化（含程序写入）；内容未变的更新（如仅移动光标）不触发。 */
  onChange: (text: string) => void
  /** 返回 true = 已处理（须自行 preventDefault），false = 交还编辑器默认行为。 */
  onKey: (key: ComposerKey, e: KeyboardEvent) => boolean
  /** 粘贴：返回 true = 已接管（如粘贴文件转附件），false = 按纯文本粘贴。 */
  onPaste: (e: ClipboardEvent) => boolean
  /** 开头 `/name` 是否会生效（name 为去掉斜杠的原文，whole 为去首尾空白的整条消息）。 */
  isToken: (name: string, whole: string) => boolean
  /** 正文里 `@名字` 会生效的名字（本对话成员、可 @ 的角色、新成员标记）；空 = 不认 @。 */
  mentionNames: readonly string[]
  /** 成员标签的头像（图片地址，名字不含 @）；null = 不放头像（如「新成员」）。 */
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
        const [text, blank] = editorState.read(() => [
          $getRoot().getTextContent(),
          $canShowPlaceholder(editor.isComposing())
        ])
        setEmpty(blank)
        if (text !== lastText) {
          lastText = text
          // 同步刷新外层：下一次按键（如紧跟的 Enter）读到的联想 / 发送状态已是最新文本，与受控 textarea 一致。
          flushSync(() => handlersRef.current.onChange(text))
        }
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

  const clearHistory = useCallback(
    () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
    [editor]
  )

  const refreshToken = useCallback(
    () => update(() => $getRoot().markDirty(), [HISTORY_MERGE_TAG], false),
    [update]
  )

  return { rootRef, empty, getText, setText, clearHistory, refreshToken }
}
