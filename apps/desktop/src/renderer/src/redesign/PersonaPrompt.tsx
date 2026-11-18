import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import './persona-prompt.css'

/**
 * 角色编辑器的系统提示词（对比稿 design/persona-editor.html：收起方案 A、编辑页方案 ①）。
 * 表单里收起成一行（与输入框同高）：正文开头压成一行 + 字数 + ›，点了在同一个弹窗里换成编辑页；
 * 编辑页同头像面板：「完成」把改动带回表单，「取消」/ ✕ 丢弃，真正落盘仍走表单底部的保存。
 */

/** 字数：不计空白（中文按字、英文按字母，只作参考）。 */
function promptLength(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

/** 表单里收起的一行。 */
export function PersonaPromptRow({ value, onOpen }: { value: string; onOpen: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const text = value.replace(/\s*\n+\s*/g, ' ').trim()
  return (
    <div className="cf-field">
      <label className="cf-field__label">{t('cf.fPrompt')}</label>
      <button type="button" className="cf-promptrow" onClick={onOpen}>
        <span className={`cf-promptrow__text${text ? '' : ' is-empty'}`}>{text || t('cf.promptEmpty')}</span>
        {text && (
          <span className="cf-promptrow__count">
            {t('cf.promptCount').replace('{n}', String(promptLength(value)))}
          </span>
        )}
        <ChevronRight size={14} className="cf-promptrow__chev" />
      </button>
    </div>
  )
}

/** 编辑页：撑满弹窗（弹窗保持进来前的尺寸，见 PersonaEditor），正文框左下字数，底部取消 / 完成（位置同表单）。 */
export function PersonaPromptPage({
  initial,
  onCancel,
  onDone
}: {
  initial: string
  onCancel: () => void
  onDone: (prompt: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [draft, setDraft] = useState(initial)
  return (
    <div className="cf-editor cf-promptpage">
      {/* 字数贴在正文框左下：它是正文的信息，与右侧按钮错开，不像按钮的说明。 */}
      <div className="cf-promptpage__main">
        <textarea
          className="cf-promptpage__text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          aria-label={t('cf.fPrompt')}
        />
        <span className="cf-promptpage__count">{t('cf.promptCount').replace('{n}', String(promptLength(draft)))}</span>
      </div>
      <div className="cf-editor__actions">
        <button type="button" className="cf-btn" onClick={onCancel}>
          {t('cf.cancel')}
        </button>
        <button type="button" className="cf-btn is-primary" onClick={() => onDone(draft)}>
          {t('cf.avaDone')}
        </button>
      </div>
    </div>
  )
}
