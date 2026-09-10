/**
 * World <-> stage coordinate helpers.
 *
 * The same rect computation appeared three times in Viewport2D (drop
 * hit-test, marquee, clip render) with slightly different fallbacks. Compute
 * it once so a clip cannot be hit-tested at a different place from where it
 * is drawn.
 */

import { STAGE_CENTER } from './constants.js'
import { clipStart, clipDuration } from '../../utils/clipTime.js'

/** World point to a pixel position on the stage canvas. */
export function worldToStage(wx, wy, ratio, center = STAGE_CENTER) {
  return { x: center.x + wx * ratio, y: center.y - wy * ratio }
}

/** Stage canvas pixel to a world point. */
export function stageToWorld(sx, sy, ratio, center = STAGE_CENTER) {
  return { x: (sx - center.x) / ratio, y: (center.y - sy) / ratio }
}

/** A screen node's rect in world units. */
export function screenWorldRect(node) {
  const p = node?.transform?.position || {}
  return {
    id: node?.id,
    cx: p.x || 0,
    cy: p.y || 0,
    w: node?.kind?.pixels?.[0] || 0,
    h: node?.kind?.pixels?.[1] || 0,
  }
}

/**
 * A clip's rect in world units.
 *
 * A stored scale of 0 means "use the natural size", so the media's probed
 * dimensions have to stand in before any maths happens.
 */
export function clipWorldRect(tm, screen, meta) {
  const spos = screen?.transform?.position || { x: 0, y: 0 }
  const baseW = meta?.w || 100
  const baseH = meta?.h || 100
  return {
    id: tm.id,
    cx: (spos.x ?? 0) + (tm.position?.x || 0),
    cy: (spos.y ?? 0) + (tm.position?.y || 0),
    w: (tm.scale?.x > 0 ? tm.scale.x : baseW),
    h: (tm.scale?.y > 0 ? tm.scale.y : baseH),
  }
}

/** A world rect as stage pixels, ready to position an absolute box. */
export function rectToStage(rect, ratio, center = STAGE_CENTER) {
  const w = Math.max(2, rect.w * ratio)
  const h = Math.max(2, rect.h * ratio)
  const c = worldToStage(rect.cx, rect.cy, ratio, center)
  return { left: c.x - w / 2, top: c.y - h / 2, width: w, height: h }
}

/** Is the clip on screen at this time? */
export function isClipActive(tm, t) {
  const start = clipStart(tm)
  return t >= start && t <= start + clipDuration(tm)
}

/** Do two stage rects overlap? Used by the marquee. */
export function rectsIntersect(a, b) {
  return a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top
}
