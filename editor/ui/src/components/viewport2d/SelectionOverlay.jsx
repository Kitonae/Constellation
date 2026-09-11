import React from 'react'
import { useEditorStore } from '../../store.js'
import { selectSelectionSummary } from '../../selectors.js'

/** The "what is selected" chip in the stage's top-left corner. */
export default function SelectionOverlay() {
  const summary = useEditorStore(selectSelectionSummary)
  if (summary.kind === 'none') return null

  const prefix = summary.kind === 'node' ? 'Node' : summary.kind === 'media' ? 'Media' : ''
  return (
    <div style={{
      position: 'absolute', top: 8, left: 8, zIndex: 'var(--z-hud)', pointerEvents: 'none',
      padding: '2px 6px', fontSize: 12, color: 'var(--text-secondary)',
      background: 'var(--bg-primary-alpha)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    }}>
      {prefix ? `${prefix}: ${summary.label}` : summary.label}
    </div>
  )
}
