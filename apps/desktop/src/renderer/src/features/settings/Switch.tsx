/** 通用开关（受控）。 */
export function Switch({
  checked,
  onChange,
  title
}: {
  checked: boolean
  onChange: (next: boolean) => void
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  )
}
