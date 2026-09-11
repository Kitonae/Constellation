import React from 'react'

/** A labelled row of one or more fields. */
export default function PropertyRow({ label, children, hint }) {
  return (
    <div>
      {label && <div className="prop-row__label" title={hint}>{label}</div>}
      <div className="prop-row__fields">{children}</div>
    </div>
  )
}

/** A read-only fact about the selection. */
export function InfoRow({ label, value, title }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 68, flex: '0 0 auto' }}>{label}</span>
      <span style={{ color: 'var(--text)', wordBreak: 'break-all' }} title={title || (typeof value === 'string' ? value : undefined)}>
        {value ?? '—'}
      </span>
    </div>
  )
}

/** A text property committed on blur or Enter. */
export function TextInput({ value, onCommit, placeholder, style }) {
  const [draft, setDraft] = React.useState(value ?? '')
  const focused = React.useRef(false)

  React.useEffect(() => { if (!focused.current) setDraft(value ?? '') }, [value])

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      style={{ width: '100%', ...style }}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; if (draft !== value) onCommit(draft) }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') { setDraft(value ?? ''); e.currentTarget.blur() }
      }}
    />
  )
}
