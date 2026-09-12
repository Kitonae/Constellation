import { describe, it, expect } from 'vitest'
import { FIELD, EFFECT_RANGES } from '../components/inspector/constants.js'

// NumberInput multiplies `step` by `displayScale` for arrows and scrubbing, so
// a field's step is in stored units. Opacity had a step of 1 against a scale
// of 100: one ArrowUp at 50% went to 100%.
describe('inspector field steps are in stored units', () => {
  it('opacity steps by one displayed percent', () => {
    const { step, displayScale } = FIELD.opacity
    expect(step * displayScale).toBe(1)
  })
})

describe('effects the native output cannot reproduce are marked', () => {
  it('blur is web-only until the native pipeline has an offscreen pass', () => {
    expect(EFFECT_RANGES.blur.nativeSupported).toBe(false)
  })

  it('every other effect is unmarked, so the hint means something', () => {
    for (const [name, cfg] of Object.entries(EFFECT_RANGES)) {
      if (name === 'blur') continue
      expect(cfg.nativeSupported, name).not.toBe(false)
    }
  })
})
