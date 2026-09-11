// MediaSession — analogous to Microsoft Media Foundation's IMFMediaSession.
//
// The top-level orchestrator that ties together:
//   - PresentationClock (timing)
//   - Transport state machine (idle → playing ⇄ paused → stopped)
//   - Sink fan-out (display windows, native renderer)
//   - Store synchronization
//   - Preroll management (future)
//
// Replaces the scattered transport logic in store.js, GlobalTicker.jsx,
// App.jsx effects, and Timeline.jsx seek handlers.

import { createPresentationClock } from './clock.js'
import { createSinkClockAdapter } from './sink.js'

/**
 * Transport states — analogous to MF's session states:
 *   idle       → Ready (no presentation loaded)
 *   loading    → OpenPending (preparing media)
 *   playing    → Started
 *   paused     → Paused
 *   stopped    → Stopped
 *   error      → (MF handles via events)
 *
 * @typedef {'idle'|'loading'|'playing'|'paused'|'stopped'|'error'} TransportState
 */

/**
 * @typedef {object} SessionSubscriber
 * @property {function(TransportState, TransportState): void} [onStateChange] - (newState, oldState)
 * @property {function(number): void} [onTimeUpdate]  - throttled time update for UI
 * @property {function(string): void} [onError]       - error message
 */

// Valid state transitions (from → Set<to>)
const VALID_TRANSITIONS = {
  idle:    new Set(['loading', 'playing', 'paused', 'stopped']),
  loading: new Set(['playing', 'paused', 'stopped', 'error', 'idle']),
  playing: new Set(['paused', 'stopped', 'error']),
  paused:  new Set(['playing', 'stopped', 'error']),
  stopped: new Set(['playing', 'loading', 'idle']),
  error:   new Set(['idle', 'stopped']),
}

/**
 * Create a MediaSession instance.
 *
 * @param {object} [opts]
 * @param {function} [opts.getSnapshot] - () => ({ project, scene, time, playing }) for sinks
 * @param {number}   [opts.uiUpdateInterval=100] - ms between UI time updates
 * @returns {object} MediaSession
 */
export function createMediaSession(opts = {}) {
  const clock = createPresentationClock()
  let _state = 'idle'
  let _lastUiUpdate = 0
  const _subscribers = new Set()
  const _sinks = new Map()  // sinkId → MediaSink
  const _uiInterval = opts.uiUpdateInterval ?? 100

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

  // --- State Machine ---

  function _transition(newState) {
    if (newState === _state) return false
    const allowed = VALID_TRANSITIONS[_state]
    if (!allowed || !allowed.has(newState)) {
      console.warn(`[MediaSession] Invalid transition: ${_state} → ${newState}`)
      return false
    }
    const old = _state
    _state = newState
    _notifyStateChange(newState, old)
    return true
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

    if (_transition('playing')) {
      clock.play()
    }
  }

  /**
   * Pause playback.
   */
  function pause() {
    if (_state !== 'playing') return

    if (_transition('paused')) {
      clock.pause()
    }
  }

  /**
   * Stop playback and reset to time 0.
   */
  function stop() {
    if (_state === 'idle' || _state === 'stopped') return

    if (_transition('stopped')) {
      clock.stop()
    }
  }

  /**
   * Seek to a specific time. Works in any active state.
   * @param {number} time
   */
  function seek(time) {
    clock.seek(time)
    _notifyTimeUpdate(time)
    // The clock's onSeek reaches every sink through the adapter, so paused
    // scrubbing needs nothing extra here.
  }

  /**
   * Set playback rate.
   * @param {number} rate
   */
  function setRate(rate) {
    clock.setRate(rate)
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
