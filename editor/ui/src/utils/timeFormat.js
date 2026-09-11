/**
 * Time formatting for the timeline and the status bar.
 *
 * One formatter per purpose, so the ruler can no longer mix `12s` below a
 * minute with `1:00.00` above it in the same row of ticks.
 */

/** `m:ss.hh`, promoting to `h:mm:ss.hh` past an hour. Used for readouts. */
export function formatTimecode(t) {
  const abs = Math.max(0, Number(t) || 0)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const sStr = s.toFixed(2).padStart(5, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`
}

/**
 * A ruler tick label, at the precision the tick spacing justifies.
 *
 * The shape is the same at every zoom level — only the number of decimals
 * changes — so labels stay comparable as the user zooms.
 */
export function formatRulerLabel(t, tickStep) {
  const abs = Math.max(0, Number(t) || 0)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const decimals = tickStep < 1 ? (tickStep < 0.2 ? 2 : 1) : 0
  const sStr = s.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sStr}`
  return `${m}:${sStr}`
}

/** `1.5s`, `2m 04s` — compact duration for lists and tooltips. */
export function formatDuration(t) {
  const abs = Math.max(0, Number(t) || 0)
  if (abs < 60) return `${abs.toFixed(abs < 10 ? 1 : 0)}s`
  const m = Math.floor(abs / 60)
  const s = Math.round(abs % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}
