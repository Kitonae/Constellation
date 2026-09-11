import { STAGE_CENTER, scaleForZoom } from './constants.js'
import { colors } from '../../theme.js'

// One cached tile per (style, size) combination. Switching the grid style
// used to be impossible, so a single-entry cache was enough; with two styles
// a plain object keyed by style keeps both tiles warm instead of thrashing.
const _gridCache = {}

/**
 * Pick the grid interval for the current zoom.
 *
 * Adaptive: the smallest world-space interval that still keeps cells at least
 * 16px apart, so the grid stays readable across the whole zoom range instead
 * of turning into a solid field.
 */
function gridMetrics(zoom) {
  const pxPerUnit = scaleForZoom(zoom)
  const levels = [10, 50, 100, 500, 1000, 5000]
  let minorWorld = 100
  for (const lv of levels) {
    if (lv * pxPerUnit >= 16) { minorWorld = lv; break }
  }
  const majorMult = 10
  const minorPx = Math.round(minorWorld * pxPerUnit)
  return { minorPx, majorMult, tilePx: minorPx * majorMult }
}

function paintDots(ctx, minorPx, majorMult) {
  ctx.fillStyle = colors.stageLine
  for (let gy = 0; gy < majorMult; gy++) {
    for (let gx = 0; gx < majorMult; gx++) {
      if (gx === 0 && gy === 0) continue // skip origin — major dot goes there
      ctx.beginPath()
      ctx.arc(gx * minorPx, gy * minorPx, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.fillStyle = colors.accent
  ctx.beginPath()
  ctx.arc(0, 0, 2.5, 0, Math.PI * 2)
  ctx.fill()
}

function paintLines(ctx, minorPx, majorMult, tilePx) {
  // Half-pixel offsets keep a 1px stroke on the pixel grid instead of
  // straddling two rows and rendering as a soft 2px smear.
  ctx.strokeStyle = colors.stageGrid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < majorMult; i++) {
    const at = Math.round(i * minorPx) + 0.5
    ctx.moveTo(at, 0); ctx.lineTo(at, tilePx)
    ctx.moveTo(0, at); ctx.lineTo(tilePx, at)
  }
  ctx.stroke()

  // The major cell edge, and the origin, read one step stronger.
  ctx.strokeStyle = colors.stageLine
  ctx.beginPath()
  ctx.moveTo(0.5, 0); ctx.lineTo(0.5, tilePx)
  ctx.moveTo(0, 0.5); ctx.lineTo(tilePx, 0.5)
  ctx.stroke()

  ctx.fillStyle = colors.accent
  ctx.fillRect(0, 0, 3, 3)
}

/**
 * The stage's background grid, as a repeating canvas tile.
 *
 * @param {'dots'|'lines'} style
 * @param {{x:number,y:number}} center - world origin in screen space
 * @param {number} zoom
 * @returns {object} inline style for the stage element
 */
export function gridBg(style = 'dots', center = STAGE_CENTER, zoom) {
  const { minorPx, majorMult, tilePx } = gridMetrics(zoom)

  // Below this the cells are closer together than the marks themselves, so
  // any grid is just noise.
  if (minorPx < 4) return { background: 'var(--bg-deep)' }

  const kind = style === 'lines' ? 'lines' : 'dots'
  const cacheKey = `${kind}_${tilePx}_${minorPx}`
  let entry = _gridCache[kind]
  if (!entry || entry.key !== cacheKey) {
    const c = document.createElement('canvas')
    c.width = tilePx
    c.height = tilePx
    const ctx = c.getContext('2d')
    if (kind === 'lines') paintLines(ctx, minorPx, majorMult, tilePx)
    else paintDots(ctx, minorPx, majorMult)
    entry = { key: cacheKey, url: c.toDataURL() }
    _gridCache[kind] = entry
  }

  // Offset so the tile origin aligns with the world origin.
  const mod = (v, m) => ((v % m) + m) % m
  return {
    backgroundImage: `url(${entry.url})`,
    backgroundSize: `${tilePx}px ${tilePx}px`,
    backgroundPosition: `${mod(center.x, tilePx)}px ${mod(center.y, tilePx)}px`,
    backgroundRepeat: 'repeat',
  }
}
