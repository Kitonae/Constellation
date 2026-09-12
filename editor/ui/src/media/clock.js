// PresentationClock — the editor's view of where the show is.
//
// The clock holds an *anchor*: a timeline position and the local timestamp it
// was true at. Every read derives the current position from that anchor
// rather than accumulating per-frame deltas, which has two consequences that
// matter:
//
//   - No drift. Integrating `dt` each frame folded every rounding error and
//     every dropped frame into the playhead, so a long show ran measurably
//     behind its own audio.
//   - It can follow someone else. `adopt()` installs an anchor computed
//     elsewhere, which is how the Go shell's monotonic transport drives this
//     clock instead of the other way around. Under a plain browser, with no
//     shell to follow, the local play/pause/seek calls set the anchor and the
//     clock behaves exactly as it always did.
//
// The requestAnimationFrame loop no longer decides the time; it only decides
// how often subscribers are told about it.

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

/** Monotonic where available; Date.now() keeps tests and old hosts working. */
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now()
}

export function createPresentationClock() {
  let _state = 'idle'       // ClockState
  let _rate = 1.0           // playback rate multiplier
  let _anchorTime = 0       // timeline seconds at the anchor
  let _anchorTs = nowMs()   // local timestamp the anchor was true at
  let _seq = 0              // highest authoritative sequence adopted
  let _rafId = 0
  const _subscribers = new Set()

  // --- Public API ---

  /** The timeline position right now, derived from the anchor. */
  function getTime() {
    if (_state !== 'playing') return _anchorTime
    return _anchorTime + ((nowMs() - _anchorTs) / 1000) * _rate
  }

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

  /** Start or resume playback. */
  function play() {
    if (_state === 'playing') return
    _reanchor(_anchorTime)
    _state = 'playing'
    _startLoop()
    _notify('onStart', _anchorTime)
  }

  /** Pause playback. Time is preserved. */
  function pause() {
    if (_state !== 'playing') return
    // Read the position before clearing the state: getTime() returns the bare
    // anchor once the clock is not playing, so pausing after the flag flipped
    // would rewind the show to wherever it last started.
    _reanchor(getTime())
    _state = 'paused'
    _stopLoop()
    _notify('onPause')
  }

  /** Stop playback. Time resets to 0. */
  function stop() {
    _reanchor(0)
    _state = 'stopped'
    _stopLoop()
    _notify('onStop')
  }

  /**
   * Seek to a specific time. Works in any state and keeps the run state.
   * @param {number} t - time in seconds
   */
  function seek(t) {
    _reanchor(t)
    _notify('onSeek', _anchorTime)
    // A paused scrub produces no frames of its own, so subscribers that only
    // listen for ticks would never see the move.
    if (_state !== 'playing') _notifyTick()
  }

  /**
   * Set playback rate.
   * @param {number} rate - e.g. 0.5, 1.0, 2.0
   */
  function setRate(rate) {
    const next = Number(rate)
    if (!Number.isFinite(next) || next < 0) return
    _reanchor(getTime())
    _rate = next
  }

  /**
   * Adopt an authoritative transport state from outside this process.
   *
   * This is what the Go shell's transport pushes in. The sequence number
   * rejects a correction that arrived after a newer one overtook it, which
   * can happen because corrections are latest-wins on the wire.
   *
   * @param {{playing?: boolean, time?: number, rate?: number, seq?: number}} next
   * @returns {boolean} whether the state was applied
   */
  function adopt(next) {
    if (!next) return false
    const seq = Number(next.seq)
    if (Number.isFinite(seq) && seq > 0) {
      if (seq < _seq) return false
      _seq = seq
    }

    const rate = Number(next.rate)
    if (Number.isFinite(rate) && rate > 0) _rate = rate

    const time = Number(next.time)
    _reanchor(Number.isFinite(time) ? time : _anchorTime)

    const wasPlaying = _state === 'playing'
    const playing = !!next.playing
    _state = playing ? 'playing' : (_anchorTime === 0 ? 'stopped' : 'paused')

    if (playing && !wasPlaying) {
      _startLoop()
      _notify('onStart', _anchorTime)
    } else if (!playing && wasPlaying) {
      _stopLoop()
      _notify(_state === 'stopped' ? 'onStop' : 'onPause')
    } else if (!playing) {
      // A correction while already paused is someone else scrubbing.
      _notify('onSeek', _anchorTime)
      _notifyTick()
    }
    return true
  }

  /** Dispose of the clock and stop all activity. */
  function dispose() {
    _stopLoop()
    _subscribers.clear()
    _state = 'idle'
  }

  // --- Internal ---

  function _reanchor(t) {
    const next = Number(t)
    _anchorTime = Number.isFinite(next) && next > 0 ? next : 0
    _anchorTs = nowMs()
  }

  function _startLoop() {
    if (_rafId || typeof requestAnimationFrame !== 'function') return
    const loop = () => {
      if (_state !== 'playing') { _rafId = 0; return }
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
    const t = getTime()
    for (const sub of _subscribers) {
      try { sub.onTick?.(t) } catch (e) { console.error('Clock tick error:', e) }
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
    adopt,
    dispose,
  }
}
