import { describe, it, expect } from 'vitest'
import { toFileUri, computeOverlaps, computeFadeOpacity, buildFilterString } from '../utils/mediaUtils.js'

describe('toFileUri', () => {
  it('converts Windows path with drive letter', () => {
    expect(toFileUri('C:\\Users\\test\\image.png')).toBe('file:///C:/Users/test/image.png')
  })

  it('converts POSIX path', () => {
    expect(toFileUri('/home/user/image.png')).toBe('file:///home/user/image.png')
  })

  it('encodes spaces in path', () => {
    const result = toFileUri('C:\\My Folder\\my file.png')
    expect(result).toContain('My%20Folder')
    expect(result).toContain('my%20file.png')
    expect(result).toMatch(/^file:\/\/\/C:\//)
  })

  it('preserves drive letter colon', () => {
    const result = toFileUri('D:\\data\\test.jpg')
    expect(result).toMatch(/^file:\/\/\/D:\//)
  })
})

describe('computeOverlaps', () => {
  it('returns empty set for non-overlapping clips', () => {
    const media = [
      { id: 'a', start: 0, duration: 5 },
      { id: 'b', start: 5, duration: 5 },
    ]
    const result = computeOverlaps(media)
    expect(result.size).toBe(0)
  })

  it('detects overlapping clips', () => {
    const media = [
      { id: 'a', start: 0, duration: 10 },
      { id: 'b', start: 5, duration: 10 },
    ]
    const result = computeOverlaps(media)
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(true)
  })

  it('handles start_at_seconds fallback', () => {
    const media = [
      { id: 'a', start_at_seconds: 0, duration: 10 },
      { id: 'b', start_at_seconds: 5, duration: 10 },
    ]
    const result = computeOverlaps(media)
    expect(result.size).toBe(2)
  })

  it('handles empty list', () => {
    expect(computeOverlaps([]).size).toBe(0)
  })

  it('handles single clip', () => {
    expect(computeOverlaps([{ id: 'a', start: 0, duration: 5 }]).size).toBe(0)
  })

  it('only flags overlapping clips, not adjacent ones', () => {
    const media = [
      { id: 'a', start: 0, duration: 5 },
      { id: 'b', start: 5, duration: 5 },
      { id: 'c', start: 3, duration: 5 },
    ]
    const result = computeOverlaps(media)
    expect(result.has('a')).toBe(true) // overlaps with c
    expect(result.has('c')).toBe(true) // overlaps with a and b
    expect(result.has('b')).toBe(true) // overlaps with c
  })
})

describe('computeFadeOpacity', () => {
  it('returns full opacity when no fades', () => {
    const tm = { start: 0, duration: 10, opacity: 1, fade_in: 0, fade_out: 0 }
    expect(computeFadeOpacity(tm, 5)).toBe(1)
  })

  it('applies fade in at start', () => {
    const tm = { start: 0, duration: 10, opacity: 1, fade_in: 2, fade_out: 0 }
    expect(computeFadeOpacity(tm, 0)).toBe(0)
    expect(computeFadeOpacity(tm, 1)).toBeCloseTo(0.5)
    expect(computeFadeOpacity(tm, 2)).toBe(1)
  })

  it('applies fade out at end', () => {
    const tm = { start: 0, duration: 10, opacity: 1, fade_in: 0, fade_out: 2 }
    expect(computeFadeOpacity(tm, 9)).toBeCloseTo(0.5)
    expect(computeFadeOpacity(tm, 10)).toBe(0)
  })

  it('respects clip opacity', () => {
    const tm = { start: 0, duration: 10, opacity: 0.5, fade_in: 0, fade_out: 0 }
    expect(computeFadeOpacity(tm, 5)).toBe(0.5)
  })

  it('defaults opacity to 1 if missing', () => {
    const tm = { start: 0, duration: 10 }
    expect(computeFadeOpacity(tm, 5)).toBe(1)
  })
})

describe('buildFilterString', () => {
  it('returns none for no effects', () => {
    expect(buildFilterString({})).toBe('none')
  })

  it('handles legacy blur', () => {
    expect(buildFilterString({ blur: 5 })).toBe('blur(5px)')
  })

  it('builds multiple effects', () => {
    const tm = {
      effects: {
        brightness: { enabled: true, value: 1.5 },
        contrast: { enabled: true, value: 0.8 },
        grayscale: { enabled: false, value: 1 },
      }
    }
    const result = buildFilterString(tm)
    expect(result).toContain('brightness(1.5)')
    expect(result).toContain('contrast(0.8)')
    expect(result).not.toContain('grayscale')
  })

  it('handles hue-rotate', () => {
    const tm = { effects: { 'hue-rotate': { enabled: true, value: 90 } } }
    expect(buildFilterString(tm)).toBe('hue-rotate(90deg)')
  })
})
