// Undo/Redo system for zustand store.
//
// Captures snapshots of project + scene state on every mutation.
// Each entry has a label describing the action for the history panel.
// Ctrl+Z undoes, Ctrl+Y / Ctrl+Shift+Z redoes.

const MAX_HISTORY = 100

// Keys to track in undo snapshots (only the "document" state, not UI state)
const TRACKED_KEYS = ['project', 'scene']

function cloneTracked(state) {
  const snap = {}
  for (const k of TRACKED_KEYS) {
    snap[k] = state[k] // shallow ref is fine — we use immutable updates
  }
  return snap
}

function snapshotsEqual(a, b) {
  for (const k of TRACKED_KEYS) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/**
 * Undo/redo restores the document (project + scene) but selection is UI state
 * and is not part of a snapshot. After a restore the selected clip or node may
 * no longer exist, leaving the Inspector pointed at a ghost, so drop any
 * selection the restored document does not contain.
 */
function pruneSelection(state) {
  const clipIds = new Set()
  for (const t of state.project?.timeline?.tracks ?? []) {
    const list = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
    for (const m of list) if (m?.id) clipIds.add(m.id)
  }
  const nodeIds = new Set()
  const stack = [...(state.scene?.roots ?? [])]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.id) nodeIds.add(n.id)
    if (n.children?.length) stack.push(...n.children)
  }
  const selectedClipIds = (state.selectedClipIds ?? []).filter((id) => clipIds.has(id))
  return {
    selectedId: nodeIds.has(state.selectedId) ? state.selectedId : null,
    selectedClipId: clipIds.has(state.selectedClipId) ? state.selectedClipId : null,
    selectedClipIds,
  }
}

export function createUndoStore(set, get, api) {
  return {
    // Undo stack
    _undoStack: [],     // Array<{ label, state }>
    _redoStack: [],     // Array<{ label, state }>
    _undoLabel: null,    // label for the next push (set by actions before mutating)
    _currentLabel: 'Initial State',  // label of the action that produced the current state

    // Set a label for the next state change (called by actions)
    _setUndoLabel: (label) => set({ _undoLabel: label }),

    // Push current state onto undo stack (called after mutations)
    _pushUndo: (label) => {
      const s = get()
      const snap = cloneTracked(s)
      const stack = [...s._undoStack, { label: label || 'Change', state: snap }]
      if (stack.length > MAX_HISTORY) stack.shift()
      set({ _undoStack: stack, _redoStack: [] })
    },

    undo: () => {
      const skip = api?._skipUndo || ((fn) => fn())
      skip(() => {
        const s = get()
        if (s._undoStack.length === 0) return
        const stack = [...s._undoStack]
        const entry = stack.pop()
        const currentSnap = cloneTracked(s)
        // Push current state to redo with the label that created it
        const redoStack = [...s._redoStack, { label: s._currentLabel, state: currentSnap }]
        set({ ...entry.state, ...pruneSelection({ ...s, ...entry.state }), _undoStack: stack, _redoStack: redoStack, _currentLabel: entry.label })
      })
    },

    redo: () => {
      const skip = api?._skipUndo || ((fn) => fn())
      skip(() => {
        const s = get()
        if (s._redoStack.length === 0) return
        const redoStack = [...s._redoStack]
        const entry = redoStack.pop()
        const currentSnap = cloneTracked(s)
        // Push current state to undo with the label that created it
        const undoStack = [...s._undoStack, { label: s._currentLabel, state: currentSnap }]
        set({ ...entry.state, ...pruneSelection({ ...s, ...entry.state }), _undoStack: undoStack, _redoStack: redoStack, _currentLabel: entry.label })
      })
    },

    canUndo: () => get()._undoStack.length > 0,
    canRedo: () => get()._redoStack.length > 0,

    undoStackSize: () => get()._undoStack.length,
    redoStackSize: () => get()._redoStack.length,

    // Get history for display (most recent first)
    getHistory: () => {
      const s = get()
      const undo = s._undoStack.map((e, i) => ({ label: e.label, index: i, type: 'undo' })).reverse()
      const redo = s._redoStack.map((e, i) => ({ label: e.label, index: i, type: 'redo' })).reverse()
      return { undo, redo, currentLabel: 'Current State' }
    },

    // Jump to a specific point in the undo stack
    undoTo: (targetIndex) => {
      const skip = api?._skipUndo || ((fn) => fn())
      skip(() => {
        const s = get()
        let undoStack = [...s._undoStack]
        let redoStack = [...s._redoStack]
        let current = cloneTracked(s)
        let currentLabel = s._currentLabel

        while (undoStack.length > targetIndex + 1) {
          const entry = undoStack.pop()
          redoStack.push({ label: currentLabel, state: current })
          current = entry.state
          currentLabel = entry.label
        }
        if (undoStack.length > targetIndex) {
          const entry = undoStack.pop()
          redoStack.push({ label: currentLabel, state: current })
          current = entry.state
          currentLabel = entry.label
        }

        set({ ...current, ...pruneSelection({ ...s, ...current }), _undoStack: undoStack, _redoStack: redoStack, _currentLabel: currentLabel })
      })
    },
  }
}

// Middleware: wraps set() to auto-push undo on tracked key changes
export function withUndo(config) {
  return (originalSet, get, api) => {
    let _skipUndo = false

    const trackedSet = (partial, replace) => {
      if (_skipUndo) {
        originalSet(partial, replace)
        return
      }

      const prev = get()
      originalSet(partial, replace)
      const next = get()

      // Check if any tracked keys changed
      if (!snapshotsEqual(prev, next)) {
        const label = next._undoLabel || 'Edit'
        const snap = cloneTracked(prev)
        const stack = [...(next._undoStack || []), { label, state: snap }]
        if (stack.length > MAX_HISTORY) stack.shift()
        originalSet({ _undoStack: stack, _redoStack: [], _undoLabel: null, _currentLabel: label })
      }
    }

    // Expose skip flag for undo/redo to bypass the middleware
    api._skipUndo = (fn) => {
      _skipUndo = true
      try { fn() } finally { _skipUndo = false }
    }

    return config(trackedSet, get, api)
  }
}
