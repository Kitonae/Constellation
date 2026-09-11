/**
 * Snapping solvers, pure and unit-tested.
 *
 * Callers convert the pixel threshold into the target's own units before
 * calling (`6 / pxPerSecond` on the timeline, `6 / ratio` on the stage), so
 * these functions never need to know about zoom. A threshold of 0 — what the
 * Alt key produces — disables snapping entirely.
 */

import { clipStart, clipEnd, trackMedia } from './clipTime.js'

/**
 * Snap a single value to the nearest target within `threshold`.
 * @returns {{ value:number, snapped:boolean, target:number|null, delta:number }}
 */
export function snapValue(value, targets, threshold) {
  const v = Number(value) || 0
  if (!(threshold > 0) || !targets?.length) {
    return { value: v, snapped: false, target: null, delta: 0 }
  }
  let best = null
  let bestDist = Infinity
  for (const t of targets) {
    if (!Number.isFinite(t)) continue
    const d = Math.abs(t - v)
    if (d <= threshold && d < bestDist) { bestDist = d; best = t }
  }
  if (best === null) return { value: v, snapped: false, target: null, delta: 0 }
  return { value: best, snapped: true, target: best, delta: best - v }
}

/**
 * Snap a span by whichever of its two edges lands closest to a target.
 * The span keeps its length; only `start` moves.
 * @returns {{ start:number, snapped:boolean, target:number|null, edge:'start'|'end'|null, delta:number }}
 */
export function snapSpan(start, length, targets, threshold) {
  const s = Number(start) || 0
  const len = Math.max(0, Number(length) || 0)
  const res = snapOffsets([s, s + len], targets, threshold)
  if (!res.snapped) return { start: s, snapped: false, target: null, edge: null, delta: 0 }
  return {
    start: s + res.delta,
    snapped: true,
    target: res.target,
    edge: res.pointIndex === 0 ? 'start' : 'end',
    delta: res.delta,
  }
}

/**
 * Given several candidate points that all move together (a clip's left edge,
 * centre and right edge, say), find the single smallest shift that puts one of
 * them on a target.
 * @returns {{ delta:number, snapped:boolean, target:number|null, point:number|null, pointIndex:number }}
 */
export function snapOffsets(points, targets, threshold) {
  const none = { delta: 0, snapped: false, target: null, point: null, pointIndex: -1 }
  if (!(threshold > 0) || !targets?.length || !points?.length) return none
  let best = none
  let bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const p = Number(points[i])
    if (!Number.isFinite(p)) continue
    for (const t of targets) {
      if (!Number.isFinite(t)) continue
      const d = Math.abs(t - p)
      if (d <= threshold && d < bestDist) {
        bestDist = d
        best = { delta: t - p, snapped: true, target: t, point: p, pointIndex: i }
      }
    }
  }
  return best
}

/**
 * Snap targets for a timeline gesture: time zero, the playhead, and the edges
 * of every clip on the tracks in play (excluding the clips being dragged).
 */
export function collectTimelineSnapTargets({ tracks, excludeIds, playhead, trackIndices } = {}) {
  const out = [0]
  if (Number.isFinite(playhead)) out.push(playhead)
  const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
  const list = tracks || []
  const indices = trackIndices && trackIndices.length
    ? [...new Set(trackIndices)].filter((i) => i >= 0 && i < list.length)
    : list.map((_, i) => i)
  for (const i of indices) {
    for (const m of trackMedia(list[i])) {
      if (!m || skip.has(m.id)) continue
      out.push(clipStart(m), clipEnd(m))
    }
  }
  return out
}

/**
 * Snap targets for a stage gesture, per axis: the edges and centres of every
 * screen and every other clip, in world units.
 * @returns {{ x:number[], y:number[] }}
 */
export function collectStageSnapTargets({ screens, clips, excludeIds } = {}) {
  const x = [0]
  const y = [0]
  const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
  const push = (rect) => {
    if (!rect) return
    const { cx, cy, w, h } = rect
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return
    x.push(cx - w / 2, cx, cx + w / 2)
    y.push(cy - h / 2, cy, cy + h / 2)
  }
  for (const r of screens || []) push(r)
  for (const r of clips || []) {
    if (r?.id && skip.has(r.id)) continue
    push(r)
  }
  return { x, y }
}
