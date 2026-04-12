import { useEffect } from 'react'
import { useEditorStore } from '../store.js'

export function useHotkeys() {
  const toggleConsole = useEditorStore((s) => s.toggleConsole)

  useEffect(() => {
    const onKey = (e) => {
      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useEditorStore.getState().undo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        useEditorStore.getState().redo()
      }
      // Toggle console on backquote/tilde key
      if (e.code === 'Backquote') {
        const t = e.target
        const tag = (t?.tagName || '').toLowerCase()
        const isEditable = t?.isContentEditable || tag === 'input' || tag === 'textarea'
        if (isEditable) return
        e.preventDefault()
        toggleConsole()
      }
      // Delete selected timeline clip with Delete key
      if (e.key === 'Delete') {
        const t = e.target
        const tag = (t?.tagName || '').toLowerCase()
        const isEditable = t?.isContentEditable || tag === 'input' || tag === 'textarea'
        if (isEditable) return
        const { selectedClipId, removeClip } = useEditorStore.getState()
        if (selectedClipId) {
          e.preventDefault()
          removeClip(selectedClipId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleConsole])
}
