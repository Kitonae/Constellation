// Pure viewport math — testable without React

export const BASE_SCALE = 50  // pixels per scene unit at neutral zoom
export const Z_NEUTRAL = 0.2
export const STAGE_W = 4000
export const STAGE_H = 3000

export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v))
}

export function scaleFromZoom(zoom) {
  return BASE_SCALE * (zoom / Z_NEUTRAL)
}

export function ratioFromZoom(zoom) {
  return zoom / Z_NEUTRAL
}

export function stageCenter() {
  return { x: STAGE_W / 2, y: STAGE_H / 2 }
}

/**
 * Convert a world position to stage pixel coordinates.
 */
export function worldToStage(worldX, worldY, center, scale) {
  return {
    x: center.x + worldX * scale,
    y: center.y - worldY * scale,
  }
}

// --- Dot grid background ---

const _gridCache = { key: '', url: '' }

export function dotGridBg(center, zoom) {
  const pxPerUnit = BASE_SCALE * (zoom / Z_NEUTRAL)

  const levels = [10, 50, 100, 500, 1000, 5000]
  let minorWorld = 100
  for (const lv of levels) {
    if (lv * pxPerUnit >= 16) { minorWorld = lv; break }
  }
  const majorMult = 10
  const minorPx = Math.round(minorWorld * pxPerUnit)
  const tilePx = minorPx * majorMult

  if (minorPx < 4) return { background: '#0b0d12' }

  const cacheKey = `${tilePx}_${minorPx}`
  if (_gridCache.key !== cacheKey) {
    const c = document.createElement('canvas')
    c.width = tilePx
    c.height = tilePx
    const ctx = c.getContext('2d')

    ctx.fillStyle = '#2a375b'
    for (let gy = 0; gy < majorMult; gy++) {
      for (let gx = 0; gx < majorMult; gx++) {
        if (gx === 0 && gy === 0) continue
        const x = gx * minorPx
        const y = gy * minorPx
        ctx.beginPath()
        ctx.arc(x, y, 1, 0, Math.PI * 2)
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

  const mod = (v, m) => ((v % m) + m) % m
  const offX = mod(center.x, tilePx)
  const offY = mod(center.y, tilePx)

  return {
    backgroundImage: `url(${_gridCache.url})`,
    backgroundSize: `${tilePx}px ${tilePx}px`,
    backgroundPosition: `${offX}px ${offY}px`,
    backgroundRepeat: 'repeat',
  }
}
