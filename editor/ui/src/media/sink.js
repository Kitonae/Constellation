// Media Sink — analogous to MF's IMFMediaSink + IMFClockStateSink.
//
// A sink consumes rendered output and presents it to a display target. Each
// sink registers with the PresentationClock via the session and receives
// clock state notifications (start, pause, stop, tick).
//
// One sink type remains: DisplaySink, for web output windows reached by
// postMessage. Native renderers are not driven from here any more. They
// receive the document and the transport from the Go shell over the event
// stream, which is both fewer hops and one fewer place where the editor's
// paint rate could become the show's timebase.

// --- Sink interface ---

/**
 * @typedef {object} MediaSink
 * @property {string} id           - unique sink identifier
 * @property {string} type         - 'display'
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
 * The sink posts an *anchor* -- a position, whether it is moving, and the
 * moment that was true -- rather than a position per frame. The output window
 * advances its own playhead from that anchor, so it keeps running at its own
 * refresh rate even while the editor is occluded and painting nothing. The
 * periodic correction exists only to pull a drifting window back.
 *
 * @param {Window} targetWindow - child window reference
 * @param {object} [opts]
 * @param {string} [opts.id]            - custom sink ID
 * @param {number} [opts.correctionMs]  - ms between corrections while playing
 * @param {function} [opts.getSnapshot] - () => snapshot payload for full updates
 * @returns {MediaSink}
 */
export function createDisplaySink(targetWindow, opts = {}) {
  const id = opts.id || sinkId('display')
  const correctionMs = opts.correctionMs ?? 500
  const targetOrigin = opts.targetOrigin || '*'
  let _lastSendTime = 0
  let _disposed = false
  // The sink tracks transport state from the clock notifications it already
  // receives, so every payload can carry `playing` without extra plumbing.
  // DisplayWindow needs it to play video instead of scrubbing it.
  let _playing = false
  let _lastTime = 0
  let _seq = 0

  function _post(event, payload) {
    if (_disposed || !targetWindow || targetWindow.closed) return
    try {
      targetWindow.postMessage({ event, payload }, targetOrigin)
    } catch {}
  }

  function onClockTick(time) {
    _lastTime = time
    // While playing, the window is advancing on its own; a correction every
    // half second is enough to keep it honest. Before this the sink posted
    // twenty messages a second and the window did nothing between them.
    const now = performance.now()
    if (now - _lastSendTime < correctionMs) return
    _postTransport(time)
  }

  // Transport changes move the playhead; they do not change the document.
  // Only `notifySnapshot` sends a snapshot, so a paused scrub costs one small
  // message per move instead of a full project serialization.
  function _postTransport(time) {
    if (Number.isFinite(time)) _lastTime = time
    _lastSendTime = performance.now()
    _seq += 1
    _post('display:transport', { time: _lastTime, playing: _playing, rate: 1, seq: _seq })
  }

  function onClockStart(time) {
    _playing = true
    _postTransport(time)
  }

  function onClockPause() {
    _playing = false
    _postTransport(_lastTime)
  }

  function onClockStop() {
    _playing = false
    _postTransport(0)
  }

  function onClockSeek(time) {
    _postTransport(time)
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
