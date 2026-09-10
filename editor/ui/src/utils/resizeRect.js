/**
 * Centre-anchored rectangle resize, pure and unit-tested.
 *
 * Clip transforms store a centre (`position`) and a size (`scale`), so a
 * handle drag has to move both: dragging the east edge grows the width by
 * `dx` and moves the centre by `dx / 2`.
 */

/** The eight handles, in the order a UI usually renders them. */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const MOVES_X = { w: -1, e: 1, nw: -1, sw: -1, ne: 1, se: 1 }
const MOVES_Y = { n: -1, s: 1, nw: -1, ne: -1, sw: 1, se: 1 }

/** True when the handle drives both axes, i.e. aspect lock is meaningful. */
export function isCorner(handle) {
  return handle.length === 2
}

/** Cursor for a handle. */
export function cursorFor(handle) {
  switch (handle) {
    case 'n': case 's': return 'ns-resize'
    case 'e': case 'w': return 'ew-resize'
    case 'nw': case 'se': return 'nwse-resize'
    case 'ne': case 'sw': return 'nesw-resize'
    default: return 'default'
  }
}

/**
 * Apply a handle drag to a rectangle.
 *
 * @param {{cx:number, cy:number, w:number, h:number}} rect starting rectangle
 * @param {string} handle one of HANDLES
 * @param {number} dx pointer delta in the same units as the rect
 * @param {number} dy
 * @param {{keepAspect?:boolean, minSize?:number}} opts
 * @returns {{cx:number, cy:number, w:number, h:number}}
 */
export function resizeRect(rect, handle, dx, dy, { keepAspect = false, minSize = 8 } = {}) {
  const sx = MOVES_X[handle] || 0
  const sy = MOVES_Y[handle] || 0
  const min = Math.max(1, minSize)

  let w = rect.w
  let h = rect.h

  if (keepAspect && isCorner(handle) && rect.w > 0 && rect.h > 0) {
    // Drive both axes from whichever delta is larger, so the pointer leads the
    // gesture rather than fighting the ratio.
    const ratio = rect.h / rect.w
    const byX = rect.w + sx * dx
    const byY = (rect.h + sy * dy) / ratio
    const nextW = Math.abs(sx * dx) >= Math.abs(sy * dy) ? byX : byY
    w = Math.max(min, nextW)
    h = Math.max(min, w * ratio)
  } else {
    if (sx !== 0) w = Math.max(min, rect.w + sx * dx)
    if (sy !== 0) h = Math.max(min, rect.h + sy * dy)
  }

  // The opposite edge stays put, so the centre moves by half the growth.
  const cx = rect.cx + (sx !== 0 ? sx * (w - rect.w) / 2 : 0)
  const cy = rect.cy + (sy !== 0 ? sy * (h - rect.h) / 2 : 0)

  return { cx, cy, w, h }
}

/** Handle positions as fractions of a rect, for placing the grab squares. */
export function handleOffset(handle) {
  const fx = handle.includes('w') ? 0 : handle.includes('e') ? 1 : 0.5
  const fy = handle.includes('n') ? 0 : handle.includes('s') ? 1 : 0.5
  return { fx, fy }
}
