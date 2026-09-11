/**
 * The one keyboard-shortcut table.
 *
 * Everything that needs to know about a binding reads it from here: the
 * global key handler, the accelerator text in menus, the Help overlay and the
 * status bar's hints. Adding a shortcut in one place used to mean it existed
 * only as a keystroke, undocumented anywhere in the UI.
 *
 * A `run` is looked up by id in the handler map the app passes to
 * `buildBindings`; entries with `localOnly` are documentation for a binding a
 * component owns itself (the viewports handle their own zoom keys because
 * they need the cursor position).
 */

const mod = (e) => e.ctrlKey || e.metaKey
const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey

export const SHORTCUTS = [
  // --- File ---
  { id: 'newShow', category: 'File', label: 'New Show', keys: 'Ctrl+N', match: (e) => mod(e) && e.key.toLowerCase() === 'n' && !e.shiftKey },
  { id: 'openShow', category: 'File', label: 'Open Show', keys: 'Ctrl+O', match: (e) => mod(e) && e.key.toLowerCase() === 'o' },
  { id: 'saveShow', category: 'File', label: 'Save Show', keys: 'Ctrl+S', match: (e) => mod(e) && e.key.toLowerCase() === 's' },

  // --- Edit ---
  { id: 'undo', category: 'Edit', label: 'Undo', keys: 'Ctrl+Z', match: (e) => mod(e) && e.key.toLowerCase() === 'z' && !e.shiftKey },
  { id: 'redo', category: 'Edit', label: 'Redo', keys: 'Ctrl+Y', match: (e) => mod(e) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) },
  { id: 'delete', category: 'Edit', label: 'Delete selection', keys: 'Del', match: (e) => plain(e) && (e.key === 'Delete' || e.key === 'Backspace') },
  { id: 'selectAllClips', category: 'Edit', label: 'Select all clips', keys: 'Ctrl+A', match: (e) => mod(e) && e.key.toLowerCase() === 'a' },
  { id: 'deselect', category: 'Edit', label: 'Deselect', keys: 'Esc', match: (e) => plain(e) && e.key === 'Escape' },
  { id: 'duplicate', category: 'Edit', label: 'Duplicate clips', keys: 'Ctrl+D', match: (e) => mod(e) && e.key.toLowerCase() === 'd' },
  { id: 'splitClip', category: 'Edit', label: 'Split clip at playhead', keys: 'S', match: (e) => plain(e) && e.key.toLowerCase() === 's' },

  // --- Transport ---
  // Space used to be the 2D viewport's pan modifier; panning is now the hand
  // tool, middle mouse or Ctrl+Alt, and Space plays like every other editor.
  {
    id: 'playPause',
    category: 'Transport',
    label: 'Play / Pause',
    keys: 'Space',
    // A focused button also fires on Space; let the button win.
    match: (e) => e.code === 'Space' && plain(e) && !/^(button|a)$/i.test(e.target?.tagName || '') && !e.target?.closest?.('[role^="menuitem"]'),
  },
  { id: 'goToStart', category: 'Transport', label: 'Go to start', keys: 'Home', match: (e) => plain(e) && e.key === 'Home' },
  { id: 'goToEnd', category: 'Transport', label: 'Go to end', keys: 'End', match: (e) => plain(e) && e.key === 'End' },
  { id: 'stepBack', category: 'Transport', label: 'Step back (Shift: 1s)', keys: ',', match: (e) => !mod(e) && !e.altKey && (e.key === ',' || e.key === '<') },
  { id: 'stepForward', category: 'Transport', label: 'Step forward (Shift: 1s)', keys: '.', match: (e) => !mod(e) && !e.altKey && (e.key === '.' || e.key === '>') },

  // --- Arrange ---
  { id: 'nudgeLeft', category: 'Arrange', label: 'Nudge clips earlier (Shift: 1s)', keys: '←', match: (e) => !mod(e) && !e.altKey && e.key === 'ArrowLeft' },
  { id: 'nudgeRight', category: 'Arrange', label: 'Nudge clips later (Shift: 1s)', keys: '→', match: (e) => !mod(e) && !e.altKey && e.key === 'ArrowRight' },

  // --- Viewport ---
  { id: 'frameAll', category: 'Viewport', label: 'Frame all', keys: 'F', match: (e) => plain(e) && e.key.toLowerCase() === 'f' && !e.shiftKey },
  { id: 'frameSelected', category: 'Viewport', label: 'Frame selected', keys: 'Shift+F', match: (e) => !mod(e) && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'f' },
  { id: 'zoom100', category: 'Viewport', label: 'Zoom to 100%', keys: 'Ctrl+0', match: (e) => mod(e) && (e.key === '0' || e.code === 'Digit0') },
  { id: 'zoomIn', category: 'Viewport', label: 'Zoom in', keys: 'Ctrl++', localOnly: true },
  { id: 'zoomOut', category: 'Viewport', label: 'Zoom out', keys: 'Ctrl+-', localOnly: true },
  { id: 'snapOff', category: 'Viewport', label: 'Hold Alt while dragging to disable snapping', keys: 'Alt', localOnly: true },
  { id: 'pan', category: 'Viewport', label: 'Pan the stage', keys: 'Middle drag', localOnly: true },

  // --- Window ---
  { id: 'toggleConsole', category: 'Window', label: 'Toggle console', keys: '`', match: (e) => e.code === 'Backquote' && !mod(e) },
  { id: 'shortcutsHelp', category: 'Window', label: 'Keyboard shortcuts', keys: '?', match: (e) => (e.key === '?' && !mod(e)) || e.key === 'F1' },
]

const BY_ID = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s]))

/** Accelerator text for a menu row, e.g. `accelFor('undo') === 'Ctrl+Z'`. */
export function accelFor(id) {
  return BY_ID[id]?.keys || ''
}

/** Human label for a binding. */
export function labelFor(id) {
  return BY_ID[id]?.label || id
}

/**
 * Turn the table plus a handler map into the array `useShortcuts` wants.
 *
 * Entries with no handler are skipped, so a component can supply a subset
 * without the key falling through to a stale binding.
 */
export function buildBindings(handlers) {
  const out = []
  for (const s of SHORTCUTS) {
    if (s.localOnly || !s.match) continue
    const run = handlers?.[s.id]
    if (typeof run !== 'function') continue
    out.push({ id: s.id, match: s.match, run, allowInEditable: !!s.allowInEditable })
  }
  return out
}

/** Shortcut ids worth hinting at, given what is selected. */
export function hintsFor(kind) {
  switch (kind) {
    case 'clips': return ['delete', 'duplicate', 'splitClip']
    case 'node': return ['delete', 'frameSelected']
    case 'media': return ['delete']
    default: return ['playPause', 'frameAll', 'shortcutsHelp']
  }
}

/** The table grouped for the Help overlay, in declaration order. */
export function shortcutsByCategory() {
  const groups = new Map()
  for (const s of SHORTCUTS) {
    if (!groups.has(s.category)) groups.set(s.category, [])
    groups.get(s.category).push(s)
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
}
