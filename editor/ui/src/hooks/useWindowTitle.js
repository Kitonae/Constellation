import { useEffect } from 'react'
import { useEditorStore } from '../store.js'
import { selectDirty } from '../selectors.js'

/**
 * Keeps the window title showing the open document and whether it is dirty.
 *
 * `document.title` alone does nothing for the native frame under Wails, so
 * the runtime call is the one that matters; the DOM title is for plain
 * browser development.
 */
export default function useWindowTitle() {
  const documentName = useEditorStore((s) => s.documentName)
  const dirty = useEditorStore(selectDirty)

  useEffect(() => {
    const title = `Constellation Editor — ${documentName || 'Untitled'}${dirty ? '*' : ''}`
    try { window.runtime?.WindowSetTitle?.(title) } catch { }
    document.title = title
  }, [documentName, dirty])
}
