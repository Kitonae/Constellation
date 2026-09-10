import { STAGE_CENTER, scaleForZoom } from './constants.js'

// Cache for the grid tile canvas data URL
const _gridCache = { key: '', url: '' }

/**
 * The stage's dot grid, as a repeating canvas tile.
 *
 * Adaptive: picks the smallest world-space interval that still puts dots at
 * least 16px apart, so the grid stays readable across the whole zoom range
 * instead of turning into a solid field.
 */
export function dotGridBg(center = STAGE_CENTER, zoom) {
  const pxPerUnit = scaleForZoom(zoom)

  const levels = [10, 50, 100, 500, 1000, 5000]
  let minorWorld = 100
  for (const lv of levels) {
    if (lv * pxPerUnit >= 16) { minorWorld = lv; break }
  }
  const majorMult = 10
  const minorPx = Math.round(minorWorld * pxPerUnit)
  const tilePx = minorPx * majorMult // tile = one major cell = 10 minor cells

  if (minorPx < 4) return { background: 'var(--bg-deep)' }

  const cacheKey = `${tilePx}_${minorPx}`
  if (_gridCache.key !== cacheKey) {
    const c = document.createElement('canvas')
    c.width = tilePx
    c.height = tilePx
    const ctx = c.getContext('2d')

    ctx.fillStyle = '#2a375b'
    for (let gy = 0; gy < majorMult; gy++) {
      for (let gx = 0; gx < majorMult; gx++) {
        if (gx === 0 && gy === 0) continue // skip origin — major dot goes there
        ctx.beginPath()
        ctx.arc(gx * minorPx, gy * minorPx, 1, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    ctx.fillStyle = '#6a8fd8'
    ctx.beginPath()
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2)
    ctx.fill()

    _gridCache.key = cacheKey
    _gridCache.url = c.toDataURL()
  }

  // Offset so the tile origin aligns with the world origin.
  const mod = (v, m) => ((v % m) + m) % m
  return {
    backgroundImage: `url(${_gridCache.url})`,
    backgroundSize: `${tilePx}px ${tilePx}px`,
    backgroundPosition: `${mod(center.x, tilePx)}px ${mod(center.y, tilePx)}px`,
    backgroundRepeat: 'repeat',
  }
}
