import { useEffect, useRef } from 'react'

/**
 * True when the event target is a text field, so global shortcuts must not
 * swallow the keystroke (frontend audit item 3).
 */
export function isEditableTarget(t) {
  if (!t) return false
  if (t.isContentEditable) return true
  return /^(input|textarea|select)$/i.test(t.tagName || '')
}

/**
 * The single keyboard shortcut layer for the app.
 *
 * `bindings` is an array of `{ match(e) => boolean, run(e), allowInEditable? }`.
 * Bindings are tried in order; the first match wins, gets `preventDefault()`
 * and stops the scan. Anything typed into an input is ignored unless the
 * binding opts in with `allowInEditable`.
 *
 * The array is read through a ref so callers may pass a fresh literal on every
 * render without re-registering the listener.
 */
export function useShortcuts(bindings) {
  const ref = useRef(bindings)
  ref.current = bindings

  useEffect(() => {
    const onKey = (e) => {
      const editable = isEditableTarget(e.target)
      for (const b of ref.current || []) {
        if (!b) continue
        if (editable && !b.allowInEditable) continue
        let matched = false
        try { matched = !!b.match(e) } catch { matched = false }
        if (!matched) continue
        if (b.preventDefault !== false) e.preventDefault()
        b.run(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
