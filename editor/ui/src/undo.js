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
 * and is not part of a snapshot. After a restore the selected clip, node or
 * media asset may no longer exist, leaving the Inspector pointed at a ghost,
 * so drop any selection the restored document does not contain.
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
  const mediaIds = new Set((state.project?.media ?? []).map((m) => m?.id).filter(Boolean))
  const selectedClipIds = (state.selectedClipIds ?? []).filter((id) => clipIds.has(id))
  return {
    selectedId: nodeIds.has(state.selectedId) ? state.selectedId : null,
    selectedClipId: clipIds.has(state.selectedClipId) ? state.selectedClipId : null,
    selectedClipIds,
    selectedMediaId: mediaIds.has(state.selectedMediaId) ? state.selectedMediaId : null,
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

    /**
     * Coalesce a gesture into one history entry.
     *
     * A drag-to-scrub field or a stage drag writes on every pointermove, and
     * each write would otherwise be its own undo step. Between begin and end
     * the middleware passes writes through untracked; `endUndoBatch` pushes a
     * single entry, and `{ cancel: true }` (Escape) puts the document back.
     */
    beginUndoBatch: (label) => { api._beginBatch?.(label) },
    endUndoBatch: (opts) => { api._endBatch?.(opts) },

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

    /**
     * Jump forward to a specific point in the redo stack.
     *
     * The mirror of `undoTo`. The History panel used to reach a future state
     * by calling `redo()` N times, which meant N store commits and N renders
     * for one click.
     */
    redoTo: (targetIndex) => {
      const skip = api?._skipUndo || ((fn) => fn())
      skip(() => {
        const s = get()
        let undoStack = [...s._undoStack]
        let redoStack = [...s._redoStack]
        let current = cloneTracked(s)
        let currentLabel = s._currentLabel

        // Redo entries are stored oldest-first, so stepping to `targetIndex`
        // means popping everything down to and including it.
        while (redoStack.length > targetIndex) {
          const entry = redoStack.pop()
          undoStack.push({ label: currentLabel, state: current })
          current = entry.state
          currentLabel = entry.label
        }
        if (undoStack.length > MAX_HISTORY) undoStack = undoStack.slice(undoStack.length - MAX_HISTORY)

        set({ ...current, ...pruneSelection({ ...s, ...current }), _undoStack: undoStack, _redoStack: redoStack, _currentLabel: currentLabel })
      })
    },
  }
}

// Middleware: wraps set() to auto-push undo on tracked key changes
export function withUndo(config) {
  return (originalSet, get, api) => {
    let _skipUndo = false
    let _batch = null // { label, snapshot }

    const pushEntry = (label, snapshot, next) => {
      const stack = [...(next._undoStack || []), { label, state: snapshot }]
      if (stack.length > MAX_HISTORY) stack.shift()
      originalSet({ _undoStack: stack, _redoStack: [], _undoLabel: null, _currentLabel: label })
    }

    const trackedSet = (partial, replace) => {
      if (_skipUndo) {
        originalSet(partial, replace)
        return
      }

      // Inside a batch every write lands on the document but none of them
      // push history; the single entry is created by _endBatch.
      if (_batch) {
        const prevLabel = get()._undoLabel
        originalSet(partial, replace)
        // A label the caller gave to beginUndoBatch describes the whole
        // gesture ("Scrub Opacity") and outranks the per-write label each
        // individual action sets. Only borrow the inner one when the batch
        // was opened without a name.
        if (!_batch.named) {
          const after = get()
          if (after._undoLabel && after._undoLabel !== prevLabel) _batch.label = after._undoLabel
        }
        return
      }

      const prev = get()
      originalSet(partial, replace)
      const next = get()

      // Check if any tracked keys changed
      if (!snapshotsEqual(prev, next)) {
        pushEntry(next._undoLabel || 'Edit', cloneTracked(prev), next)
      }
    }

    // Expose skip flag for undo/redo to bypass the middleware
    api._skipUndo = (fn) => {
      _skipUndo = true
      try { fn() } finally { _skipUndo = false }
    }

    api._beginBatch = (label) => {
      if (_batch) return // already batching; the outermost gesture owns it
      _batch = { label: label || 'Edit', named: !!label, snapshot: cloneTracked(get()) }
    }

    api._endBatch = ({ cancel = false } = {}) => {
      const batch = _batch
      _batch = null
      if (!batch) return
      if (cancel) {
        originalSet({ ...batch.snapshot, _undoLabel: null })
        return
      }
      const next = get()
      if (snapshotsEqual(batch.snapshot, next)) return // nothing actually moved
      pushEntry(batch.label, batch.snapshot, next)
    }

    return config(trackedSet, get, api)
  }
}
