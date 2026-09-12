// Transport bridge — connects the editor's clock to the shell's transport.
//
// Playback position used to be produced here: a requestAnimationFrame loop
// integrated wall-clock deltas and pushed the result outward to every output.
// That made the editor window's paint rate the show's timebase, so occluding
// or minimising the editor slowed native output with it.
//
// Now the Go shell owns run state and position, derived from a monotonic
// clock, and every consumer follows. This module is the editor's half of that:
// commands go out as calls, authoritative state comes back as events, and the
// local clock is corrected from it.
//
// Under a plain browser there is no shell, so the bridge drives the clock
// directly and the editor behaves as it always did.

import { Events } from '@wailsio/runtime'
import {
  TransportPlay,
  TransportPause,
  TransportStop,
  TransportSeek,
  TransportSetRate,
  GetTransportState,
} from '@bindings/app.js'
import { isWails } from '../wails/env.js'

/** The event the shell emits whenever the transport changes. */
export const TRANSPORT_STATE_EVENT = 'transport:state'

/**
 * Unwrap a Wails event payload.
 *
 * The runtime delivers a single value as `data`, but a slice arrives as an
 * array and some versions wrap a struct in one. Reading both shapes here
 * keeps that detail out of the clock.
 */
export function transportFromEvent(e) {
  const data = e?.data
  if (Array.isArray(data)) return data[0] ?? null
  return data ?? null
}

/**
 * Create the bridge for a clock.
 *
 * @param {object} clock - a PresentationClock
 * @param {object} [opts]
 * @param {boolean} [opts.native] - force the shell path on or off, for tests
 * @param {object}  [opts.api]    - the transport bindings, for tests
 * @returns {{play: function, pause: function, stop: function, seek: function,
 *            setRate: function, sync: function, dispose: function, native: boolean}}
 */
export function createTransportBridge(clock, opts = {}) {
  const native = opts.native ?? isWails()

  if (!native) {
    // No shell to follow: the clock is the authority.
    return {
      native: false,
      play: () => clock.play(),
      pause: () => clock.pause(),
      stop: () => clock.stop(),
      seek: (t) => clock.seek(t),
      setRate: (r) => clock.setRate(r),
      sync: () => Promise.resolve(null),
      dispose: () => {},
    }
  }

  const api = opts.api ?? {
    play: TransportPlay,
    pause: TransportPause,
    stop: TransportStop,
    seek: TransportSeek,
    setRate: TransportSetRate,
    get: GetTransportState,
  }

  let _disposed = false
  let _unsubscribe = null

  // Corrections arrive roughly ten times a second while the show runs, and
  // immediately on every change. Each one is a complete state, so a message
  // that lost a race is simply discarded by the clock's sequence check.
  try {
    _unsubscribe = Events.On(TRANSPORT_STATE_EVENT, (e) => {
      if (_disposed) return
      clock.adopt(transportFromEvent(e))
    })
  } catch (err) {
    console.warn('[transport] cannot follow the shell:', err)
  }

  /**
   * Send a command and adopt the state it returns.
   *
   * The optimistic local apply is what makes the playhead move on the same
   * frame as the key press. The shell's answer arrives a moment later with a
   * sequence number and supersedes it; both describe the same instant, so
   * there is nothing to see.
   */
  function command(call, optimistic) {
    try { optimistic?.() } catch { }
    let result
    try {
      result = call()
    } catch (err) {
      console.warn('[transport] command failed:', err)
      return Promise.resolve(null)
    }
    return Promise.resolve(result)
      .then((state) => {
        if (!_disposed) clock.adopt(state)
        return state
      })
      .catch((err) => {
        console.warn('[transport] command failed:', err)
        return null
      })
  }

  return {
    native: true,
    play: () => command(() => api.play(), () => clock.play()),
    pause: () => command(() => api.pause(), () => clock.pause()),
    stop: () => command(() => api.stop(), () => clock.stop()),
    seek: (t) => command(() => api.seek(t), () => clock.seek(t)),
    setRate: (r) => command(() => api.setRate(r), () => clock.setRate(r)),
    // Used once at startup, so a reloaded editor picks up a show that is
    // already running rather than presenting a playhead at zero.
    sync: () => command(() => api.get(), null),
    dispose: () => {
      _disposed = true
      try { _unsubscribe?.() } catch { }
      _unsubscribe = null
    },
  }
}
