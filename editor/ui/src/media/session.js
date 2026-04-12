// MediaSession — analogous to Microsoft Media Foundation's IMFMediaSession.
//
// The top-level orchestrator that ties together:
//   - PresentationClock (timing)
//   - Transport state machine (idle → playing ⇄ paused → stopped)
//   - Display window broadcasting
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
 * @param {function} [opts.getStore] - returns the zustand store state (for broadcasting)
 * @param {function} [opts.broadcastFn] - (event, payload) => void (for display windows)
 * @param {number}   [opts.uiUpdateInterval=100] - ms between UI time updates
 * @returns {object} MediaSession
 */
export function createMediaSession(opts = {}) {
  const clock = createPresentationClock()
  let _state = 'idle'
  let _topology = null  // current topology (set via setTopology)
  let _lastUiUpdate = 0
  const _subscribers = new Set()
  const _sinks = new Map()  // sinkId → MediaSink
  const _uiInterval = opts.uiUpdateInterval ?? 100

  // Wire sinks to clock events
  const _sinkAdapter = createSinkClockAdapter(_sinks)
  clock.subscribe(_sinkAdapter)

  // Subscribe to clock ticks for broadcasting and UI updates
  clock.subscribe({
    onTick(time) {
      // Throttled UI update
      const now = performance.now()
      if (now - _lastUiUpdate > _uiInterval) {
        _lastUiUpdate = now
        _notifyTimeUpdate(time)
      }

      // Broadcast to display windows
      _broadcastTime(time)
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
      _broadcastSnapshot()
    }
  }

  /**
   * Pause playback.
   */
  function pause() {
    if (_state !== 'playing') return

    if (_transition('paused')) {
      clock.pause()
      _broadcastSnapshot()
    }
  }

  /**
   * Stop playback and reset to time 0.
   */
  function stop() {
    if (_state === 'idle' || _state === 'stopped') return

    if (_transition('stopped')) {
      clock.stop()
      _broadcastSnapshot()
    }
  }

  /**
   * Seek to a specific time. Works in any active state.
   * @param {number} time
   */
  function seek(time) {
    clock.seek(time)
    _notifyTimeUpdate(time)
    // Broadcast snapshot when not playing (paused/stopped) so displays update
    if (_state !== 'playing') {
      _broadcastSnapshot()
    }
  }

  /**
   * Set playback rate.
   * @param {number} rate
   */
  function setRate(rate) {
    clock.setRate(rate)
  }

  // --- Topology management (analogous to MF's SetTopology) ---

  /**
   * Set the active topology. Fires onTopologySet to subscribers.
   * The topology describes the current media pipeline (source → transform → output).
   *
   * @param {Topology|null} topology
   */
  function setTopology(topology) {
    _topology = topology
    _notifyTopologySet(topology)
  }

  /**
   * Get the current topology.
   * @returns {Topology|null}
   */
  function getTopology() {
    return _topology
  }

  // --- Sink management (analogous to MF's AddClockStateSink) ---

  /**
   * Add a media sink. The sink will receive clock state notifications.
   * @param {MediaSink} sink
   */
  function addSink(sink) {
    if (!sink?.id) return
    _sinks.set(sink.id, sink)
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
    _topology = null
    _state = 'idle'
  }

  // --- Broadcasting (analogous to MF sink notifications) ---

  /** Broadcast time update to display windows at ~20fps */
  let _lastBroadcastTime = 0
  function _broadcastTime(time) {
    const now = performance.now()
    if (now - _lastBroadcastTime < 50) return // throttle to ~20fps
    _lastBroadcastTime = now

    if (opts.broadcastFn) {
      try { opts.broadcastFn('display:time', { time }) } catch {}
    }
  }

  /** Broadcast full snapshot (project + scene + time) to displays and sinks */
  function _broadcastSnapshot() {
    const snapshot = _buildSnapshot()
    if (!snapshot) return
    // Display windows via broadcastFn
    if (opts.broadcastFn) {
      try { opts.broadcastFn('display:snapshot', snapshot) } catch {}
    }
    // All registered sinks (native renderer, etc.)
    for (const [, sink] of _sinks) {
      try { sink.onSnapshot?.(snapshot) } catch {}
    }
  }

  function _buildSnapshot(overrides) {
    if (!opts.getStore) return null
    try {
      const s = opts.getStore()
      return {
        project: overrides?.project !== undefined ? overrides.project : s.project,
        scene: overrides?.scene !== undefined ? overrides.scene : s.scene,
        time: clock.getTime(),
      }
    } catch { return null }
  }

  /**
   * Public: broadcast a snapshot to all outputs (display windows + sinks).
   * Call this on topology changes (project/scene updates) that happen outside
   * the normal play/pause/stop/seek flow.
   * @param {object} [overrides] - optional { project, scene } overrides
   */
  function broadcastSnapshot(overrides) {
    const snapshot = _buildSnapshot(overrides)
    if (!snapshot) return
    if (opts.broadcastFn) {
      try { opts.broadcastFn('display:snapshot', snapshot) } catch {}
    }
    for (const [, sink] of _sinks) {
      try { sink.onSnapshot?.(snapshot) } catch {}
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

  function _notifyTopologySet(topology) {
    for (const sub of _subscribers) {
      try { sub.onTopologySet?.(topology) } catch (e) {
        console.error('[MediaSession] topology set handler error:', e)
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

    // Topology
    setTopology,
    getTopology,

    // Sinks
    addSink,
    removeSink,
    getSinks,

    // Broadcasting
    broadcastSnapshot,

    // Subscription
    subscribe,

    // Lifecycle
    dispose,
  }
}
