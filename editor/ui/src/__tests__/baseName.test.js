import { describe, it, expect } from 'vitest'
import { baseName } from '../media/asset.js'

// Assets imported through the native dialog used to carry their whole
// absolute path as their display name, because the extraction in
// importMedia.js split on `[\/]` — a character class holding only a forward
// slash, so Windows' backslash paths passed through untouched.
describe('baseName', () => {
  it('takes the filename off a Windows path', () => {
    expect(baseName('C:\\Users\\me\\clips\\aurora_loop_4k.mov')).toBe('aurora_loop_4k.mov')
  })

  it('takes the filename off a POSIX path', () => {
    expect(baseName('/home/me/clips/city_plate_v3.mov')).toBe('city_plate_v3.mov')
  })

  it('handles a file:// URI and un-escapes it', () => {
    expect(baseName('file:///C:/media/title%20card.png')).toBe('title card.png')
  })

  it('handles mixed separators', () => {
    expect(baseName('C:/media\\sub/stage_truss.fbx')).toBe('stage_truss.fbx')
  })

  it('drops a query and fragment', () => {
    expect(baseName('http://host/a/b/clip.mp4?t=3#x')).toBe('clip.mp4')
  })

  it('leaves an already-clean name alone', () => {
    expect(baseName('score_stem_a.wav')).toBe('score_stem_a.wav')
  })

  it('keeps the extension when the name has several dots', () => {
    expect(baseName('D:\\a\\my.render.v2.mov')).toBe('my.render.v2.mov')
  })

  it('returns blob: and data: URIs untouched, having no filename to recover', () => {
    expect(baseName('blob:http://localhost/abc-123')).toBe('blob:http://localhost/abc-123')
    expect(baseName('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR')
  })

  it('is safe on empty and nullish input', () => {
    expect(baseName('')).toBe('')
    expect(baseName(null)).toBe('')
    expect(baseName(undefined)).toBe('')
  })

  it('ignores a trailing separator', () => {
    expect(baseName('C:\\media\\folder\\')).toBe('folder')
  })
})
