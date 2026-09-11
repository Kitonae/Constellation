import React, { useEffect, useState } from 'react'
import { useEditorStore } from '../store.js'
import { selectSelectionSummary, selectDirty, selectOutputSummary } from '../selectors.js'
import { accelFor, hintsFor, labelFor } from '../shortcuts.js'

const LEVEL_ICON = { info: 'info', warn: 'warning', error: 'error' }
const STALE_AFTER_MS = 10000

/**
 * The bottom strip.
 *
 * Everything here was previously invisible: "Show saved as X", save failures
 * and invalid-JSON errors were written to state that nothing rendered, a
 * display window blocked by the popup blocker failed silently, and the only
 * hint that a shortcut existed was finding it by accident.
 */
export default function StatusBar() {
  const status = useEditorStore((s) => s.statusMessage)
  const documentName = useEditorStore((s) => s.documentName)
  const dirty = useEditorStore(selectDirty)
  const selectionKind = useEditorStore((s) => selectSelectionSummary(s).kind)
  const selectionLabel = useEditorStore((s) => selectSelectionSummary(s).label)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const { total, open, bad } = useEditorStore(selectOutputSummary)

  // A message fades back rather than disappearing, so the last thing that
  // happened stays readable without competing with the live state.
  const [stale, setStale] = useState(false)
  useEffect(() => {
    if (!status) return
    setStale(false)
    const id = setTimeout(() => setStale(true), STALE_AFTER_MS)
    return () => clearTimeout(id)
  }, [status])

  const hints = hintsFor(selectionKind)

  return (
    <div className="statusbar">
      <div className={`statusbar__item statusbar__message${stale ? ' is-stale' : ''}${status?.level === 'error' ? ' statusbar__item--error' : status?.level === 'warn' ? ' statusbar__item--warn' : ''}`}>
        {status && <span className="ms" aria-hidden="true">{LEVEL_ICON[status.level] || 'info'}</span>}
        <span title={status?.text || ''}>{status?.text || 'Ready'}</span>
      </div>

      <div className="statusbar__item" title="Current selection">
        <span className="ms" aria-hidden="true">
          {selectionKind === 'node' ? 'desktop_windows' : selectionKind === 'clips' ? 'movie' : selectionKind === 'media' ? 'folder' : 'highlight_alt'}
        </span>
        <span>{selectionLabel}</span>
      </div>

      <div className="statusbar__item" title={dirty ? 'Unsaved changes' : 'No unsaved changes'}>
        <span className="ms" aria-hidden="true">description</span>
        <span>{documentName || 'Untitled'}</span>
        {dirty && <span className="statusbar__dirty" aria-label="Unsaved changes">●</span>}
      </div>

      <button
        type="button"
        className={`statusbar__item statusbar__item--button${bad ? ' statusbar__item--error' : ''}`}
        onClick={() => setViewMode('output')}
        title={bad ? `${bad} output(s) failed to open` : 'Show outputs'}
      >
        <span className="ms" aria-hidden="true">{bad ? 'error' : 'cast'}</span>
        <span>{open}/{total} outputs</span>
      </button>

      <div className="statusbar__hints">
        {hints.map((id) => (
          <span key={id} className="statusbar__item" title={labelFor(id)}>
            <span className="kbd">{accelFor(id)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
