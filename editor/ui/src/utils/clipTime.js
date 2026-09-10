/**
 * Timeline shape helpers.
 *
 * The document tolerates two clip shapes at once: the current
 * `{ start, duration }` and the legacy `{ start_at_seconds, in_seconds,
 * out_seconds }`. Every reader used to re-derive that inline — the same
 * `(m.start ?? m.start_at_seconds) || 0` appeared in the store, the Timeline,
 * the 2D viewport and the visibility hook, and they drifted. Read clips only
 * through these.
 */

/** Shortest clip a trim or a split may produce, in seconds. */
export const MIN_CLIP_DURATION = 0.1

/** Finite number or fallback. Guards callers against NaN from a text field. */
export function numOr(val, fallback = 0) {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

/** A track's clips, tolerating the single-object legacy shape. */
export function trackMedia(t) {
  if (!t) return []
  return Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
}

/** Ids of every clip on a track. */
export function trackClipIds(t) {
  return trackMedia(t).map((m) => m?.id).filter(Boolean)
}

export function clipStart(m) {
  return numOr(m?.start ?? m?.start_at_seconds, 0)
}

export function clipDuration(m) {
  if (m?.duration !== undefined) return numOr(m.duration, 0)
  return Math.max(0, numOr(m?.out_seconds, 0) - numOr(m?.in_seconds, 0))
}

export function clipEnd(m) {
  return clipStart(m) + clipDuration(m)
}

/** Does this timeline item match the requested selector? */
export function matchesClip(m, timelineId, clipId) {
  if (timelineId) return m?.id === timelineId
  if (clipId) return m?.clip_id === clipId
  return false
}

/** Timeline length = the furthest clip end, never shrinking below the stored value. */
export function timelineEnd(tracks, tl) {
  let end = numOr(tl?.duration_seconds, 0)
  for (const t of tracks || []) {
    for (const m of trackMedia(t)) {
      if (m) end = Math.max(end, clipEnd(m))
    }
  }
  return end
}

/**
 * The furthest clip end in the project, ignoring the stored `duration_seconds`.
 *
 * This is the real content length, which is what "go to end" and "zoom to fit"
 * want — `duration_seconds` only ever grows and carries a 5-minute tail.
 */
export function timelineExtent(project) {
  let end = 0
  for (const t of project?.timeline?.tracks || []) {
    for (const m of trackMedia(t)) {
      if (m) end = Math.max(end, clipEnd(m))
    }
  }
  return end
}

/** Every timeline item in the project, flattened. */
export function allTimelineItems(project) {
  const out = []
  for (const t of project?.timeline?.tracks || []) {
    for (const m of trackMedia(t)) if (m) out.push(m)
  }
  return out
}
