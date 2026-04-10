// Clean timeline model — analogous to MF Topology nodes + Sequencer Source segments.
//
// Replaces the ad-hoc timeline structures in store.js and the duplicated
// active-clip logic in Viewport2D.jsx, DisplayWindow.jsx, and Timeline.jsx.

import { getAssetDuration } from './asset.js'

// --- Factories ---

let _idCounter = 0

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(++_idCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Create a new TimelineClip — an instance of a media asset placed on the timeline.
 *
 * @param {string} assetId - reference to a MediaAsset.id
 * @param {object} [props]
 * @returns {TimelineClip}
 */
export function createTimelineClip(assetId, props = {}) {
  return {
    id: props.id || genId('tl'),
    assetId,

    // Source range: which part of the source media to use
    sourceIn: props.sourceIn ?? 0,
    sourceOut: props.sourceOut ?? null, // null = use full asset duration

    // Timeline placement
    start: props.start ?? 0,
    duration: props.duration ?? 10,
    speed: props.speed ?? 1.0,

    // 2D Transform
    transform: {
      x: props.transform?.x ?? props.position?.x ?? 0,
      y: props.transform?.y ?? props.position?.y ?? 0,
      width: props.transform?.width ?? props.scale?.x ?? 0,   // 0 = natural
      height: props.transform?.height ?? props.scale?.y ?? 0,  // 0 = natural
      rotation: props.transform?.rotation ?? 0,
      anchorX: props.transform?.anchorX ?? 0.5,
      anchorY: props.transform?.anchorY ?? 0.5,
    },

    // Appearance
    opacity: props.opacity ?? 1.0,

    // Transitions
    fadeIn: props.fadeIn ?? props.fade_in ?? 0,
    fadeOut: props.fadeOut ?? props.fade_out ?? 0,

    // Effects chain (ordered array — compositing order matters)
    effects: Array.isArray(props.effects) ? props.effects : [],
  }
}

/**
 * Create a new Track.
 * @param {string} [name]
 * @param {object} [props]
 * @returns {Track}
 */
export function createTrack(name, props = {}) {
  return {
    id: props.id || genId('trk'),
    name: name || 'Track',
    clips: Array.isArray(props.clips) ? props.clips : [],
    muted: props.muted ?? false,
    locked: props.locked ?? false,
    visible: props.visible ?? true,
  }
}

/**
 * Create a new Timeline.
 * @param {object} [props]
 * @returns {Timeline}
 */
export function createTimeline(props = {}) {
  return {
    id: props.id || genId('tmln'),
    name: props.name || 'Timeline',
    tracks: Array.isArray(props.tracks) ? props.tracks : [createTrack('Track 1')],
    duration: props.duration ?? 60,
    markers: Array.isArray(props.markers) ? props.markers : [],
  }
}

// --- Queries ---

/**
 * Get all clips active at a given time across all tracks.
 * Centralizes the logic previously duplicated in Viewport2D, DisplayWindow, and Timeline.
 *
 * Skips clips on muted tracks and clips that overlap within a track (same overlap
 * exclusion logic as the current DisplayWindow renderer).
 *
 * @param {Timeline} timeline
 * @param {number} time - presentation time in seconds
 * @param {object} [opts]
 * @param {boolean} [opts.skipOverlaps=true] - exclude overlapping clips
 * @param {boolean} [opts.skipMuted=true] - exclude clips on muted tracks
 * @returns {Array<{clip: TimelineClip, trackIndex: number}>}
 */
export function getActiveClips(timeline, time, opts = {}) {
  const skipOverlaps = opts.skipOverlaps ?? true
  const skipMuted = opts.skipMuted ?? true
  const result = []

  if (!timeline?.tracks) return result

  for (let ti = 0; ti < timeline.tracks.length; ti++) {
    const track = timeline.tracks[ti]
    if (skipMuted && track.muted) continue

    const clips = track.clips || []

    // Build overlap set if needed
    const overlaps = skipOverlaps ? _findOverlaps(clips) : new Set()

    for (const clip of clips) {
      if (skipOverlaps && overlaps.has(clip.id)) continue

      const start = clip.start ?? 0
      const dur = clip.duration ?? 0
      if (time >= start && time <= start + dur) {
        result.push({ clip, trackIndex: ti })
      }
    }
  }

  return result
}

/**
 * Compute the source media time for a clip at a given timeline time.
 * Accounts for sourceIn offset and playback speed.
 *
 * @param {TimelineClip} clip
 * @param {number} timelineTime - current timeline time
 * @returns {number} time within the source media (seconds)
 */
export function getClipSourceTime(clip, timelineTime) {
  const start = clip.start ?? 0
  const elapsed = Math.max(0, timelineTime - start)
  const speed = clip.speed ?? 1.0
  const sourceIn = clip.sourceIn ?? 0
  return sourceIn + elapsed * speed
}

/**
 * Compute the effective opacity of a clip at a given timeline time,
 * accounting for base opacity and fade in/out.
 *
 * @param {TimelineClip} clip
 * @param {number} timelineTime
 * @returns {number} opacity 0-1
 */
export function getClipOpacity(clip, timelineTime) {
  const start = clip.start ?? 0
  const dur = clip.duration ?? 0
  const timeInClip = timelineTime - start
  const fadeIn = clip.fadeIn ?? 0
  const fadeOut = clip.fadeOut ?? 0

  let fadeOpacity = 1
  if (fadeIn > 0 && timeInClip < fadeIn) {
    fadeOpacity = Math.max(0, Math.min(1, timeInClip / fadeIn))
  } else if (fadeOut > 0 && timeInClip > dur - fadeOut) {
    fadeOpacity = Math.max(0, Math.min(1, (dur - timeInClip) / fadeOut))
  }

  return (clip.opacity ?? 1) * fadeOpacity
}

/**
 * Build a CSS filter string from a clip's effects chain.
 *
 * @param {TimelineClip} clip
 * @returns {string} CSS filter value, or 'none'
 */
export function getClipFilterString(clip) {
  const effects = clip.effects || []
  const filters = []

  for (const fx of effects) {
    if (!fx.enabled) continue
    switch (fx.type) {
      case 'blur': filters.push(`blur(${fx.value}px)`); break
      case 'brightness': filters.push(`brightness(${fx.value})`); break
      case 'contrast': filters.push(`contrast(${fx.value})`); break
      case 'saturate': filters.push(`saturate(${fx.value})`); break
      case 'grayscale': filters.push(`grayscale(${fx.value})`); break
      case 'sepia': filters.push(`sepia(${fx.value})`); break
      case 'hue-rotate': filters.push(`hue-rotate(${fx.value}deg)`); break
      case 'invert': filters.push(`invert(${fx.value})`); break
    }
  }

  return filters.length ? filters.join(' ') : 'none'
}

/**
 * Compute the maximum end time across all clips in a timeline.
 * @param {Timeline} timeline
 * @returns {number}
 */
export function computeTimelineDuration(timeline) {
  let max = 0
  if (!timeline?.tracks) return max
  for (const track of timeline.tracks) {
    for (const clip of (track.clips || [])) {
      const end = (clip.start ?? 0) + (clip.duration ?? 0)
      if (end > max) max = end
    }
  }
  return max
}

/**
 * Check if two clips overlap on the same track.
 */
function _clipsOverlap(a, b) {
  const s1 = a.start ?? 0
  const e1 = s1 + (a.duration ?? 0)
  const s2 = b.start ?? 0
  const e2 = s2 + (b.duration ?? 0)
  return s1 < e2 && s2 < e1
}

/**
 * Find all clip IDs that overlap with another clip on the same track.
 * @param {TimelineClip[]} clips
 * @returns {Set<string>}
 */
function _findOverlaps(clips) {
  const overlaps = new Set()
  for (let j = 0; j < clips.length; j++) {
    for (let k = j + 1; k < clips.length; k++) {
      if (_clipsOverlap(clips[j], clips[k])) {
        overlaps.add(clips[j].id)
        overlaps.add(clips[k].id)
      }
    }
  }
  return overlaps
}

// --- Migration ---

/**
 * Migrate a legacy timeline item to a TimelineClip.
 *
 * Legacy format (from store.js):
 *   { id, target_node_id, clip_id, in_seconds, out_seconds, start_at_seconds,
 *     start, duration, position: {x,y}, scale: {x,y}, opacity, blur,
 *     fade_in, fade_out, effects: { [name]: { value, enabled } } }
 *
 * @param {object} legacy
 * @returns {TimelineClip}
 */
export function migrateTimelineItem(legacy) {
  if (!legacy) return null

  // Already migrated? Check for new-model field
  if (legacy.assetId && legacy.transform) return legacy

  // Convert effects from object to array
  const effectsObj = legacy.effects || {}
  const effectsArr = Object.entries(effectsObj).map(([type, data]) => ({
    type,
    value: data.value ?? 0,
    enabled: data.enabled ?? false,
  }))

  // Legacy blur as a separate effect
  if (legacy.blur && legacy.blur > 0) {
    const hasBlur = effectsArr.some(e => e.type === 'blur')
    if (!hasBlur) {
      effectsArr.unshift({ type: 'blur', value: legacy.blur, enabled: true })
    }
  }

  return createTimelineClip(legacy.clip_id || legacy.assetId || '', {
    id: legacy.id,
    sourceIn: legacy.in_seconds ?? 0,
    sourceOut: (legacy.out_seconds != null && legacy.in_seconds != null)
      ? legacy.out_seconds
      : null,
    start: legacy.start ?? legacy.start_at_seconds ?? 0,
    duration: legacy.duration ?? (
      (legacy.out_seconds != null && legacy.in_seconds != null)
        ? (legacy.out_seconds - legacy.in_seconds)
        : 10
    ),
    speed: legacy.speed ?? 1.0,
    position: legacy.position || { x: 0, y: 0 },
    scale: legacy.scale || { x: 0, y: 0 },
    opacity: legacy.opacity ?? 1.0,
    fadeIn: legacy.fade_in ?? legacy.fadeIn ?? 0,
    fadeOut: legacy.fade_out ?? legacy.fadeOut ?? 0,
    effects: effectsArr,
  })
}

/**
 * Migrate a legacy track to the new format.
 *
 * Legacy: { media: [...items] } or { media: item }
 * New:    { id, name, clips: [...TimelineClip], muted, locked, visible }
 *
 * @param {object} legacyTrack
 * @param {number} index - track index for naming
 * @returns {Track}
 */
export function migrateTrack(legacyTrack, index) {
  if (!legacyTrack) return createTrack(`Track ${index + 1}`)

  // Already migrated?
  if (legacyTrack.clips && Array.isArray(legacyTrack.clips) && legacyTrack.id) {
    return legacyTrack
  }

  // Normalize legacy media field
  let legacyItems = legacyTrack.media
  if (!Array.isArray(legacyItems)) {
    legacyItems = legacyItems ? [legacyItems] : []
  }

  const clips = legacyItems.map(item => migrateTimelineItem(item)).filter(Boolean)

  return createTrack(legacyTrack.name || `Track ${index + 1}`, {
    id: legacyTrack.id,
    clips,
    muted: legacyTrack.muted ?? false,
    locked: legacyTrack.locked ?? false,
    visible: legacyTrack.visible ?? true,
  })
}

/**
 * Migrate an entire legacy timeline.
 *
 * Legacy: { id, name, tracks: [{media: [...]}], events, duration_seconds }
 * New:    { id, name, tracks: [Track], duration, markers }
 *
 * @param {object} legacyTimeline
 * @returns {Timeline}
 */
export function migrateTimeline(legacyTimeline) {
  if (!legacyTimeline) return createTimeline()

  // Already migrated?
  if (legacyTimeline.tracks?.[0]?.clips !== undefined) {
    return legacyTimeline
  }

  const tracks = (legacyTimeline.tracks || []).map((t, i) => migrateTrack(t, i))
  const duration = legacyTimeline.duration_seconds ?? legacyTimeline.duration ?? 60

  return createTimeline({
    id: legacyTimeline.id,
    name: legacyTimeline.name,
    tracks,
    duration,
    markers: legacyTimeline.events || legacyTimeline.markers || [],
  })
}

// --- Serialization helpers ---

/**
 * Convert a new-model TimelineClip back to legacy format for backward compatibility
 * during the transition period. Used by buildProjectWrapper in App.jsx.
 *
 * @param {TimelineClip} clip
 * @returns {object} Legacy timeline item
 */
export function clipToLegacy(clip) {
  // Convert effects array back to object
  const effectsObj = {}
  for (const fx of (clip.effects || [])) {
    if (fx.type === 'blur' && !effectsObj.blur) {
      // Keep blur as both legacy field and effects object entry
    }
    effectsObj[fx.type] = { value: fx.value, enabled: fx.enabled }
  }

  return {
    id: clip.id,
    clip_id: clip.assetId,
    target_node_id: '',
    in_seconds: clip.sourceIn ?? 0,
    out_seconds: clip.sourceOut ?? ((clip.sourceIn ?? 0) + (clip.duration ?? 0)),
    start_at_seconds: clip.start ?? 0,
    start: clip.start ?? 0,
    duration: clip.duration ?? 0,
    position: { x: clip.transform?.x ?? 0, y: clip.transform?.y ?? 0 },
    scale: { x: clip.transform?.width ?? 0, y: clip.transform?.height ?? 0 },
    opacity: clip.opacity ?? 1,
    fade_in: clip.fadeIn ?? 0,
    fade_out: clip.fadeOut ?? 0,
    effects: effectsObj,
  }
}

/**
 * Convert a new-model Track back to legacy format.
 * @param {Track} track
 * @returns {object}
 */
export function trackToLegacy(track) {
  return {
    media: (track.clips || []).map(clipToLegacy),
  }
}

/**
 * Convert a new-model Timeline back to legacy format.
 * @param {Timeline} timeline
 * @returns {object}
 */
export function timelineToLegacy(timeline) {
  return {
    id: timeline.id,
    name: timeline.name,
    tracks: (timeline.tracks || []).map(trackToLegacy),
    events: timeline.markers || [],
    duration_seconds: timeline.duration ?? 60,
  }
}
