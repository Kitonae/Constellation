import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The app's only context menu.
 *
 * The Media Bin and the 2D stage each grew their own fixed-position div with
 * their own outside-click handling and their own z-index; this is that
 * pattern once, plus Escape and edge clamping so a menu opened near the
 * bottom-right of the window is not half off-screen.
 *
 * `items` is `[{ label, onClick, disabled, danger, separator, icon }]`.
 */
export default function ContextMenu({ open, x, y, items, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => { setPos({ x, y }) }, [x, y])

  // Keep the whole menu on screen.
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const maxX = window.innerWidth - r.width - 6
    const maxY = window.innerHeight - r.height - 6
    const nx = Math.max(6, Math.min(x, maxX))
    const ny = Math.max(6, Math.min(y, maxY))
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
    // `pos` is deliberately absent: this runs once per requested position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, x, y, items])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e) => { if (!ref.current?.contains(e.target)) onClose?.() }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.() }
    }
    // Capture phase: the stage, clips and screens stop pointerdown from
    // bubbling so their drags stay private, which also kept it from ever
    // reaching a bubbling listener here, so clicking the stage never closed
    // the menu. Capture runs before any of them can stop it.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={ref}
      role="menu"
      className="menu context-menu"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {(items || []).map((it, i) => {
        if (!it) return null
        if (it.separator) return <div key={`sep-${i}`} className="menu__separator" />
        return (
          <button
            key={it.key || it.label || i}
            type="button"
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={`menu__item${it.danger ? ' menu__item--danger' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (it.disabled) return
              onClose?.()
              it.onClick?.()
            }}
          >
            {it.icon && <span className="ms menu__check" aria-hidden="true">{it.icon}</span>}
            <span className="menu__label">{it.label}</span>
            {it.accel && <span className="menu__accel">{it.accel}</span>}
          </button>
        )
      })}
    </div>
  )
}
