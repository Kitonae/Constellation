import { describe, it, expect } from 'vitest'
import {
  normalizeMonitors, monitorFor, fillMonitor, snapRect, unionRect, fitTransform,
  outputRect, outputKeyPart, toLogicalPosition,
} from '../output/placement.js'

const wails = [
  { ID: 'b', Name: 'Right', IsPrimary: false, ScaleFactor: 1, Bounds: { X: 2560, Y: 0, Width: 1920, Height: 1080 }, PhysicalBounds: { X: 2560, Y: 0, Width: 1920, Height: 1080 } },
  { ID: 'a', Name: 'Laptop', IsPrimary: true, ScaleFactor: 1.5, Bounds: { X: 0, Y: 0, Width: 1707, Height: 1067 }, PhysicalBounds: { X: 0, Y: 0, Width: 2560, Height: 1600 } },
]
const monitors = normalizeMonitors(wails)

describe('normalizeMonitors', () => {
  it('uses physical bounds, keeps logical ones, and lists the primary first', () => {
    expect(monitors[0]).toMatchObject({ id: 'a', name: 'Laptop', x: 0, y: 0, w: 2560, h: 1600, lx: 0, ly: 0, scale: 1.5, primary: true })
    expect(monitors[1]).toMatchObject({ id: 'b', x: 2560, w: 1920, h: 1080, scale: 1, primary: false })
  })
})

describe('monitorFor', () => {
  it('picks the display under the centre', () => {
    expect(monitorFor({ x: 2600, y: 100, w: 1920, h: 1080 }, monitors).id).toBe('b')
  })
  it('falls back to the largest overlap when the centre is between displays', () => {
    // Centre at x=2560 exactly sits on the right display's first column.
    expect(monitorFor({ x: 1600, y: 0, w: 1920, h: 1080 }, monitors).id).toBe('b')
    // Mostly on the laptop, centre off both (below the right display).
    expect(monitorFor({ x: 2000, y: 1200, w: 1920, h: 1080 }, monitors).id).toBe('a')
  })
  it('is null when the rect touches no display', () => {
    expect(monitorFor({ x: 10000, y: 10000, w: 100, h: 100 }, monitors)).toBeNull()
    expect(monitorFor(null, monitors)).toBeNull()
  })
})

describe('fillMonitor', () => {
  it('covers the display exactly and borderless', () => {
    expect(fillMonitor(monitors[1])).toEqual({ output: { x: 2560, y: 0, borderless: true }, pixels: [1920, 1080] })
  })
})

describe('snapRect', () => {
  it('snaps a near edge to a display edge on each axis independently', () => {
    const r = snapRect({ x: 2552, y: 1090, w: 1920, h: 1080 }, monitors, [], 12)
    expect(r).toEqual({ x: 2560, y: 1080 })
  })
  it('snaps the right edge to another output\'s left edge', () => {
    const other = { x: 2000, y: 0, w: 500, h: 500 }
    const r = snapRect({ x: 1495, y: 300, w: 500, h: 500 }, [], [other], 12)
    expect(r.x).toBe(1500)
    expect(r.y).toBe(300) // nothing within reach on Y
  })
  it('leaves a rect alone beyond the threshold', () => {
    expect(snapRect({ x: 100, y: 100, w: 50, h: 50 }, monitors, [], 12)).toEqual({ x: 100, y: 100 })
  })
})

describe('unionRect and fitTransform', () => {
  it('spans every rect and fits it into the view with padding', () => {
    const b = unionRect(monitors)
    expect(b).toEqual({ x: 0, y: 0, w: 4480, h: 1600 })
    const tf = fitTransform(b, 1000, 500, 20)
    expect(tf.scale).toBeCloseTo(960 / 4480)
    // Width-bound, so it is centred vertically.
    expect(tf.ox).toBeCloseTo(20)
    expect(tf.oy).toBeCloseTo(20 + (460 - 1600 * tf.scale) / 2)
  })
})

describe('outputRect and outputKeyPart', () => {
  const node = { kind: { type: 'screen', pixels: [1920, 1080], output: { x: 2560, y: 0, borderless: true } } }
  it('reads the window rect off a placed screen', () => {
    expect(outputRect(node)).toEqual({ x: 2560, y: 0, w: 1920, h: 1080 })
    expect(outputRect({ kind: { type: 'screen', pixels: [1, 1] } })).toBeNull()
  })
  it('contributes to the screen key only when placed', () => {
    expect(outputKeyPart(node.kind)).toBe('2560,0,1')
    expect(outputKeyPart({ pixels: [1, 1] })).toBe('')
  })
})

describe('toLogicalPosition', () => {
  it('converts through the display the rect is on', () => {
    // Laptop is 150%: physical 300 px in is 200 logical px in.
    expect(toLogicalPosition({ x: 300, y: 150, w: 100, h: 100 }, monitors)).toEqual({ left: 200, top: 100 })
    // Right display is 100% and its logical origin is at 2560 too.
    expect(toLogicalPosition({ x: 2660, y: 10, w: 100, h: 100 }, monitors)).toEqual({ left: 2660, top: 10 })
  })
})
