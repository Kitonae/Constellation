import { useEffect } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keep Tab inside a dialog while it is open, and give focus back to whatever
 * opened it on close.
 *
 * Without this a modal is only visually modal: Tab walks straight out into
 * the menu bar behind the scrim, and closing the dialog leaves focus nowhere.
 */
export default function useFocusTrap(ref, open, initialFocusRef) {
  useEffect(() => {
    if (!open || !ref.current) return
    const root = ref.current
    const previous = document.activeElement

    const focusables = () => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)

    const target = initialFocusRef?.current || focusables()[0] || root
    // A frame's delay: the dialog may still be laying out on the first tick.
    const raf = requestAnimationFrame(() => { try { target.focus() } catch { } })

    const onKey = (e) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) { e.preventDefault(); return }
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    root.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      root.removeEventListener('keydown', onKey)
      try { previous?.focus?.() } catch { }
    }
  }, [ref, open, initialFocusRef])
}
