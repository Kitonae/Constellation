import React, { useId, useRef } from 'react'
import useFocusTrap from '../hooks/useFocusTrap.js'

/**
 * The base for every dialog in the app.
 *
 * Carries the things the hand-rolled overlays were each missing something
 * from: real dialog semantics, a focus trap, Escape, a scrim click, and a
 * keydown barrier so the global shortcut layer never sees a keystroke typed
 * into a dialog field.
 */
export default function Modal({
  open,
  title,
  onClose,
  children,
  actions,
  initialFocusRef,
  closeOnScrim = true,
  width,
  labelledBy,
}) {
  const ref = useRef(null)
  const autoId = useId()
  const titleId = labelledBy || `dlg-${autoId}`
  useFocusTrap(ref, open, initialFocusRef)

  if (!open) return null

  return (
    <div
      className="dialog-scrim"
      onPointerDown={(e) => {
        if (!closeOnScrim) return
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="dialog"
        style={width ? { width } : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Dialog keystrokes must never reach the global shortcut layer.
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
        }}
      >
        {title && <div className="dialog__title" id={titleId}>{title}</div>}
        <div className="dialog__body">{children}</div>
        {actions && <div className="dialog__actions">{actions}</div>}
      </div>
    </div>
  )
}
