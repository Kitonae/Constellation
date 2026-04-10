// PresentationClock — analogous to Microsoft Media Foundation's IMFPresentationClock.
//
// A standalone timing object that sinks subscribe to. Decoupled from zustand
// and React rendering. Uses requestAnimationFrame internally but exposes a
// clean subscribe/getTime interface.
//
// Key MF design principles implemented here:
//   - Shared clock: all sinks (Viewport2D, DisplayWindow) read from the same clock
//   - State notifications: subscribers receive onStart/onPause/onStop/onSeek
//   - Independent of rendering: the clock ticks even if no sink is listening

/**
 * @typedef {'idle'|'playing'|'paused'|'stopped'} ClockState
 */

/**
 * @typedef {object} ClockSubscriber
 * @property {function(number): void} [onTick]    - called each frame with current time
 * @property {function(number): void} [onStart]   - clock started/resumed
 * @property {function(): void}       [onPause]   - clock paused
 * @property {function(): void}       [onStop]    - clock stopped (time reset to 0)
 * @property {function(number): void} [onSeek]    - clock seeked to time
 */

export function createPresentationClock() {
  let _state = 'idle'       // ClockState
  let _time = 0             // current presentation time (seconds)
  let _rate = 1.0           // playback rate multiplier
  let _rafId = 0
  let _lastFrameTs = 0      // performance.now() of last frame
  const _subscribers = new Set()

  // --- Public API ---

  function getTime() { return _time }
  function getState() { return _state }
  function getRate() { return _rate }

  /**
   * Subscribe to clock events. Returns an unsubscribe function.
   * @param {ClockSubscriber} subscriber
   * @returns {function} unsubscribe
   */
  function subscribe(subscriber) {
    _subscribers.add(subscriber)
    return () => _subscribers.delete(subscriber)
  }

  /**
   * Start or resume playback.
   */
  function play() {
    if (_state === 'playing') return
    _state = 'playing'
    _lastFrameTs = performance.now()
    _startLoop()
    _notify('onStart', _time)
  }

  /**
   * Pause playback. Time is preserved.
   */
  function pause() {
    if (_state !== 'playing') return
    _state = 'paused'
    _stopLoop()
    _notify('onPause')
  }

  /**
   * Stop playback. Time resets to 0.
   */
  function stop() {
    const wasPlaying = _state === 'playing'
    _state = 'stopped'
    _time = 0
    if (wasPlaying) _stopLoop()
    _notify('onStop')
  }

  /**
   * Seek to a specific time. Works in any state.
   * @param {number} t - time in seconds
   */
  function seek(t) {
    _time = Math.max(0, t)
    _notify('onSeek', _time)
    // If paused/stopped, still notify tick so UI updates
    if (_state !== 'playing') {
      _notifyTick()
    }
  }

  /**
   * Set playback rate.
   * @param {number} rate - e.g. 0.5, 1.0, 2.0
   */
  function setRate(rate) {
    _rate = Math.max(0, rate)
  }

  /**
   * Dispose of the clock and stop all activity.
   */
  function dispose() {
    _stopLoop()
    _subscribers.clear()
    _state = 'idle'
  }

  // --- Internal ---

  function _startLoop() {
    if (_rafId) return
    const loop = () => {
      if (_state !== 'playing') { _rafId = 0; return }
      const now = performance.now()
      const dt = Math.max(0, (now - _lastFrameTs) / 1000)
      _lastFrameTs = now
      _time += dt * _rate
      _notifyTick()
      _rafId = requestAnimationFrame(loop)
    }
    _rafId = requestAnimationFrame(loop)
  }

  function _stopLoop() {
    if (_rafId) {
      cancelAnimationFrame(_rafId)
      _rafId = 0
    }
  }

  function _notifyTick() {
    for (const sub of _subscribers) {
      try { sub.onTick?.(_time) } catch (e) { console.error('Clock tick error:', e) }
    }
  }

  function _notify(event, ...args) {
    for (const sub of _subscribers) {
      try { sub[event]?.(...args) } catch (e) { console.error(`Clock ${event} error:`, e) }
    }
  }

  return {
    getTime,
    getState,
    getRate,
    subscribe,
    play,
    pause,
    stop,
    seek,
    setRate,
    dispose,
  }
}
