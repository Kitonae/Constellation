// Project, media bin, and timeline mutation slice

import {
  computeTimelineDurationFromItems,
  createDefaultProject,
  createImportedMediaAsset,
  createTimelineItemRecord,
  ensureTimelineRecord,
  getMediaDurationSeconds,
  getTimelineDurationSeconds,
  getTimelineItemAssetId,
  getTimelineItemEnd,
  getTimelineItemStart,
  getTimelineTracks,
  getTrackItems,
  loadProjectDocument,
  removeTimelineItemById,
  removeTimelineItemsByAssetId,
  updateTimelineItems,
} from '../project/projectCodec.js'
import { toFileUri } from '../utils/mediaUtils.js'
import { queueLog } from './log.js'

export function createProjectSlice(set, get) {
  return {
    project: null,
    loadProject: (json) => {
      const proj = loadProjectDocument(json)
      set({ project: proj, scene: proj.scene, selectedId: null, time: 0, _undoLabel: 'Load Project' })
    },
    newProject: () => {
      const scene = { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
      const proj = createDefaultProject(scene)
      set({ project: proj, scene: proj.scene, selectedId: null, time: 0, _undoLabel: 'New Project' })
    },
    setMediaUri: (id, uri) => set((s) => {
      if (!s.project?.media) return {}
      const media = s.project.media.map((m) => m.id === id ? { ...m, uri } : m)
      return { project: { ...s.project, media } }
    }),
    addMediaClip: ({ id, name, uri, duration_seconds, durationSeconds }) => set((s) => {
      const clip = createImportedMediaAsset({
        id: id || `clip-${Math.random().toString(36).slice(2, 8)}`,
        name: name || 'Clip',
        uri,
        durationSeconds: durationSeconds ?? duration_seconds ?? 10,
      })
      const baseProj = s.project ?? createDefaultProject(s.scene)
      const nextProj = { ...baseProj, media: [...(baseProj.media ?? []), clip] }
      queueLog('info', `Imported media: ${clip.name}`)
      return s.project
        ? { project: nextProj, _undoLabel: 'Import Media' }
        : { project: nextProj, scene: baseProj.scene, _undoLabel: 'Import Media' }
    }),
    addTrack: () => set((s) => {
      const tl = s.project?.timeline
      if (!tl) return {}
      const tracks = [...getTimelineTracks(tl), { media: [] }]
      return { project: { ...s.project, timeline: { ...tl, tracks } }, _undoLabel: 'Add Track' }
    }),
    addClipToTimeline: ({ clipId, startAt, duration, targetNodeId, position, scale, trackIndex }) => set((s) => {
      if (!s.project) return {}
      const clip = (s.project.media || []).find((m) => m.id === clipId)
      if (!clip) return {}
      const dur = duration ?? getMediaDurationSeconds(clip) ?? 10
      const tm = createTimelineItemRecord({
        id: `tl-${Math.random().toString(36).slice(2, 9)}`,
        assetId: clipId,
        targetNodeId: '',
        startAt: startAt ?? (s.time || 0),
        duration: dur,
        position: position ? { x: toInt(position.x, 0), y: toInt(position.y, 0) } : { x: 0, y: 0 },
        scale: scale ? { x: toInt(scale.x, 0), y: toInt(scale.y, 0) } : { x: 0, y: 0 },
      })
      const nextTimeline = ensureTimelineRecord(s.project.timeline, (s.time || 0) + dur)
      let tracks = [...getTimelineTracks(nextTimeline)]

      let finalTrackIndex = -1

      if (typeof trackIndex === 'number' && trackIndex >= 0) {
        finalTrackIndex = trackIndex
      } else if (typeof s.selectedTrackIndex === 'number' && s.selectedTrackIndex >= 0 && s.selectedTrackIndex < tracks.length) {
        finalTrackIndex = s.selectedTrackIndex
      } else {
        const start = getTimelineItemStart(tm)
        const end = getTimelineItemEnd(tm)
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i]
          const mediaList = getTrackItems(t)
          let hasOverlap = false
          for (const m of mediaList) {
            const s2 = getTimelineItemStart(m)
            const e2 = getTimelineItemEnd(m)
            if (start < e2 && s2 < end) {
              hasOverlap = true
              break
            }
          }
          if (!hasOverlap) {
            finalTrackIndex = i
            break
          }
        }
      }

      if (finalTrackIndex >= 0 && finalTrackIndex < tracks.length) {
        const mediaList = getTrackItems(tracks[finalTrackIndex])
        tracks[finalTrackIndex] = { ...tracks[finalTrackIndex], media: [...mediaList, tm] }
      } else {
        if (finalTrackIndex >= 0) {
          tracks.splice(finalTrackIndex, 0, { media: [tm] })
        } else {
          tracks.push({ media: [tm] })
        }
      }

      const duration_seconds = Math.max(getTimelineDurationSeconds(nextTimeline), getTimelineItemEnd(tm))
      queueLog('info', `Inserted clip '${clip.name}' at ${getTimelineItemStart(tm).toFixed(2)}s`)
      return { project: { ...s.project, timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds } }, _undoLabel: `Add ${clip.name} to Timeline` }
    }),
    addImageToShow: ({ filePath, uri, name, duration = 10 }) => set((s) => {
      const baseProj = s.project ?? createDefaultProject(s.scene)
      const id = `img-${Math.random().toString(36).slice(2, 8)}`
      const clipUri = uri ? String(uri) : toFileUri(String(filePath))
      const clip = createImportedMediaAsset({ id, name: name || id, uri: clipUri, durationSeconds: duration })
      const tm = createTimelineItemRecord({
        id: `tl-${Math.random().toString(36).slice(2, 9)}`,
        assetId: id,
        targetNodeId: '',
        startAt: s.time || 0,
        duration,
        position: { x: 0, y: 0 },
        scale: { x: 0, y: 0 },
      })
      const nextTimeline = ensureTimelineRecord(baseProj.timeline, (s.time || 0) + duration)
      const tracks = [...getTimelineTracks(nextTimeline), { media: [tm] }]
      const duration_seconds = Math.max(getTimelineDurationSeconds(nextTimeline), getTimelineItemEnd(tm))
      queueLog('info', `Added image '${clip.name}' targeting ${tm.target_node_id || 'scene'} at ${getTimelineItemStart(tm).toFixed(2)}s`)
      const nextProj = {
        ...baseProj,
        media: [...(baseProj.media ?? []), clip],
        timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds },
      }
      return s.project
        ? { project: nextProj, _undoLabel: `Add Image ${clip.name}` }
        : { project: nextProj, scene: baseProj.scene, _undoLabel: `Add Image ${clip.name}` }
    }),
    updateClipTransform: ({ clipId, timelineId, position, scale, opacity, blur, fade_in, fade_out }) => set((s) => {
      if (!s.project?.timeline?.tracks) return {}
      const timeline = updateTimelineItems(s.project.timeline, (m) => {
        const match = timelineId ? (m?.id === timelineId) : (clipId ? (getTimelineItemAssetId(m) === clipId) : false)
        if (!m || !match) return null
        const nextPos = position
          ? { x: toInt(position.x, m.position?.x ?? 0), y: toInt(position.y, m.position?.y ?? 0) }
          : (m.position ? { x: toInt(m.position.x, 0), y: toInt(m.position.y, 0) } : { x: 0, y: 0 })
        const nextScale = scale
          ? { x: toInt(scale.x, m.scale?.x ?? 0), y: toInt(scale.y, m.scale?.y ?? 0) }
          : (m.scale ? { x: toInt(m.scale.x, 0), y: toInt(m.scale.y, 0) } : { x: 0, y: 0 })
        const nextOpacity = (opacity !== undefined)
          ? Math.max(0, Math.min(1, parseFloat(opacity)))
          : (m.opacity ?? 1)
        const nextBlur = (blur !== undefined)
          ? Math.max(0, parseFloat(blur))
          : (m.blur ?? 0)
        const nextFadeIn = (fade_in !== undefined)
          ? Math.max(0, parseFloat(fade_in))
          : (m.fade_in ?? 0)
        const nextFadeOut = (fade_out !== undefined)
          ? Math.max(0, parseFloat(fade_out))
          : (m.fade_out ?? 0)
        return { ...m, position: nextPos, scale: nextScale, opacity: nextOpacity, blur: nextBlur, fade_in: nextFadeIn, fade_out: nextFadeOut }
      })
      return { project: { ...s.project, timeline }, _undoLabel: position ? 'Move Clip' : scale ? 'Resize Clip' : opacity !== undefined ? 'Change Opacity' : 'Edit Clip' }
    }),
    updateClipEffect: ({ timelineId, effect, value, enabled }) => set((s) => {
      if (!s.project?.timeline?.tracks) return {}
      const timeline = updateTimelineItems(s.project.timeline, (m) => {
        if (!m || m.id !== timelineId) return null
        const prevEffects = m.effects || {}
        const prevEffect = prevEffects[effect] || {}
        const nextEffect = {
          value: value !== undefined ? value : (prevEffect.value ?? 0),
          enabled: enabled !== undefined ? enabled : (prevEffect.enabled ?? false)
        }
        return { ...m, effects: { ...prevEffects, [effect]: nextEffect } }
      })
      return { project: { ...s.project, timeline }, _undoLabel: `Change ${effect}` }
    }),
    updateClipStart: ({ clipId, timelineId, startAt }) => set((s) => {
      if (!s.project?.timeline?.tracks) return {}
      const tl = s.project.timeline
      const duration = getTimelineDurationSeconds(tl)
      const timeline = updateTimelineItems(tl, (m) => {
        const match = timelineId ? (m?.id === timelineId) : (clipId ? (getTimelineItemAssetId(m) === clipId) : false)
        if (!m || !match) return null
        const nextStart = Math.max(0, Math.min(duration, startAt ?? getTimelineItemStart(m)))
        return { ...m, start_at_seconds: nextStart, start: nextStart }
      })
      return { project: { ...s.project, timeline }, _undoLabel: 'Move Clip on Timeline' }
    }),
    updateClipDuration: ({ clipId, timelineId, duration }) => set((s) => {
      if (!s.project?.timeline?.tracks) return {}
      const tl = s.project.timeline
      const nextDur = Math.max(0, duration ?? 0)
      const timeline = updateTimelineItems(tl, (m) => {
        const match = timelineId ? (m?.id === timelineId) : (clipId ? (getTimelineItemAssetId(m) === clipId) : false)
        if (!m || !match) return null
        return { ...m, duration: nextDur, out_seconds: (m.in_seconds || 0) + nextDur }
      })
      return {
        project: {
          ...s.project,
          timeline: {
            ...timeline,
            duration_seconds: Math.max(getTimelineDurationSeconds(timeline), computeTimelineDurationFromItems(timeline)),
          },
        },
        _undoLabel: 'Resize Clip Duration',
      }
    }),
    reorderClip: (clipId, newIndex) => set((s) => {
      if (!s.project?.timeline?.tracks) return {}
      const tl = s.project.timeline
      const tracks = [...getTimelineTracks(tl)]

      let movedClip = null
      const nextTracks = tracks.map(t => {
        const mediaList = getTrackItems(t)
        const idx = mediaList.findIndex(m => m.id === clipId)
        if (idx !== -1) {
          movedClip = mediaList[idx]
          const newMedia = [...mediaList]
          newMedia.splice(idx, 1)
          return { ...t, media: newMedia }
        }
        return t
      })

      if (!movedClip) return {}

      const targetIndex = Math.max(0, Math.min(nextTracks.length - 1, newIndex))
      const targetTrack = nextTracks[targetIndex]
      const targetMedia = getTrackItems(targetTrack)
      nextTracks[targetIndex] = { ...targetTrack, media: [...targetMedia, movedClip] }

      return { project: { ...s.project, timeline: { ...tl, tracks: nextTracks } }, _undoLabel: 'Reorder Clip' }
    }),
    removeClip: (clipId) => set((s) => {
      if (!s.project?.timeline?.tracks) return {}
      const nextTl = removeTimelineItemById(s.project.timeline, clipId)
      return { project: { ...s.project, timeline: nextTl }, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId, _undoLabel: 'Remove Clip from Timeline' }
    }),
    removeMediaClip: (clipId) => set((s) => {
      if (!s.project) return {}
      const nextMedia = (s.project.media || []).filter((m) => m.id !== clipId)
      let nextTl = s.project.timeline || null
      if (nextTl?.tracks?.length) nextTl = removeTimelineItemsByAssetId(nextTl, clipId)
      const nextProject = { ...s.project, media: nextMedia, ...(nextTl ? { timeline: nextTl } : {}) }
      const selectedClipId = s.selectedClipId === clipId ? null : s.selectedClipId
      return { project: nextProject, selectedClipId, _undoLabel: 'Remove Media' }
    }),
  }
}

function toInt(val, fallback = 0) {
  const n = Number(val)
  if (!Number.isFinite(n)) return Number.isFinite(fallback) ? Math.round(Number(fallback)) : 0
  return Math.round(n)
}
