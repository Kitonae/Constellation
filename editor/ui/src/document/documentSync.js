// Document sync — the editor's half of document ownership.
//
// The editor still performs the edits, because routing a drag through IPC
// would be far slower than a local store write. It no longer decides what a
// document is, where it lives, or whether it has unsaved work: it sends the
// document to the shell after each change and reads that state back.
//
// What this replaces: a Save that was a browser blob download, so the
// application never learned a path and could not overwrite; and a dirty flag
// that compared two React object references, which the shell could not see
// and which had no idea what was actually on disk.

import { Events } from '@wailsio/runtime'
import {
  UpdateShow,
  NewShow,
  OpenShow,
  OpenShowPath,
  SaveShow,
  SaveShowAs,
  GetDocumentState,
  GetDocumentContents,
  GetRecentShows,
} from '@bindings/app.js'
import { isWails } from '../wails/env.js'

/** The event the shell emits whenever the open document changes. */
export const DOCUMENT_STATE_EVENT = 'document:state'

/**
 * How long to wait before sending an edited document to the shell.
 *
 * A burst of Inspector keystrokes should cost one serialization, not one per
 * character. Anything that needs the answer now calls flush() instead.
 */
const UPDATE_DEBOUNCE_MS = 50

/**
 * Unwrap a Wails event payload; a struct may arrive bare or wrapped in an
 * array depending on the runtime version.
 */
export function documentFromEvent(e) {
  const data = e?.data
  if (Array.isArray(data)) return data[0] ?? null
  return data ?? null
}

/**
 * Create the document sync.
 *
 * @param {object} opts
 * @param {function} opts.serialize - () => string, the document as canonical JSON
 * @param {function} opts.onState   - (DocumentState) => void
 * @param {function} [opts.onError] - (string) => void
 * @param {boolean}  [opts.native]  - force the shell path on or off, for tests
 * @param {object}   [opts.api]     - the document bindings, for tests
 */
export function createDocumentSync(opts) {
  const { serialize, onState, onError } = opts
  const native = opts.native ?? isWails()
  const api = opts.api ?? {
    update: UpdateShow,
    newShow: NewShow,
    open: OpenShow,
    openPath: OpenShowPath,
    save: SaveShow,
    saveAs: SaveShowAs,
    state: GetDocumentState,
    contents: GetDocumentContents,
    recent: GetRecentShows,
  }

  let _timer = null
  let _disposed = false
  let _unsubscribe = null
  // The last content actually sent. Comparing here as well as in the shell
  // keeps a debounced no-op from crossing the bridge at all.
  let _sent = null
  let _inFlight = null

  if (native) {
    try {
      _unsubscribe = Events.On(DOCUMENT_STATE_EVENT, (e) => {
        if (_disposed) return
        const state = documentFromEvent(e)
        if (state) onState?.(state)
      })
    } catch (err) {
      console.warn('[document] cannot follow the shell:', err)
    }
  }

  function _cancelTimer() {
    if (_timer) {
      clearTimeout(_timer)
      _timer = null
    }
  }

  /** Send the document now. Resolves with the state the shell reports. */
  function _send() {
    _cancelTimer()
    if (!native || _disposed) return Promise.resolve(null)
    let contents
    try {
      contents = serialize()
    } catch (err) {
      onError?.(`Could not serialize the show: ${err}`)
      return Promise.resolve(null)
    }
    if (!contents || contents === _sent) return _inFlight ?? Promise.resolve(null)
    _sent = contents
    _inFlight = Promise.resolve(api.update(contents))
      .then((state) => {
        if (state) onState?.(state)
        return state
      })
      .catch((err) => {
        // A rejected document means the editor's serialization and the
        // shell's contract have diverged. Silence would turn the next Save
        // into a no-op that writes the last document that happened to parse.
        _sent = null
        onError?.(`The shell rejected the document: ${err}`)
        return null
      })
    return _inFlight
  }

  return {
    native,

    /** Note that the document changed; the send is debounced. */
    schedule() {
      if (!native || _disposed) return
      _cancelTimer()
      _timer = setTimeout(() => { _send() }, UPDATE_DEBOUNCE_MS)
    },

    /**
     * Send any pending change and resolve with the shell's document state.
     *
     * Anything that asks "are there unsaved changes?" must go through this
     * first. The answer is debounced, so a Quit pressed straight after an
     * edit would otherwise read a state from before that edit.
     */
    flush() {
      if (!native || _disposed) return Promise.resolve(null)
      return _send().then((state) => state ?? api.state())
    },

    /** Forget what was last sent, so the next change is always sent. */
    invalidate() {
      _sent = null
    },

    newShow: () => Promise.resolve(api.newShow()),
    open: () => Promise.resolve(api.open()),
    openPath: (path) => Promise.resolve(api.openPath(path)),
    save: () => Promise.resolve(api.save()),
    saveAs: () => Promise.resolve(api.saveAs()),
    state: () => Promise.resolve(api.state()),
    contents: () => Promise.resolve(api.contents()),
    recent: () => Promise.resolve(api.recent()),

    dispose() {
      _disposed = true
      _cancelTimer()
      try { _unsubscribe?.() } catch { }
      _unsubscribe = null
    },
  }
}
