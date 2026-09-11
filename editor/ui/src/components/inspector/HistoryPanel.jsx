import React from 'react'
import { useEditorStore } from '../../store.js'

const HISTORY_ICONS = {
  'Add Screen': 'desktop_windows',
  'Remove Screen': 'delete',
  'Move Screen': 'open_with',
  'Scale Screen': 'aspect_ratio',
  'Rotate Screen': 'rotate_right',
  'Resize Screen': 'aspect_ratio',
  'Enable Screen': 'visibility',
  'Disable Screen': 'visibility_off',
  'Import Media': 'upload_file',
  'Add Track': 'playlist_add',
  'Rename Track': 'edit',
  'Remove Track': 'playlist_remove',
  'Move Clip': 'open_with',
  'Move Clips': 'drag_indicator',
  'Nudge Clip': 'open_with',
  'Trim Clip': 'content_cut',
  'Split Clip': 'call_split',
  'Duplicate Clip': 'content_copy',
  'Resize Clip': 'photo_size_select_large',
  'Change Opacity': 'opacity',
  'Change Fade': 'gradient',
  'Change Blur': 'blur_on',
  'Move Clip on Timeline': 'swap_horiz',
  'Move Clip to Track': 'swap_vert',
  'Resize Clip Duration': 'timelapse',
  'Reorder Clip': 'reorder',
  'Remove Clip from Timeline': 'playlist_remove',
  'Remove Clips': 'delete_sweep',
  'Remove Media': 'delete_sweep',
  'Rename Media': 'edit',
  'Rename Clip': 'edit',
  'Relink Media': 'link',
  'Duplicate Media': 'content_copy',
  'Load Project': 'folder_open',
  'New Project': 'note_add',
  'Initial State': 'flag',
  'Edit Clip': 'edit',
}

function historyIcon(label = '') {
  if (HISTORY_ICONS[label]) return HISTORY_ICONS[label]
  for (const [key, icon] of Object.entries(HISTORY_ICONS)) {
    if (label.startsWith(key)) return icon
  }
  if (label.includes('Add') || label.includes('Import')) return 'add_circle'
  if (label.includes('Remove') || label.includes('Delete')) return 'delete'
  if (label.includes('Rename')) return 'edit'
  if (label.includes('Move') || label.includes('Nudge')) return 'open_with'
  if (label.includes('Resize') || label.includes('Scale')) return 'aspect_ratio'
  if (label.includes('Change')) return 'tune'
  if (label.includes('Screen')) return 'desktop_windows'
  if (label.includes('Model')) return 'view_in_ar'
  if (label.includes('Clips')) return 'drag_indicator'
  return 'edit'
}

/** The undo stack, newest at the bottom, click any row to travel to it. */
export default function HistoryPanel() {
  const undoStack = useEditorStore((s) => s._undoStack)
  const redoStack = useEditorStore((s) => s._redoStack)
  const currentLabel = useEditorStore((s) => s._currentLabel) || 'Initial State'
  const undoTo = useEditorStore((s) => s.undoTo)
  const redoTo = useEditorStore((s) => s.redoTo)

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {/* Undone states, greyed. One click jumps straight to one via redoTo,
          rather than calling redo() N times and rendering N intermediates. */}
      {redoStack.slice().reverse().map((entry, i) => {
        const realIdx = redoStack.length - 1 - i
        return (
          <div key={`redo-${realIdx}`} className="history-row history-row--future" onClick={() => redoTo(realIdx)}>
            <span className="ms" aria-hidden="true">{historyIcon(entry.label)}</span>
            <span>{entry.label}</span>
          </div>
        )
      })}

      <div className="history-row history-row--current">
        <span className="ms" aria-hidden="true" style={{ color: 'var(--accent)' }}>{historyIcon(currentLabel)}</span>
        <span>{currentLabel}</span>
      </div>

      {undoStack.slice().reverse().map((entry, i) => {
        const realIdx = undoStack.length - 1 - i
        return (
          <div key={`undo-${realIdx}`} className="history-row history-row--past" onClick={() => undoTo(realIdx)}>
            <span className="ms" aria-hidden="true">{historyIcon(entry.label)}</span>
            <span>{entry.label}</span>
          </div>
        )
      })}

      {undoStack.length === 0 && redoStack.length === 0 && (
        <div style={{ padding: 16, opacity: 0.5, textAlign: 'center', fontSize: 12 }}>No history yet</div>
      )}
    </div>
  )
}
