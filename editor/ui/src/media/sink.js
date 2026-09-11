// Media Sink — analogous to MF's IMFMediaSink + IMFClockStateSink.
//
// A sink consumes rendered output and presents it to a display target.
// Each sink registers with the PresentationClock via the session and
// receives clock state notifications (start, pause, stop, tick).
//
// Two sink types:
//   DisplaySink  — web child windows via postMessage
//   NativeSink   — DX12 renderer via Wails Go bridge (PushTime/PushSnapshot)

// --- Sink interface ---

/**
 * @typedef {object} MediaSink
 * @property {string} id           - unique sink identifier
 * @property {string} type         - 'display' | 'native'
 * @property {function(number): void} onClockTick    - called each frame with time
 * @property {function(number): void} onClockStart   - playback started at time
 * @property {function(): void}       onClockPause   - playback paused
 * @property {function(): void}       onClockStop    - playback stopped
 * @property {function(number): void} [onClockSeek]  - seeked to time
 * @property {function(object): void} [onSnapshot]   - full project snapshot
 * @property {function(): void}       dispose        - cleanup resources
 */

let _sinkIdCounter = 0

function sinkId(prefix) {
  return `${prefix}-${(++_sinkIdCounter).toString(36)}`
}

// --- Display Sink (web child windows via postMessage) ---

/**
 * Create a display sink for a web child window.
 *
 * Communicates via postMessage to a window opened with window.open().
 * Throttles time updates to ~20fps to avoid saturating the message channel.
 *
 * @param {Window} targetWindow - child window reference
 * @param {object} [opts]
 * @param {string} [opts.id]          - custom sink ID
 * @param {number} [opts.throttleMs]  - min ms between time updates (default 50 = ~20fps)
 * @param {function} [opts.getSnapshot] - () => snapshot payload for full updates
 * @returns {MediaSink}
 */
export function createDisplaySink(targetWindow, opts = {}) {
  const id = opts.id || sinkId('display')
  const throttleMs = opts.throttleMs ?? 50
  const targetOrigin = opts.targetOrigin || '*'
  let _lastSendTime = 0
  let _disposed = false
  // The sink tracks transport state from the clock notifications it already
  // receives, so every payload can carry `playing` without extra plumbing.
  // DisplayWindow needs it to play video instead of scrubbing it.
  let _playing = false
  let _lastTime = 0

  function _post(event, payload) {
    if (_disposed || !targetWindow || targetWindow.closed) return
    try {
      targetWindow.postMessage({ event, payload }, targetOrigin)
    } catch {}
  }

  function onClockTick(time) {
    _lastTime = time
    const now = performance.now()
    if (now - _lastSendTime < throttleMs) return
    _postTime(time)
  }

  // Transport changes move the playhead; they do not change the document.
  // Only `notifySnapshot` sends a snapshot, so a paused scrub costs one small
  // message per move instead of a full project serialization.
  function _postTime(time) {
    if (Number.isFinite(time)) _lastTime = time
    _lastSendTime = performance.now()
    _post('display:time', { time: _lastTime, playing: _playing })
  }

  function onClockStart(time) {
    _playing = true
    _postTime(time)
  }

  function onClockPause() {
    _playing = false
    _postTime(_lastTime)
  }

  function onClockStop() {
    _playing = false
    _postTime(0)
  }

  function onClockSeek(time) {
    _postTime(time)
  }

  function onSnapshot(snapshot) {
    if (!snapshot) return
    _playing = snapshot.playing ?? _playing
    _post('display:snapshot', { ...snapshot, playing: _playing })
  }

  function dispose() {
    _disposed = true
    _post('display:close', { screenId: opts.screenId || '' })
  }

  return {
    id,
    type: 'display',
    screenId: opts.screenId || '',
    targetWindow,
    onClockTick,
    onClockStart,
    onClockPause,
    onClockStop,
    onClockSeek,
    onSnapshot,
    dispose,
  }
}

// --- Native Renderer Sink (DX12 via Wails Go bridge) ---

/**
 * Create a native renderer sink for the DX12 renderer.
 *
 * Communicates via Wails Go bridge functions:
 *   - PushTime(time)      — called each frame (~60fps)
 *   - PushSnapshot(json)  — called on state changes
 *
 * @param {object} [opts]
 * @param {string} [opts.id]            - custom sink ID
 * @param {string} [opts.screenId]      - renderer screen identifier
 * @param {function} [opts.pushTime]    - (time) => void (default: window.go.main.App.PushTime)
 * @param {function} [opts.pushSnapshot] - (json) => void
 * @param {function} [opts.getSnapshot]  - () => snapshot object
 * @returns {MediaSink}
 */
export function createNativeSink(opts = {}) {
  const id = opts.id || sinkId('native')
  let _disposed = false

  const _pushTime = opts.pushTime || ((t) => {
    try { window?.go?.main?.App?.PushTime?.(t) } catch {}
  })

  const _pushSnapshot = opts.pushSnapshot || ((json) => {
    try { window?.go?.main?.App?.PushSnapshot?.(json) } catch {}
  })

  // Go exposes PushControl but nothing used to call it, so the renderer's
  // `m_playing` never left false and it scrubbed audio instead of playing it.
  const _pushControl = opts.pushControl || ((cmd) => {
    try { window?.go?.main?.App?.PushControl?.(cmd) } catch {}
  })

  // The native renderer reads the on-disk project wrapper schema, which is not
  // the same object the display sinks post. `serialize` lets the two differ.
  const _serialize = opts.serialize || ((snap) => JSON.stringify(snap))

  function onClockTick(time) {
    if (_disposed) return
    _pushTime(time)
  }

  function onClockStart(time) {
    if (_disposed) return
    _pushTime(time)
    _pushControl('play')
  }

  function onClockPause() {
    if (_disposed) return
    _pushControl('pause')
  }

  function onClockStop() {
    if (_disposed) return
    _pushControl('stop')
    _pushTime(0)
  }

  function onClockSeek(time) {
    if (_disposed) return
    _pushTime(time)
  }

  function onSnapshot(snapshot) {
    if (_disposed || !snapshot) return
    try {
      const json = _serialize(snapshot)
      if (json) _pushSnapshot(json)
    } catch {}
  }

  function dispose() {
    _disposed = true
  }

  return {
    id,
    type: 'native',
    screenId: opts.screenId || '',
    onClockTick,
    onClockStart,
    onClockPause,
    onClockStop,
    onClockSeek,
    onSnapshot,
    dispose,
  }
}

// --- Sink management helpers ---

/**
 * Create a clock subscriber adapter that dispatches to all registered sinks.
 * Used internally by the session to wire sinks to the clock.
 *
 * @param {Map<string, MediaSink>} sinks - map of sinkId → MediaSink
 * @returns {ClockSubscriber}
 */
export function createSinkClockAdapter(sinks) {
  return {
    onTick(time) {
      for (const [, sink] of sinks) {
        try { sink.onClockTick(time) } catch {}
      }
    },
    onStart(time) {
      for (const [, sink] of sinks) {
        try { sink.onClockStart(time) } catch {}
      }
    },
    onPause() {
      for (const [, sink] of sinks) {
        try { sink.onClockPause() } catch {}
      }
    },
    onStop() {
      for (const [, sink] of sinks) {
        try { sink.onClockStop() } catch {}
      }
    },
    onSeek(time) {
      for (const [, sink] of sinks) {
        try { sink.onClockSeek?.(time) } catch {}
      }
    },
  }
}
