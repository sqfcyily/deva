import type { ButtonHTMLAttributes } from 'react'
import { Square } from 'lucide-react'

/** The desktop composer’s mutually exclusive send and stop actions. */
export function ComposerAction({ stop, label, title, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  stop?: boolean
}) {
  return (
    <button type="button" {...button} className={`cf-send${stop ? ' is-stop' : ''}`}
      title={title ?? (stop ? label : undefined)} aria-label={stop ? label : undefined}>
      {stop ? <Square size={14} fill="currentColor" /> : label}
    </button>
  )
}
