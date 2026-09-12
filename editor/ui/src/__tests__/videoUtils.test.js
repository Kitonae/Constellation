import { describe, it, expect } from 'vitest'
import { describeMediaError, isCodecUnsupported } from '../utils/videoUtils.js'

// video.onerror hands over an Event, which stringifies to "[object Event]".
// The console message the media bin logs has to say what actually went
// wrong, and the fallback has to know when it was the codec.
describe('describeMediaError', () => {
  it('names the unsupported-codec case, which is every HAP file', () => {
    expect(describeMediaError({ code: 4 })).toBe('the browser cannot decode this codec')
  })

  it('distinguishes a corrupt file from a codec the browser lacks', () => {
    expect(describeMediaError({ code: 3 })).toMatch(/corrupt/)
    expect(describeMediaError({ code: 3 })).not.toMatch(/codec/)
  })

  it('has something to say when there is no MediaError at all', () => {
    expect(describeMediaError(null)).toBe('the browser could not load it')
    expect(describeMediaError(undefined)).toBe('the browser could not load it')
  })
})

describe('isCodecUnsupported', () => {
  it('is true only for the codec case', () => {
    expect(isCodecUnsupported({ mediaErrorCode: 4 })).toBe(true)
    expect(isCodecUnsupported({ mediaErrorCode: 3 })).toBe(false)
    expect(isCodecUnsupported(new Error('x'))).toBe(false)
    expect(isCodecUnsupported(null)).toBe(false)
  })
})
