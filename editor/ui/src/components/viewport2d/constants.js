/**
 * Stage geometry constants.
 *
 * These were re-declared locally in five different places in Viewport2D —
 * including a bare `scale / 50` with a comment explaining the magic number —
 * so a change to one of them silently disagreed with the others.
 */

/** Screen pixels per scene unit at neutral zoom. */
export const BASE_SCALE = 50

/** The zoom value at which one media pixel is one screen pixel. */
export const Z_NEUTRAL = 0.2

export const ZOOM_MIN = 0.01
export const ZOOM_MAX = 20

/** The scrolled stage is a fixed canvas; the world lives in the middle of it. */
export const STAGE_W = 4000
export const STAGE_H = 3000

export const STAGE_CENTER = { x: STAGE_W / 2, y: STAGE_H / 2 }

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

/**
 * Media pixels to screen pixels.
 *
 * This is the number the zoom readout should show: at `Z_NEUTRAL` it is 1,
 * i.e. 100%. The toolbar used to print `zoom * 100`, so a 1:1 view read
 * "20%" and the default view read "2%".
 */
export function ratioForZoom(zoom) { return zoom / Z_NEUTRAL }

/** Scene units to screen pixels. */
export function scaleForZoom(zoom) { return BASE_SCALE * ratioForZoom(zoom) }
