import { describe, it, expect, beforeEach } from 'vitest'
import { setFileServerBase, resolveUriSync, withSidecarToken, toFileUri } from '../media/uri.js'

// Every URL that reaches the sidecar for a local file carries the session
// token; the sidecar refuses the request otherwise. The rewrite is the one
// place that builds those URLs, so it is the one place this has to hold.
describe('sidecar URLs', () => {
  beforeEach(() => setFileServerBase('http://localhost:1234', 'abc'))

  it('carry the session token', () => {
    const url = resolveUriSync('file:///C:/shows/clip.mp4')
    expect(url.startsWith('http://localhost:1234/fs/')).toBe(true)
    expect(url).toMatch(/[?&]token=abc$/)
  })

  it('encode a literal percent sign so it survives one decode on the server', () => {
    const url = resolveUriSync(toFileUri('C:\\shows\\100% done.png'))
    expect(url).toContain('100%25%20done.png')
    expect(url).toMatch(/[?&]token=abc$/)
  })

  it('append to a URL that already has a query', () => {
    expect(withSidecarToken('http://x/api/probe?uri=a')).toBe('http://x/api/probe?uri=a&token=abc')
  })

  it('leave URLs alone when no token has been configured', () => {
    setFileServerBase('http://localhost:1234', '')
    expect(resolveUriSync('file:///C:/shows/clip.mp4')).not.toContain('token=')
  })

  it('resolve to nothing without a base, rather than to a bare path', () => {
    setFileServerBase('', '')
    expect(resolveUriSync('file:///C:/shows/clip.mp4')).toBe('')
  })
})
