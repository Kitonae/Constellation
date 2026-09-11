import { useEffect } from 'react'
import { Window } from '@wailsio/runtime'
import { useEditorStore } from '../store.js'
import { selectDirty } from '../selectors.js'
import { isWails } from '../wails/env.js'

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
    try { if (isWails()) Window.SetTitle(title) } catch { }
    document.title = title
  }, [documentName, dirty])
}
