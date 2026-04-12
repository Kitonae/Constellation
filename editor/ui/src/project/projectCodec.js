import { getAssetDuration, migrateAsset } from '../media/asset.js'
import { clipToLegacy } from '../media/timeline.js'

const DEFAULT_SCENE = {
  id: 'scene',
  name: 'Scene',
  materials: [],
  meshes: [],
  roots: [],
}

const DEFAULT_TIMELINE = {
  id: 'tl',
  name: 'Timeline',
  tracks: [{ media: [] }],
  events: [],
  duration_seconds: 60,
}

export function createDefaultScene(scene) {
  return normalizeScene(scene)
}

export function createDefaultProject(scene) {
  const nextScene = normalizeScene(scene)
  return {
    id: 'untitled',
    name: 'Untitled',
    scene: nextScene,
    media: [],
    timeline: normalizeTimeline(null),
  }
}

export function ensureTimelineRecord(timeline, minimumDuration = DEFAULT_TIMELINE.duration_seconds) {
  const normalized = normalizeTimeline(timeline)
  return {
    ...normalized,
    duration_seconds: Math.max(getTimelineDurationSeconds(normalized), Math.max(0, toFiniteNumber(minimumDuration, DEFAULT_TIMELINE.duration_seconds))),
  }
}

export function createImportedMediaAsset({ id, name, uri, durationSeconds }) {
  return normalizeMediaAsset({
    id,
    name,
    uri,
    duration_seconds: durationSeconds,
  })
}

export function createTimelineItemRecord({
  id,
  assetId,
  targetNodeId = '',
  inSeconds = 0,
  outSeconds,
  startAt = 0,
  duration = 10,
  position,
  scale,
  opacity = 1,
  blur = 0,
  fadeIn = 0,
  fadeOut = 0,
  effects = {},
}) {
  const safeIn = Math.max(0, toFiniteNumber(inSeconds, 0))
  const safeDuration = Math.max(0, toFiniteNumber(duration, 10))
  const safeStart = Math.max(0, toFiniteNumber(startAt, 0))

  return normalizeTimelineItem({
    id,
    clip_id: assetId,
    target_node_id: targetNodeId,
    in_seconds: safeIn,
    out_seconds: Number.isFinite(Number(outSeconds)) ? Number(outSeconds) : safeIn + safeDuration,
    start_at_seconds: safeStart,
    start: safeStart,
    duration: safeDuration,
    position,
    scale,
    opacity,
    blur,
    fade_in: fadeIn,
    fade_out: fadeOut,
    effects,
  }, 0, 0)
}

export function loadProjectDocument(doc) {
  const source = unwrapProjectDocument(doc)
  const scene = normalizeScene(source.scene)

  return {
    id: source.id || 'untitled',
    name: source.name || 'Untitled',
    scene,
    media: normalizeMediaList(source.media),
    timeline: normalizeTimeline(source.timeline),
  }
}

export function createProjectDocument(project, sceneOverride) {
  if (!project) {
    throw new Error('No project loaded')
  }

  const scene = normalizeScene(sceneOverride || project.scene)

  return {
    project: {
      id: project.id || 'untitled',
      name: project.name || 'Untitled',
      scene,
      media: serializeMediaList(project.media),
      timeline: serializeTimeline(project.timeline),
    },
  }
}

export function normalizeTimeline(timeline) {
  const legacyTimeline = toLegacyTimeline(timeline)
  if (!legacyTimeline) {
    return {
      ...DEFAULT_TIMELINE,
      tracks: [{ media: [] }],
      events: [],
    }
  }

  const tracks = Array.isArray(legacyTimeline.tracks) && legacyTimeline.tracks.length
    ? legacyTimeline.tracks.map((track, index) => normalizeTrack(track, index))
    : [{ media: [] }]

  const rawDuration = legacyTimeline.duration_seconds ?? legacyTimeline.duration
  const explicitDuration = toFiniteNumber(rawDuration, DEFAULT_TIMELINE.duration_seconds)
  const baseDuration = Number.isFinite(Number(rawDuration))
    ? explicitDuration
    : DEFAULT_TIMELINE.duration_seconds

  return {
    id: legacyTimeline.id || DEFAULT_TIMELINE.id,
    name: legacyTimeline.name || DEFAULT_TIMELINE.name,
    tracks,
    events: Array.isArray(legacyTimeline.events)
      ? legacyTimeline.events
      : (Array.isArray(legacyTimeline.markers) ? legacyTimeline.markers : []),
    duration_seconds: Math.max(baseDuration, computeTimelineEnd(tracks)),
  }
}

export function serializeTimeline(timeline) {
  return normalizeTimeline(timeline)
}

export function getTimelineDurationSeconds(timeline) {
  return Math.max(0, toFiniteNumber(timeline?.duration_seconds, DEFAULT_TIMELINE.duration_seconds))
}

export function getTrackItems(track) {
  if (Array.isArray(track?.media)) return track.media
  return track?.media ? [track.media] : []
}

export function getTimelineTracks(timeline) {
  return Array.isArray(timeline?.tracks) ? timeline.tracks : []
}

export function getTimelineItemStart(item) {
  return toFiniteNumber(item?.start ?? item?.start_at_seconds, 0)
}

export function getTimelineItemDuration(item) {
  return getItemDuration(item, toFiniteNumber(item?.in_seconds, 0))
}

export function getTimelineItemEnd(item) {
  return getTimelineItemStart(item) + getTimelineItemDuration(item)
}

export function getTimelineItemAssetId(item) {
  return item?.clip_id || item?.assetId || ''
}

export function getTimelineItemFadeInSeconds(item) {
  return Math.max(0, toFiniteNumber(item?.fade_in ?? item?.fadeIn, 0))
}

export function getTimelineItemFadeOutSeconds(item) {
  return Math.max(0, toFiniteNumber(item?.fade_out ?? item?.fadeOut, 0))
}

export function findTimelineItemById(timeline, timelineItemId) {
  for (const track of getTimelineTracks(timeline)) {
    const item = getTrackItems(track).find((entry) => entry?.id === timelineItemId)
    if (item) return item
  }
  return null
}

export function findMediaAssetByTimelineItem(project, timelineItemId) {
  const item = findTimelineItemById(project?.timeline, timelineItemId)
  if (!item) return null
  const assetId = getTimelineItemAssetId(item)
  return (project?.media || []).find((asset) => asset.id === assetId) || null
}

export function getNonOverlappingTrackItems(track) {
  const items = getTrackItems(track)
  const overlaps = new Set()

  for (let left = 0; left < items.length; left++) {
    for (let right = left + 1; right < items.length; right++) {
      const a = items[left]
      const b = items[right]
      if (!a || !b) continue
      if (getTimelineItemStart(a) < getTimelineItemEnd(b) && getTimelineItemStart(b) < getTimelineItemEnd(a)) {
        overlaps.add(a.id)
        overlaps.add(b.id)
      }
    }
  }

  return items.filter((item) => !overlaps.has(item.id))
}

export function updateTimelineItems(timeline, updater) {
  const nextTimeline = ensureTimelineRecord(timeline)
  const tracks = getTimelineTracks(nextTimeline).map((track) => {
    const items = getTrackItems(track)
    const nextItems = items.map((item, index) => {
      const updated = updater(item, { track, index })
      return updated == null ? item : normalizeTimelineItem(updated, 0, index)
    })
    return { ...track, media: nextItems }
  })
  return { ...nextTimeline, tracks }
}

export function removeTimelineItemById(timeline, timelineItemId) {
  const nextTimeline = ensureTimelineRecord(timeline)
  const tracks = getTimelineTracks(nextTimeline).map((track) => ({
    ...track,
    media: getTrackItems(track).filter((item) => item?.id !== timelineItemId),
  }))
  return { ...nextTimeline, tracks }
}

export function removeTimelineItemsByAssetId(timeline, assetId) {
  const nextTimeline = ensureTimelineRecord(timeline)
  const tracks = getTimelineTracks(nextTimeline).map((track) => ({
    ...track,
    media: getTrackItems(track).filter((item) => getTimelineItemAssetId(item) !== assetId),
  }))
  return { ...nextTimeline, tracks }
}

export function computeTimelineDurationFromItems(timeline) {
  return computeTimelineEnd(getTimelineTracks(ensureTimelineRecord(timeline)).map((track) => ({
    ...track,
    media: getTrackItems(track),
  })))
}

function unwrapProjectDocument(doc) {
  return doc?.project ?? doc ?? {}
}

function normalizeScene(scene) {
  const source = scene || {}
  return {
    id: source.id || DEFAULT_SCENE.id,
    name: source.name || DEFAULT_SCENE.name,
    materials: Array.isArray(source.materials) ? source.materials : [],
    meshes: Array.isArray(source.meshes) ? source.meshes : [],
    roots: Array.isArray(source.roots)
      ? source.roots.map(normalizeNode).filter(Boolean)
      : [],
  }
}

function normalizeNode(node) {
  if (!node) return null

  const transform = node.transform || {}

  return {
    id: node.id,
    name: node.name,
    transform: {
      ...transform,
      position: normalizeVec3(transform.position, 0),
      rotation: normalizeRotation(transform.rotation),
      scale: normalizeVec3(transform.scale, 1),
    },
    children: Array.isArray(node.children)
      ? node.children.map(normalizeNode).filter(Boolean)
      : [],
    kind: normalizeNodeKind(node),
  }
}

function normalizeNodeKind(node) {
  if (node.kind?.type) {
    const kind = node.kind
    switch (kind.type) {
      case 'screen':
        return {
          ...kind,
          type: 'screen',
          screenType: kind.screenType || 'web',
          pixels: normalizePixels(kind.pixels),
          enabled: kind.enabled ?? true,
        }
      case 'light':
        return { ...kind, type: 'light', light: kind.light }
      case 'camera':
        return { ...kind, type: 'camera', cam: kind.cam ?? kind.camera }
      case 'mesh':
        return { ...kind, type: 'mesh', mesh: kind.mesh }
      default:
        return kind
    }
  }

  if (node.screen) {
    return {
      type: 'screen',
      screenType: node.screen.screenType || 'web',
      pixels: [
        toInteger(node.screen.pixels_x, 0),
        toInteger(node.screen.pixels_y, 0),
      ],
      enabled: node.screen.enabled ?? true,
    }
  }

  if (node.light) return { type: 'light', light: node.light }
  if (node.camera) return { type: 'camera', cam: node.camera }
  if (node.mesh) return { type: 'mesh', mesh: node.mesh }

  return null
}

function normalizeMediaList(media) {
  if (!Array.isArray(media)) return []
  return media.map(normalizeMediaAsset).filter(Boolean)
}

function serializeMediaList(media) {
  return normalizeMediaList(media).map(serializeMediaAsset).filter(Boolean)
}

function normalizeMediaAsset(asset) {
  if (!asset) return null

  const migrated = migrateAsset(asset)
  if (!migrated) return null

  const runtimeDuration = inferRuntimeDuration(asset, migrated)
  if (runtimeDuration !== undefined) {
    return { ...migrated, duration_seconds: runtimeDuration }
  }

  return migrated
}

function serializeMediaAsset(asset) {
  if (!asset) return null

  const serialized = { ...asset }
  const durationSeconds = inferSerializedDuration(asset)

  if (durationSeconds !== undefined) {
    serialized.duration_seconds = durationSeconds
  }

  return serialized
}

export function getMediaDurationSeconds(asset) {
  const normalized = normalizeMediaAsset(asset)
  if (!normalized) return 0

  const duration = inferSerializedDuration(normalized)
  return Number.isFinite(duration) ? duration : 0
}

function inferRuntimeDuration(source, migrated) {
  if (Number.isFinite(source?.duration_seconds)) return source.duration_seconds
  if (Number.isFinite(source?.duration)) return source.duration

  const intrinsicDuration = getAssetDuration(migrated)
  if (intrinsicDuration > 0) return intrinsicDuration

  if (isModelAsset(source) || isModelAsset(migrated)) return 0

  if (migrated?.type === 'image' || migrated?.type === 'color' || migrated?.type === 'text') {
    return 10
  }

  return undefined
}

function inferSerializedDuration(asset) {
  if (Number.isFinite(asset?.duration_seconds)) return asset.duration_seconds

  const intrinsicDuration = getAssetDuration(asset)
  if (intrinsicDuration > 0) return intrinsicDuration

  return undefined
}

function isModelAsset(asset) {
  const hint = String(asset?.uri || asset?.name || '')
  return /\.(gltf|glb|obj)$/i.test(hint)
}

function toLegacyTimeline(timeline) {
  if (!timeline) return null

  const hasClipTracks = Array.isArray(timeline.tracks)
    && timeline.tracks.some((track) => track && Object.prototype.hasOwnProperty.call(track, 'clips'))

  if (!hasClipTracks) {
    return timeline
  }

  return {
    id: timeline.id,
    name: timeline.name,
    tracks: (timeline.tracks || []).map((track) => ({
      id: track.id,
      name: track.name,
      muted: track.muted ?? false,
      locked: track.locked ?? false,
      visible: track.visible ?? true,
      media: (track.clips || []).map((clip) => clipToLegacy(clip)),
    })),
    events: timeline.markers || [],
    duration_seconds: timeline.duration ?? DEFAULT_TIMELINE.duration_seconds,
  }
}

function normalizeTrack(track, index) {
  const media = Array.isArray(track?.media)
    ? track.media
    : (track?.media ? [track.media] : [])

  return {
    id: track?.id || `track-${index + 1}`,
    name: track?.name || `Track ${index + 1}`,
    media: media.map((item, itemIndex) => normalizeTimelineItem(item, index, itemIndex)).filter(Boolean),
    muted: track?.muted ?? false,
    locked: track?.locked ?? false,
    visible: track?.visible ?? true,
  }
}

function normalizeTimelineItem(item, trackIndex, itemIndex) {
  if (!item) return null

  const legacyItem = needsLegacyClipConversion(item) ? clipToLegacy(item) : item
  const clipId = legacyItem.clip_id || legacyItem.assetId || ''
  const inSeconds = toFiniteNumber(legacyItem.in_seconds, 0)
  const duration = getItemDuration(legacyItem, inSeconds)
  const start = toFiniteNumber(legacyItem.start ?? legacyItem.start_at_seconds, 0)
  const effects = normalizeEffects(legacyItem.effects, legacyItem.blur)
  const blur = toFiniteNumber(legacyItem.blur, effects.blur?.enabled ? effects.blur.value : 0)

  return {
    ...legacyItem,
    id: legacyItem.id || `${clipId || 'timeline'}-${trackIndex}-${itemIndex}`,
    clip_id: clipId,
    target_node_id: legacyItem.target_node_id || '',
    in_seconds: inSeconds,
    out_seconds: toFiniteNumber(legacyItem.out_seconds, inSeconds + duration),
    start_at_seconds: start,
    start,
    duration,
    position: normalizeVec2(legacyItem.position, 0),
    scale: normalizeVec2(legacyItem.scale, 0),
    opacity: clamp01(toFiniteNumber(legacyItem.opacity, 1)),
    blur,
    fade_in: Math.max(0, toFiniteNumber(legacyItem.fade_in ?? legacyItem.fadeIn, 0)),
    fade_out: Math.max(0, toFiniteNumber(legacyItem.fade_out ?? legacyItem.fadeOut, 0)),
    effects,
  }
}

function needsLegacyClipConversion(item) {
  return Boolean(item?.assetId || item?.transform || item?.sourceIn !== undefined || item?.sourceOut !== undefined)
}

function normalizeEffects(effects, blurValue) {
  const next = {}

  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (!effect?.type) continue
      next[effect.type] = {
        value: toFiniteNumber(effect.value, 0),
        enabled: effect.enabled ?? false,
      }
    }
  } else if (effects && typeof effects === 'object') {
    for (const [key, value] of Object.entries(effects)) {
      next[key] = {
        value: toFiniteNumber(value?.value, 0),
        enabled: value?.enabled ?? false,
      }
    }
  }

  const blur = toFiniteNumber(blurValue, NaN)
  if (Number.isFinite(blur) && blur > 0 && !next.blur) {
    next.blur = { value: blur, enabled: true }
  }

  return next
}

function getItemDuration(item, inSeconds) {
  if (Number.isFinite(item?.duration)) {
    return Math.max(0, item.duration)
  }

  if (Number.isFinite(item?.out_seconds)) {
    return Math.max(0, item.out_seconds - inSeconds)
  }

  return 10
}

function computeTimelineEnd(tracks) {
  let maxEnd = 0

  for (const track of tracks || []) {
    for (const item of track.media || []) {
      const start = toFiniteNumber(item?.start ?? item?.start_at_seconds, 0)
      const duration = getItemDuration(item, toFiniteNumber(item?.in_seconds, 0))
      maxEnd = Math.max(maxEnd, start + duration)
    }
  }

  return maxEnd
}

function normalizePixels(pixels) {
  if (!Array.isArray(pixels) || pixels.length < 2) return [0, 0]
  return [toInteger(pixels[0], 0), toInteger(pixels[1], 0)]
}

function normalizeVec2(vec, fallback) {
  return {
    x: toFiniteNumber(vec?.x, fallback),
    y: toFiniteNumber(vec?.y, fallback),
  }
}

function normalizeVec3(vec, fallback) {
  return {
    x: toFiniteNumber(vec?.x, fallback),
    y: toFiniteNumber(vec?.y, fallback),
    z: toFiniteNumber(vec?.z, fallback),
  }
}

function normalizeRotation(rotation) {
  return {
    x: toFiniteNumber(rotation?.x, 0),
    y: toFiniteNumber(rotation?.y, 0),
    z: toFiniteNumber(rotation?.z, 0),
    w: toFiniteNumber(rotation?.w, 1),
  }
}

function toInteger(value, fallback) {
  return Math.round(toFiniteNumber(value, fallback))
}

function toFiniteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}
