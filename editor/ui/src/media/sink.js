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
  let _lastSendTime = 0
  let _disposed = false

  function _post(event, payload) {
    if (_disposed || !targetWindow || targetWindow.closed) return
    try {
      targetWindow.postMessage({ event, payload }, '*')
    } catch {}
  }

  function onClockTick(time) {
    const now = performance.now()
    if (now - _lastSendTime < throttleMs) return
    _lastSendTime = now
    _post('display:time', { time })
  }

  function onClockStart(time) {
    _sendSnapshot()
  }

  function onClockPause() {
    _sendSnapshot()
  }

  function onClockStop() {
    _sendSnapshot()
  }

  function onClockSeek(time) {
    _sendSnapshot()
  }

  function onSnapshot(snapshot) {
    _post('display:snapshot', snapshot)
  }

  function _sendSnapshot() {
    if (opts.getSnapshot) {
      const snap = opts.getSnapshot()
      if (snap) _post('display:snapshot', snap)
    }
  }

  function dispose() {
    _disposed = true
    _post('display:close', {})
  }

  return {
    id,
    type: 'display',
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

  function onClockTick(time) {
    if (_disposed) return
    _pushTime(time)
  }

  function onClockStart(time) {
    _sendSnapshot()
  }

  function onClockPause() {
    _sendSnapshot()
  }

  function onClockStop() {
    _sendSnapshot()
  }

  function onClockSeek(time) {
    _pushTime(time)
    _sendSnapshot()
  }

  function onSnapshot(snapshot) {
    if (_disposed) return
    try {
      _pushSnapshot(JSON.stringify(snapshot))
    } catch {}
  }

  function _sendSnapshot() {
    if (_disposed || !opts.getSnapshot) return
    const snap = opts.getSnapshot()
    if (snap) {
      try { _pushSnapshot(JSON.stringify(snap)) } catch {}
    }
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
