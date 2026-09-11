import { describe, it, expect } from 'vitest'
import { resizeRect, cursorFor, isCorner, handleOffset, HANDLES } from '../utils/resizeRect.js'

const rect = { cx: 100, cy: 100, w: 200, h: 100 }

describe('resizeRect', () => {
  // Clips store a centre and a size, so growing one edge must move the
  // centre by half the growth or the opposite edge walks too.
  it('keeps the opposite edge fixed when dragging east', () => {
    const r = resizeRect(rect, 'e', 40, 0)
    expect(r.w).toBe(240)
    expect(r.cx).toBe(120)
    expect(r.cy).toBe(100)
    expect(r.h).toBe(100)
    // left edge unchanged
    expect(r.cx - r.w / 2).toBeCloseTo(rect.cx - rect.w / 2)
  })

  it('grows leftwards when dragging west', () => {
    const r = resizeRect(rect, 'w', -40, 0)
    expect(r.w).toBe(240)
    expect(r.cx).toBe(80)
    expect(r.cx + r.w / 2).toBeCloseTo(rect.cx + rect.w / 2)
  })

  it('only touches one axis for an edge handle', () => {
    const r = resizeRect(rect, 'n', 50, -20)
    expect(r.w).toBe(200)
    expect(r.h).toBe(120)
  })

  it('keeps the aspect ratio on a corner when asked', () => {
    const r = resizeRect(rect, 'se', 100, 0, { keepAspect: true })
    expect(r.w / r.h).toBeCloseTo(rect.w / rect.h)
    expect(r.w).toBe(300)
  })

  it('frees the aspect ratio when not asked', () => {
    const r = resizeRect(rect, 'se', 100, 0, { keepAspect: false })
    expect(r.w).toBe(300)
    expect(r.h).toBe(100)
  })

  it('never shrinks below the minimum', () => {
    const r = resizeRect(rect, 'e', -1000, 0, { minSize: 8 })
    expect(r.w).toBe(8)
  })

  it('handles every declared handle without producing NaN', () => {
    for (const h of HANDLES) {
      const r = resizeRect(rect, h, 10, 10)
      expect(Number.isFinite(r.cx) && Number.isFinite(r.cy)).toBe(true)
      expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true)
    }
  })
})

describe('handle metadata', () => {
  it('knows which handles are corners', () => {
    expect(isCorner('se')).toBe(true)
    expect(isCorner('n')).toBe(false)
  })

  it('gives a diagonal cursor to corners', () => {
    expect(cursorFor('nw')).toBe('nwse-resize')
    expect(cursorFor('ne')).toBe('nesw-resize')
    expect(cursorFor('e')).toBe('ew-resize')
  })

  it('places handles at the right fractions', () => {
    expect(handleOffset('nw')).toEqual({ fx: 0, fy: 0 })
    expect(handleOffset('se')).toEqual({ fx: 1, fy: 1 })
    expect(handleOffset('n')).toEqual({ fx: 0.5, fy: 0 })
  })
})
