import { describe, it, expect, vi } from 'vitest'
import { createPresentationClock } from '../media/clock.js'
import { createTransportBridge, transportFromEvent } from '../media/transportBridge.js'
import { createMediaSession } from '../media/session.js'

// The clock derives its position from an anchor rather than accumulating
// per-frame deltas. That is what lets the Go shell drive it, and what stops a
// long show drifting behind its own audio.
describe('presentation clock', () => {
  it('holds position while paused', () => {
    const clock = createPresentationClock()
    clock.seek(12.5)
    expect(clock.getTime()).toBe(12.5)
  })

  it('advances from the anchor while playing', () => {
    vi.useFakeTimers()
    try {
      const clock = createPresentationClock()
      clock.seek(5)
      clock.play()
      vi.advanceTimersByTime(2000)
      expect(clock.getTime()).toBeCloseTo(7, 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses where the show actually is, not where it started', () => {
    vi.useFakeTimers()
    try {
      const clock = createPresentationClock()
      clock.play()
      vi.advanceTimersByTime(3000)
      clock.pause()
      // Reading the position after clearing the run state would return the
      // bare anchor and rewind the show to zero.
      expect(clock.getTime()).toBeCloseTo(3, 1)
      vi.advanceTimersByTime(2000)
      expect(clock.getTime()).toBeCloseTo(3, 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scales advance by the rate', () => {
    vi.useFakeTimers()
    try {
      const clock = createPresentationClock()
      clock.setRate(2)
      clock.play()
      vi.advanceTimersByTime(1000)
      expect(clock.getTime()).toBeCloseTo(2, 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts an authoritative state', () => {
    const clock = createPresentationClock()
    clock.adopt({ playing: true, time: 30, rate: 1, seq: 5 })
    expect(clock.getState()).toBe('playing')
    expect(clock.getTime()).toBeGreaterThanOrEqual(30)
  })

  it('ignores a correction that lost a race', () => {
    // Corrections are latest-wins on the wire, so one that arrives after a
    // newer one would otherwise drag the playhead backwards.
    const clock = createPresentationClock()
    clock.adopt({ playing: false, time: 30, seq: 9 })
    clock.adopt({ playing: false, time: 2, seq: 4 })
    expect(clock.getTime()).toBe(30)
  })

  it('tells subscribers when an adopted state starts or stops the show', () => {
    const clock = createPresentationClock()
    const events = []
    clock.subscribe({
      onStart: () => events.push('start'),
      onPause: () => events.push('pause'),
      onStop: () => events.push('stop'),
    })
    clock.adopt({ playing: true, time: 0, seq: 1 })
    clock.adopt({ playing: false, time: 4, seq: 2 })
    clock.adopt({ playing: true, time: 4, seq: 3 })
    clock.adopt({ playing: false, time: 0, seq: 4 })
    expect(events).toEqual(['start', 'pause', 'start', 'stop'])
  })

  it('clamps a seek to a nonsense value', () => {
    const clock = createPresentationClock()
    clock.seek(-5)
    expect(clock.getTime()).toBe(0)
    clock.seek(Number.NaN)
    expect(clock.getTime()).toBe(0)
  })
})

describe('transport bridge', () => {
  const stubApi = () => {
    const calls = []
    let seq = 0
    const state = (patch) => {
      seq += 1
      return { playing: false, time: 0, rate: 1, seq, ...patch }
    }
    return {
      calls,
      api: {
        play: () => { calls.push('play'); return Promise.resolve(state({ playing: true })) },
        pause: () => { calls.push('pause'); return Promise.resolve(state({ playing: false, time: 9 })) },
        stop: () => { calls.push('stop'); return Promise.resolve(state({ playing: false, time: 0 })) },
        seek: (t) => { calls.push(`seek:${t}`); return Promise.resolve(state({ time: t })) },
        setRate: (r) => { calls.push(`rate:${r}`); return Promise.resolve(state({ rate: r })) },
        get: () => { calls.push('get'); return Promise.resolve(state({ playing: true, time: 42 })) },
      },
    }
  }

  it('sends commands to the shell rather than deciding locally', async () => {
    const clock = createPresentationClock()
    const { calls, api } = stubApi()
    const bridge = createTransportBridge(clock, { native: true, api })

    await bridge.play()
    await bridge.seek(3)
    await bridge.pause()
    await bridge.stop()
    expect(calls).toEqual(['play', 'seek:3', 'pause', 'stop'])
    bridge.dispose()
  })

  it('moves the playhead before the shell answers', () => {
    // The optimistic apply is what makes the playhead move on the same frame
    // as the key press; the shell's answer supersedes it a moment later.
    const clock = createPresentationClock()
    const { api } = stubApi()
    const bridge = createTransportBridge(clock, { native: true, api })

    bridge.seek(17)
    expect(clock.getTime()).toBe(17)
    bridge.dispose()
  })

  it('adopts the state the shell reports', async () => {
    const clock = createPresentationClock()
    const { api } = stubApi()
    const bridge = createTransportBridge(clock, { native: true, api })

    await bridge.sync()
    expect(clock.getState()).toBe('playing')
    expect(clock.getTime()).toBeGreaterThanOrEqual(42)
    bridge.dispose()
  })

  it('drives the clock directly when there is no shell', () => {
    const clock = createPresentationClock()
    const bridge = createTransportBridge(clock, { native: false })
    bridge.seek(6)
    bridge.play()
    expect(clock.getState()).toBe('playing')
    expect(bridge.native).toBe(false)
  })

  it('survives a command the shell rejects', async () => {
    const clock = createPresentationClock()
    const bridge = createTransportBridge(clock, {
      native: true,
      api: { play: () => Promise.reject(new Error('shell is gone')) },
    })
    await expect(bridge.play()).resolves.toBeNull()
    bridge.dispose()
  })

  it('reads a payload whether it is bare or wrapped', () => {
    expect(transportFromEvent({ data: { time: 1 } })).toEqual({ time: 1 })
    expect(transportFromEvent({ data: [{ time: 2 }] })).toEqual({ time: 2 })
    expect(transportFromEvent({})).toBeNull()
  })
})

describe('media session', () => {
  const recordingBridge = (clock) => {
    const calls = []
    return {
      calls,
      bridge: {
        native: true,
        play: () => { calls.push('play'); clock.play() },
        pause: () => { calls.push('pause'); clock.pause() },
        stop: () => { calls.push('stop'); clock.stop() },
        seek: (t) => { calls.push(`seek:${t}`); clock.seek(t) },
        setRate: (r) => { calls.push(`rate:${r}`); clock.setRate(r) },
        sync: () => Promise.resolve(null),
        dispose: () => { },
      },
    }
  }

  it('follows the clock rather than moving ahead of it', () => {
    // The session used to transition its own state and then command the
    // clock. A state machine that moves first can refuse a transition the
    // shell has already made, leaving the editor showing a paused show that
    // is in fact running on stage.
    let clock = null
    const session = createMediaSession({
      transport: {
        native: true,
        play: () => clock.play(),
        pause: () => clock.pause(),
        stop: () => clock.stop(),
        seek: (t) => clock.seek(t),
        setRate: (r) => clock.setRate(r),
        sync: () => Promise.resolve(null),
        dispose: () => { },
      },
    })
    clock = session.getClock()

    const states = []
    session.subscribe({ onStateChange: (next) => states.push(next) })

    session.play()
    session.pause()
    session.stop()
    expect(states).toEqual(['playing', 'paused', 'stopped'])
    expect(session.getState()).toBe('stopped')
  })

  it('routes every transport command through the bridge', () => {
    const probe = { clock: null }
    const session = createMediaSession({
      transport: {
        native: true,
        play: () => probe.calls.push('play'),
        pause: () => probe.calls.push('pause'),
        stop: () => probe.calls.push('stop'),
        seek: (t) => probe.calls.push(`seek:${t}`),
        setRate: (r) => probe.calls.push(`rate:${r}`),
        sync: () => Promise.resolve(null),
        dispose: () => { },
      },
    })
    probe.calls = []
    probe.clock = session.getClock()

    session.seek(4)
    session.setRate(2)
    // play/pause/stop are guarded by the session's own state, which only
    // moves when the clock says so; with a bridge that never drives the
    // clock, only the unguarded commands get through.
    expect(probe.calls).toEqual(['seek:4', 'rate:2'])
  })

  it('adopts a running show through the clock', () => {
    const session = createMediaSession({})
    const states = []
    session.subscribe({ onStateChange: (next) => states.push(next) })

    session.getClock().adopt({ playing: true, time: 12, rate: 1, seq: 1 })
    expect(session.getState()).toBe('playing')
    expect(session.getTime()).toBeGreaterThanOrEqual(12)
    expect(states).toEqual(['playing'])
  })

  it('cleans up the bridge when disposed', () => {
    let disposed = false
    const { bridge } = recordingBridge(createPresentationClock())
    bridge.dispose = () => { disposed = true }
    const session = createMediaSession({ transport: bridge })
    session.dispose()
    expect(disposed).toBe(true)
  })
})
