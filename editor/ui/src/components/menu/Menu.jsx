import React, { useCallback, useEffect, useRef } from 'react'

/**
 * Menu bar primitives.
 *
 * The old menus opened on `pointerDown` with the follow-up `click`
 * suppressed, which made them completely unreachable from the keyboard, and
 * their items were plain filled buttons with no accelerator column and no
 * hover feedback. These are real ARIA menus: click or Enter opens, arrows
 * move, Escape closes and hands focus back to the trigger.
 */

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])'

export function MenuItem({ label, accel, icon, checked, disabled, danger, onSelect, role = 'menuitem' }) {
  return (
    <button
      type="button"
      role={role}
      aria-disabled={disabled || undefined}
      aria-checked={role === 'menuitem' ? undefined : !!checked}
      className={`menu__item${danger ? ' menu__item--danger' : ''}`}
      tabIndex={-1}
      onClick={() => { if (!disabled) onSelect?.() }}
    >
      <span className="ms menu__check" aria-hidden="true">
        {checked ? (role === 'menuitemradio' ? 'radio_button_checked' : 'check') : (icon || '')}
      </span>
      <span className="menu__label">{label}</span>
      {accel && <span className="menu__accel">{accel}</span>}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="menu__separator" role="separator" />
}

export function MenuSection({ children }) {
  return <div className="menu__section" role="presentation">{children}</div>
}

/**
 * One top-level menu: a trigger plus its popup.
 *
 * `open`/`setOpen` are lifted so the bar can close the previous menu when
 * another opens, and so hovering across triggers switches menus the way a
 * desktop menu bar does.
 */
export function Menu({ id, title, open, setOpen, children }) {
  const isOpen = open === id
  const triggerRef = useRef(null)
  const popupRef = useRef(null)

  const items = useCallback(
    () => [...(popupRef.current?.querySelectorAll(ITEM_SELECTOR) || [])],
    [],
  )

  const focusItem = useCallback((index) => {
    const list = items()
    if (!list.length) return
    const i = (index + list.length) % list.length
    list[i]?.focus()
  }, [items])

  // Opening with the keyboard should land on the first item.
  useEffect(() => {
    if (!isOpen) return
    const raf = requestAnimationFrame(() => {
      if (popupRef.current && !popupRef.current.contains(document.activeElement)) focusItem(0)
    })
    return () => cancelAnimationFrame(raf)
  }, [isOpen, focusItem])

  const close = (refocus = true) => {
    setOpen(null)
    if (refocus) triggerRef.current?.focus()
  }

  const onTriggerKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(id)
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault()
      close()
    }
  }

  const onPopupKeyDown = (e) => {
    const list = items()
    const current = list.indexOf(document.activeElement)
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusItem(current + 1); break
      case 'ArrowUp': e.preventDefault(); focusItem(current - 1); break
      case 'Home': e.preventDefault(); focusItem(0); break
      case 'End': e.preventDefault(); focusItem(list.length - 1); break
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break
      case 'Tab': close(false); break
      default: break
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="btn menubar__trigger"
        onClick={() => setOpen(isOpen ? null : id)}
        // Sliding along an open menu bar switches menus, as on the desktop.
        onPointerEnter={() => { if (open && !isOpen) setOpen(id) }}
        onKeyDown={onTriggerKeyDown}
      >
        {title}
      </button>
      {isOpen && (
        <div
          ref={popupRef}
          role="menu"
          aria-label={title}
          className="menu"
          onKeyDown={onPopupKeyDown}
          onClick={() => setOpen(null)}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** Close the open menu when a pointer goes down anywhere outside the bar. */
export function useMenuDismiss(wrapRef, open, setOpen) {
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(null) }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [wrapRef, open, setOpen])
}

/** Left/Right across the menu bar while a menu is open. */
export function useMenuBarArrows(wrapRef, open, setOpen, order) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (!wrapRef.current?.contains(document.activeElement)) return
      e.preventDefault()
      const i = order.indexOf(open)
      if (i === -1) return
      const next = e.key === 'ArrowRight' ? (i + 1) % order.length : (i - 1 + order.length) % order.length
      setOpen(order[next])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wrapRef, open, setOpen, order])
}
