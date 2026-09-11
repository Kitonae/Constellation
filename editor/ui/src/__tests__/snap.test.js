import { describe, it, expect } from 'vitest'
import {
  snapValue,
  snapSpan,
  snapOffsets,
  collectTimelineSnapTargets,
  collectStageSnapTargets,
} from '../utils/snap.js'

describe('snapValue', () => {
  it('snaps to a target inside the threshold', () => {
    const r = snapValue(10.05, [10, 20], 0.3)
    expect(r.snapped).toBe(true)
    expect(r.value).toBe(10)
    expect(r.delta).toBeCloseTo(-0.05)
  })

  it('leaves a value outside the threshold alone', () => {
    const r = snapValue(10.5, [10, 20], 0.3)
    expect(r.snapped).toBe(false)
    expect(r.value).toBe(10.5)
    expect(r.delta).toBe(0)
  })

  it('picks the nearest of two candidates', () => {
    const r = snapValue(10.4, [10, 10.5], 1)
    expect(r.target).toBe(10.5)
  })

  // Alt-dragging passes a threshold of 0, which must never snap.
  it('never snaps with a zero threshold', () => {
    expect(snapValue(10.001, [10], 0).snapped).toBe(false)
  })

  it('ignores non-finite targets', () => {
    expect(snapValue(10, [NaN, undefined, null], 1).snapped).toBe(false)
  })
})

describe('snapSpan', () => {
  it('snaps by the leading edge', () => {
    const r = snapSpan(9.95, 5, [10], 0.2)
    expect(r.snapped).toBe(true)
    expect(r.edge).toBe('start')
    expect(r.start).toBeCloseTo(10)
  })

  it('snaps by the trailing edge and keeps the length', () => {
    const r = snapSpan(4.9, 5, [10], 0.2)
    expect(r.snapped).toBe(true)
    expect(r.edge).toBe('end')
    expect(r.start).toBeCloseTo(5)
  })

  it('prefers whichever edge is closer', () => {
    // start is 0.15 from 10, end is 0.05 from 20
    const r = snapSpan(10.15, 9.9, [10, 20], 0.3)
    expect(r.edge).toBe('end')
  })
})

describe('snapOffsets', () => {
  it('returns the smallest shift that lands any point on a target', () => {
    const r = snapOffsets([5, 10, 15], [10.2], 0.5)
    expect(r.snapped).toBe(true)
    expect(r.pointIndex).toBe(1)
    expect(r.delta).toBeCloseTo(0.2)
  })

  it('reports no snap when nothing is close enough', () => {
    expect(snapOffsets([5, 10], [30], 1).snapped).toBe(false)
  })
})

describe('collectTimelineSnapTargets', () => {
  const tracks = [
    { media: [{ id: 'a', start: 0, duration: 2 }, { id: 'b', start: 5, duration: 1 }] },
    { media: [{ id: 'c', start: 10, duration: 3 }] },
  ]

  it('always offers zero and the playhead', () => {
    const t = collectTimelineSnapTargets({ tracks: [], playhead: 7.5 })
    expect(t).toContain(0)
    expect(t).toContain(7.5)
  })

  it('offers both edges of every clip', () => {
    const t = collectTimelineSnapTargets({ tracks, trackIndices: [0] })
    expect(t).toEqual(expect.arrayContaining([0, 2, 5, 6]))
  })

  it('excludes the clips being dragged', () => {
    const t = collectTimelineSnapTargets({ tracks, excludeIds: ['b'], trackIndices: [0] })
    expect(t).not.toContain(6)
    expect(t).toContain(2)
  })

  it('limits itself to the requested tracks', () => {
    const t = collectTimelineSnapTargets({ tracks, trackIndices: [0] })
    expect(t).not.toContain(13)
  })

  it('reads legacy clip fields', () => {
    const legacy = [{ media: [{ id: 'l', start_at_seconds: 4, in_seconds: 0, out_seconds: 2 }] }]
    const t = collectTimelineSnapTargets({ tracks: legacy })
    expect(t).toEqual(expect.arrayContaining([4, 6]))
  })
})

describe('collectStageSnapTargets', () => {
  it('offers edges and centres per axis', () => {
    const { x, y } = collectStageSnapTargets({
      screens: [{ cx: 0, cy: 0, w: 100, h: 50 }],
    })
    expect(x).toEqual(expect.arrayContaining([-50, 0, 50]))
    expect(y).toEqual(expect.arrayContaining([-25, 0, 25]))
  })

  it('excludes the clips being dragged', () => {
    const { x } = collectStageSnapTargets({
      screens: [],
      clips: [{ id: 'k', cx: 200, cy: 0, w: 10, h: 10 }],
      excludeIds: ['k'],
    })
    expect(x).not.toContain(200)
  })
})
