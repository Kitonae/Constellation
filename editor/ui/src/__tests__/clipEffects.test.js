import { describe, it, expect } from 'vitest'
import { describeClipEffects } from '../utils/mediaUtils.js'

describe('describeClipEffects', () => {
  it('is empty for a clip shown as-is', () => {
    expect(describeClipEffects({ opacity: 1, fade_in: 0, fade_out: 0 })).toEqual([])
    expect(describeClipEffects({})).toEqual([])
  })

  it('names opacity, fades and enabled effects with their values', () => {
    const tm = {
      opacity: 0.8, fade_in: 2, fade_out: 0.5, blur: 4,
      effects: { brightness: { enabled: true, value: 1.2 }, sepia: { enabled: false, value: 1 }, 'hue-rotate': { enabled: true, value: 90 } },
    }
    expect(describeClipEffects(tm)).toEqual(['Opacity 80%', 'Fade in 2s', 'Fade out 0.5s', 'Blur 4px', 'Brightness 1.2', 'Hue 90\u00b0'])
  })
})
