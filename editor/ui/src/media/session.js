// MediaSession — the editor's transport surface.
//
// It ties together:
//   - PresentationClock (where the show is)
//   - the transport bridge (who decides where the show is)
//   - Sink fan-out (web display windows)
//   - Store synchronization
//
// Replaces the scattered transport logic in store.js, GlobalTicker.jsx,
// App.jsx effects, and Timeline.jsx seek handlers.
//
// The session no longer *decides* the transport. Commands go to the bridge,
// which under the desktop shell forwards them to Go; the authoritative answer
// comes back through the clock, and the session's own state follows it. That
// ordering is what keeps the editor, the web outputs and the native renderers
// describing the same instant even when one of them is slow.

import { createPresentationClock } from './clock.js'
import { createSinkClockAdapter } from './sink.js'
import { createTransportBridge } from './transportBridge.js'

/**
 * Transport states:
 *   idle       → nothing has happened yet
 *   playing    → running
 *   paused     → held at a position
 *   stopped    → held at zero
 *
 * @typedef {'idle'|'playing'|'paused'|'stopped'} TransportState
 */

/**
 * @typedef {object} SessionSubscriber
 * @property {function(TransportState, TransportState): void} [onStateChange] - (newState, oldState)
 * @property {function(number): void} [onTimeUpdate]  - throttled time update for UI
 * @property {function(string): void} [onError]       - error message
 */

/**
 * Create a MediaSession instance.
 *
 * @param {object} [opts]
 * @param {function} [opts.getSnapshot] - () => ({ project, scene, time, playing }) for sinks
 * @param {number}   [opts.uiUpdateInterval=100] - ms between UI time updates
 * @param {object}   [opts.transport] - a transport bridge, for tests
 * @returns {object} MediaSession
 */
export function createMediaSession(opts = {}) {
  const clock = createPresentationClock()
  let _state = 'idle'
  let _lastUiUpdate = 0
  const _subscribers = new Set()
  const _sinks = new Map()  // sinkId → MediaSink
  const _uiInterval = opts.uiUpdateInterval ?? 100
  const _transport = opts.transport ?? createTransportBridge(clock)

  // Wire sinks to clock events
  const _sinkAdapter = createSinkClockAdapter(_sinks)
  clock.subscribe(_sinkAdapter)

  // Subscribe to clock ticks purely to mirror time into the UI at a low rate.
  // Transport output is the sinks' job — the session never broadcasts directly.
  clock.subscribe({
    onTick(time) {
      const now = performance.now()
      if (now - _lastUiUpdate > _uiInterval) {
        _lastUiUpdate = now
        _notifyTimeUpdate(time)
      }
    },
  })

  // --- State ---
  //
  // Followed from the clock rather than set before commanding it. A state
  // machine that moved first could disagree with the shell: it would refuse a
  // transition the shell had already made, and the editor would show a paused
  // show that was in fact running on stage.
  clock.subscribe({
    onStart() { _setState('playing') },
    onPause() { _setState('paused') },
    onStop() { _setState('stopped') },
  })

  function _setState(newState) {
    if (newState === _state) return
    const old = _state
    _state = newState
    _notifyStateChange(newState, old)
  }

  // --- Public API ---

  function getState() { return _state }
  function getTime() { return clock.getTime() }
  function getRate() { return clock.getRate() }
  function getClock() { return clock }

  /**
   * Subscribe to session events. Returns unsubscribe function.
   * @param {SessionSubscriber} sub
   * @returns {function}
   */
  function subscribe(sub) {
    _subscribers.add(sub)
    return () => _subscribers.delete(sub)
  }

  /**
   * Start or resume playback.
   */
  function play() {
    if (_state === 'playing') return
    _transport.play()
  }

  /**
   * Pause playback.
   */
  function pause() {
    if (_state !== 'playing') return
    _transport.pause()
  }

  /**
   * Stop playback and reset to time 0.
   */
  function stop() {
    if (_state === 'idle' || _state === 'stopped') return
    _transport.stop()
  }

  /**
   * Seek to a specific time. Works in any active state.
   * @param {number} time
   */
  function seek(time) {
    _transport.seek(time)
    _notifyTimeUpdate(clock.getTime())
    // The clock's onSeek reaches every sink through the adapter, so paused
    // scrubbing needs nothing extra here.
  }

  /**
   * Set playback rate.
   * @param {number} rate
   */
  function setRate(rate) {
    _transport.setRate(rate)
  }

  /**
   * Adopt the shell's transport, for a reloaded editor joining a show that is
   * already running rather than presenting a playhead at zero.
   */
  function sync() {
    return _transport.sync()
  }

  // --- Sink management (analogous to MF's AddClockStateSink) ---

  /**
   * Add a media sink. The sink will receive clock state notifications.
   * @param {MediaSink} sink
   */
  function addSink(sink) {
    if (!sink?.id) return
    _sinks.set(sink.id, sink)
    // A newly attached target has no state yet; hand it one immediately
    // instead of waiting for the next transport change.
    if (opts.getSnapshot) {
      try { sink.onSnapshot?.(opts.getSnapshot()) } catch {}
    }
  }

  /**
   * Remove a media sink by ID. Calls dispose() on the sink.
   * @param {string} sinkId
   */
  function removeSink(sinkId) {
    const sink = _sinks.get(sinkId)
    if (sink) {
      try { sink.dispose?.() } catch {}
      _sinks.delete(sinkId)
    }
  }

  /**
   * Get all registered sinks.
   * @returns {MediaSink[]}
   */
  function getSinks() {
    return [..._sinks.values()]
  }

  /**
   * Dispose of the session and all resources.
   */
  function dispose() {
    // Dispose all sinks
    for (const [, sink] of _sinks) {
      try { sink.dispose?.() } catch {}
    }
    _sinks.clear()
    _transport.dispose()
    clock.dispose()
    _subscribers.clear()
    _state = 'idle'
  }

  // --- Snapshot fan-out (analogous to MF sink notifications) ---

  /**
   * Push the current project/scene state to every registered sink.
   *
   * This is the *only* snapshot path in the app. Callers that mutate the
   * document (the editor's project/scene effect) call it through a trailing
   * debounce so a burst of keystrokes coalesces into one serialization.
   */
  function notifySnapshot(snapshot) {
    const snap = snapshot ?? (opts.getSnapshot ? opts.getSnapshot() : null)
    if (!snap) return
    for (const [, sink] of _sinks) {
      try { sink.onSnapshot?.(snap) } catch {}
    }
  }

  // --- Notification helpers ---

  function _notifyStateChange(newState, oldState) {
    for (const sub of _subscribers) {
      try { sub.onStateChange?.(newState, oldState) } catch (e) {
        console.error('[MediaSession] state change handler error:', e)
      }
    }
  }

  function _notifyTimeUpdate(time) {
    for (const sub of _subscribers) {
      try { sub.onTimeUpdate?.(time) } catch (e) {
        console.error('[MediaSession] time update handler error:', e)
      }
    }
  }

  return {
    // State
    getState,
    getTime,
    getRate,
    getClock,

    // Control
    play,
    pause,
    stop,
    seek,
    setRate,
    sync,

    // Sinks
    addSink,
    removeSink,
    getSinks,
    notifySnapshot,

    // Subscription
    subscribe,

    // Lifecycle
    dispose,
  }
}
