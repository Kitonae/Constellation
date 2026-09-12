import { describe, it, expect } from 'vitest'
import { computeItemLayout, screenOffset } from '../media/renderer.js'

const scene = {
  roots: [
    { id: 'origin', kind: { type: 'screen', pixels: [1920, 1080] }, transform: { position: { x: 0, y: 0, z: 0 } } },
    { id: 'right', kind: { type: 'screen', pixels: [1920, 1080] }, transform: { position: { x: 500, y: 0, z: 0 } } },
    { id: 'group', kind: { type: 'group' }, children: [
      { id: 'nested', kind: { type: 'screen', pixels: [1280, 720] }, transform: { position: { x: -200, y: 100, z: 0 } } },
    ] },
  ],
}

// Web outputs composed every screen around the stage origin. A 100-pixel
// clip centred on a screen at X=500 landed at left=1410 in a 1920-wide
// output instead of 910; the native output subtracted the screen's
// position, so the two disagreed about where the clip was.
describe('screenOffset', () => {
  it('finds a screen at the top level and in a group', () => {
    expect(screenOffset(scene, 'right')).toEqual({ x: 500, y: 0 })
    expect(screenOffset(scene, 'nested')).toEqual({ x: -200, y: 100 })
  })

  it('treats an unknown screen, or no scene, as the origin', () => {
    expect(screenOffset(scene, 'nope')).toEqual({ x: 0, y: 0 })
    expect(screenOffset(null, 'right')).toEqual({ x: 0, y: 0 })
  })
})

describe('computeItemLayout with a screen offset', () => {
  const clip = { x: 500, y: 0, width: 100, height: 100 }

  it('centres a clip that sits on the screen', () => {
    const l = computeItemLayout(clip, 1920, 1080, null, screenOffset(scene, 'right'))
    expect(l.left).toBe(910)
    expect(l.top).toBe(490)
  })

  it('is unchanged for a screen at the origin', () => {
    const withOffset = computeItemLayout(clip, 1920, 1080, null, screenOffset(scene, 'origin'))
    const without = computeItemLayout(clip, 1920, 1080, null)
    expect(withOffset).toEqual(without)
    expect(without.left).toBe(1410)
  })

  it('matches the native subtraction on both axes, with Y up', () => {
    const l = computeItemLayout({ x: -200, y: 150, width: 100, height: 100 }, 1280, 720, null, screenOffset(scene, 'nested'))
    expect(l.left).toBe(640 - 50)           // x - ox = 0
    expect(l.top).toBe(360 - 50 - 50)       // y - oy = 50, upward
  })
})
