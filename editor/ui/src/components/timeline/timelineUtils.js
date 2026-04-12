// Pure timeline math — testable without React

/**
 * Format a time value as a timecode string (H:MM:SS.ss or M:SS.ss).
 * @param {number} t - time in seconds
 * @returns {string}
 */
export function formatTimecode(t) {
  const abs = Math.max(0, t || 0)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const sStr = s.toFixed(2).padStart(5, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`
}

/**
 * Pick the best tick step (seconds) for a given pixel density.
 * Targets ~100px between major ticks.
 * @param {number} pxPerSec
 * @returns {number}
 */
export function pickTickStep(pxPerSec) {
  const target = 100 / pxPerSec
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  for (const st of steps) { if (st >= target) return st }
  return steps[steps.length - 1]
}

/**
 * Generate tick positions for a ruler.
 * @param {number} duration - total timeline duration in seconds
 * @param {number} tickStep - interval between ticks
 * @returns {number[]}
 */
export function generateTicks(duration, tickStep) {
  const ticks = []
  for (let t = 0; t <= duration + 1e-6; t += tickStep) {
    ticks.push(Number(t.toFixed(6)))
  }
  return ticks
}

/**
 * Generate second-dot positions (only useful at high zoom).
 * @param {number} duration
 * @param {number} pxPerSecond
 * @returns {number[]}
 */
export function generateSecondDots(duration, pxPerSecond) {
  if (pxPerSecond <= 10) return []
  const dots = []
  for (let s = 0; s <= Math.floor(duration + 1e-6); s++) dots.push(s)
  return dots
}

/** Layout constants shared by ruler, playhead, and hit-testing */
export const LABEL_W = 120
export const ROW_HEIGHT = 28
export const TRACK_ROW_HEIGHT = 40 // 28 + top/bottom margin
