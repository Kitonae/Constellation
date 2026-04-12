import { create } from 'zustand'
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
  loadProjectDocument,
  removeTimelineItemById,
  removeTimelineItemsByAssetId,
  updateTimelineItems,
} from './project/projectCodec.js'
import { setFileServerBaseUrl } from './utils/videoUtils.js'
import { toFileUri } from './utils/mediaUtils.js'
import { setFileServerBase, toFileUri as mfToFileUri } from './media/uri.js'
import { createMediaSession } from './media/session.js'
import { createUndoStore, withUndo } from './undo.js'

// Initialize file server base URL if in Wails environment
if (window.go?.main?.App?.GetFileServerPort) {
  window.go.main.App.GetFileServerPort().then(port => {
    if (port > 0) {
      console.log('Using sidecar file server at port', port)
      setFileServerBaseUrl(`http://localhost:${port}`)
      // Store port for model URL resolution
      useEditorStore.setState({ _fileServerPort: port })
      // Also set the Media Foundation URI resolver's base
      setFileServerBase(`http://localhost:${port}`)
    }
  }).catch(err => console.warn('Failed to get file server port', err))
}

export const useEditorStore = create(withUndo((set, get, api) => ({
  ...createUndoStore(set, get, api),
  _fileServerPort: 0,
  project: null,
  scene: null,
  time: 0,
  playing: false,
  importingMediaCount: 0,
  importingMediaCountUpdatedAt: 0,
  viewMode: '2d', // '2d' | '3d'
  showOutputOverlay: true,
  selectedId: null,
  selectedClipId: null, // primary selected timeline item id
  selectedClipIds: [], // multi-select support for stage/timeline
  selectedTrackIndex: null, // selected track index
  gizmoMode: 'translate',
  // Console/logging state
  logs: [], // { id, level, message, time }
  consoleOpen: false,
  addLog: ({ level = 'info', message }) => set((s) => {
    const entry = {
      id: `log-${Math.random().toString(36).slice(2, 9)}`,
      level,
      message: String(message ?? ''),
      time: Date.now(),
    }
    const next = [...s.logs, entry]
    // keep last 500 entries
    const pruned = next.length > 500 ? next.slice(next.length - 500) : next
    return { logs: pruned }
  }),
  // Update media clip fields by id (used to update URI after caching)
  setMediaUri: (id, uri) => set((s) => {
    if (!s.project?.media) return {}
    const media = s.project.media.map((m) => m.id === id ? { ...m, uri } : m)
    return { project: { ...s.project, media } }
  }),
  clearLogs: () => set({ logs: [] }),
  beginImport: () => set((s) => {
    const next = Math.max(0, (s.importingMediaCount || 0) + 1)
    console.debug('[import] begin ->', next)
    return { importingMediaCount: next, importingMediaCountUpdatedAt: Date.now() }
  }),
  endImport: () => set((s) => {
    const next = Math.max(0, (s.importingMediaCount || 0) - 1)
    console.debug('[import] end ->', next)
    return { importingMediaCount: next, importingMediaCountUpdatedAt: Date.now() }
  }),
  resetImportingIfStuck: () => set((s) => {
    if (s.importingMediaCount > 0 && Date.now() - (s.importingMediaCountUpdatedAt || 0) > 15000) {
      queueLog('warn', 'Import appeared stuck >15s; auto-reset')
      console.warn('[import] auto-reset stuck imports')
      return { importingMediaCount: 0, importProgress: null }
    }
    return {}
  }),
  // Detailed import progress
  importProgress: null, // { current, total, filename, cancelled }
  startImport: (total) => set({ importProgress: { current: 0, total, filename: '', cancelled: false } }),
  updateImportProgress: (current, filename) => set((s) => s.importProgress ? { importProgress: { ...s.importProgress, current, filename } } : {}),
  cancelImport: () => set((s) => s.importProgress ? { importProgress: { ...s.importProgress, cancelled: true } } : {}),
  finishImport: () => set({ importProgress: null }),
  toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),
  setViewMode: (mode) => set({ viewMode: (mode === '3d' || mode === 'output') ? mode : '2d' }),
  toggleViewMode: () => set((s) => ({ viewMode: s.viewMode === '2d' ? '3d' : '2d' })),
  toggleOutputOverlay: () => set((s) => ({ showOutputOverlay: !s.showOutputOverlay })),
  addScreenNode: ({ name, pixels, position, scale, screenType }) => set((s) => {
    const px = pixels || [1920, 1080]
    const scene = s.scene || { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
    const id = `screen-${Math.random().toString(36).slice(2, 8)}`
    const node = {
      id,
      name: name || `Screen ${scene.roots.length + 1}`,
      transform: {
        position: position || { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: scale || { x: 1, y: 1, z: 1 },
      },
      children: [],
      kind: { type: 'screen', screenType: screenType || 'web', pixels: [px[0] | 0, px[1] | 0], enabled: true },
    }
    const nextScene = { ...scene, roots: [...(scene.roots || []), node] }
    const proj = s.project || createDefaultProject(nextScene)
    return { scene: nextScene, project: proj, selectedId: id, _undoLabel: 'Add Screen' }
  }),
  loadProject: (json) => {
    const proj = loadProjectDocument(json)
    set({ project: proj, scene: proj.scene, selectedId: null, time: 0, _undoLabel: 'Load Project' })
  },
  newProject: () => {
    const scene = { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
    const proj = createDefaultProject(scene)
    set({ project: proj, scene: proj.scene, selectedId: null, time: 0, _undoLabel: 'New Project' })
  },
  // Add a generic media clip to the project's media bin
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
    // If we had to create a default project, also ensure scene is set in store
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
  // Insert an existing clip onto the timeline
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
      // Explicit track target (e.g. Drag & Drop)
      finalTrackIndex = trackIndex
    } else if (typeof s.selectedTrackIndex === 'number' && s.selectedTrackIndex >= 0 && s.selectedTrackIndex < tracks.length) {
      // Use selected track if available
      finalTrackIndex = s.selectedTrackIndex
    } else {
      // Find first available track with space
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
      // Add to existing track
      const mediaList = getTrackItems(tracks[finalTrackIndex])
      tracks[finalTrackIndex] = { ...tracks[finalTrackIndex], media: [...mediaList, tm] }
    } else {
      // Append new track (or insert at specific index if provided but out of bounds)
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
  // Add an image media clip and a timeline track targeting a screen
  // Accepts either a raw filePath (OS path) or a fully-resolved file URI.
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
  // Update a timeline clip's 2D transform parameters
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
  // Update a specific effect for a clip
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
  // Update timing for a clip (e.g., when dragging on timeline)
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
  // Update explicit duration for a clip (and legacy out_seconds)
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

    // Find and remove the clip from its current track
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

    // Clamp target track index
    const targetIndex = Math.max(0, Math.min(nextTracks.length - 1, newIndex))

    // Add to target track
    const targetTrack = nextTracks[targetIndex]
    const targetMedia = getTrackItems(targetTrack)
    nextTracks[targetIndex] = { ...targetTrack, media: [...targetMedia, movedClip] }

    return { project: { ...s.project, timeline: { ...tl, tracks: nextTracks } }, _undoLabel: 'Reorder Clip' }
  }),
  tick: (dt) => {
    if (!get().playing) return
    set((s) => ({ time: s.time + dt }))
  },
  play: () => {
    queueLog('info', 'Local: play')
    set({ playing: true })
    // Sync to Media Session if available
    try { getMediaSession().play() } catch {}
  },
  pause: () => {
    queueLog('info', 'Local: pause')
    set({ playing: false })
    try { getMediaSession().pause() } catch {}
  },
  stop: () => {
    queueLog('info', 'Local: stop')
    set({ playing: false, time: 0 })
    try { getMediaSession().stop() } catch {}
  },
  seek: (t) => {
    set({ time: t })
    try { getMediaSession().seek(t) } catch {}
  },
  setSelected: (id) => set({ selectedId: id }),
  setSelectedClip: (clipId) => set({ selectedClipId: clipId, selectedClipIds: clipId ? [clipId] : [] }),
  setSelectedClips: (clipIds) => set({ selectedClipIds: Array.isArray(clipIds) ? clipIds : [], selectedClipId: (clipIds && clipIds.length ? clipIds[0] : null) }),
  setSelectedTrackIndex: (index) => set({ selectedTrackIndex: index }),
  setGizmoMode: (mode) => set({ gizmoMode: mode }),
  updateNodeTransform: (id, next) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => ({
        ...node,
        transform: {
          position: next.position ?? node.transform.position,
          rotation: next.rotation ?? node.transform.rotation,
          scale: next.scale ?? node.transform.scale,
        }
      })))
    },
    _undoLabel: 'Move Screen',
  })),
  // Remove a clip instance from the timeline by timeline item id
  removeClip: (clipId) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const nextTl = removeTimelineItemById(s.project.timeline, clipId)
    return { project: { ...s.project, timeline: nextTl }, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId, _undoLabel: 'Remove Clip from Timeline' }
  }),
  // Remove a media clip from the bin and any timeline references
  removeMediaClip: (clipId) => set((s) => {
    if (!s.project) return {}
    const nextMedia = (s.project.media || []).filter((m) => m.id !== clipId)
    let nextTl = s.project.timeline || null
    if (nextTl?.tracks?.length) nextTl = removeTimelineItemsByAssetId(nextTl, clipId)
    const nextProject = { ...s.project, media: nextMedia, ...(nextTl ? { timeline: nextTl } : {}) }
    const selectedClipId = s.selectedClipId === clipId ? null : s.selectedClipId
    return { project: nextProject, selectedClipId, _undoLabel: 'Remove Media' }
  }),
  updateScreenPixels: (id, pixels) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
        if (node.kind?.type === 'screen') {
          return { ...node, kind: { ...node.kind, pixels: [pixels[0] | 0, pixels[1] | 0] } }
        }
        return node
      }))
    },
    _undoLabel: `Resize Screen to ${pixels[0]}x${pixels[1]}`,
  })),
  updateScreenType: (id, screenType) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
        if (node.kind?.type === 'screen') {
          return { ...node, kind: { ...node.kind, screenType } }
        }
        return node
      }))
    },
    _undoLabel: `Change Screen Type to ${screenType}`,
  })),
  updateScreenEnabled: (id, enabled) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
        if (node.kind?.type === 'screen') {
          return { ...node, kind: { ...node.kind, enabled: !!enabled } }
        }
        return node
      }))
    },
    _undoLabel: enabled ? 'Enable Screen' : 'Disable Screen',
  })),
  addModelNode: ({ name, uri, position, scale }) => set((s) => {
    const scene = s.scene || { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
    const id = `model-${Math.random().toString(36).slice(2, 8)}`
    const node = {
      id,
      name: name || 'Model',
      transform: {
        position: position || { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: scale || { x: 1, y: 1, z: 1 },
      },
      children: [],
      kind: { type: 'model', uri },
    }
    const nextScene = { ...scene, roots: [...(scene.roots || []), node] }
    const proj = s.project || createDefaultProject(nextScene)
    queueLog('info', `Added 3D model '${node.name}' to scene`)
    return { scene: nextScene, project: proj, selectedId: id, _undoLabel: `Add Model ${name || 'Model'}` }
  }),
  removeScreenNode: (id) => set((s) => {
    if (!s.scene?.roots) return {}
    function removeNodeRec(node, targetId) {
      if (node.id === targetId) return null
      const children = (node.children || [])
        .map((c) => removeNodeRec(c, targetId))
        .filter(Boolean)
      return { ...node, children }
    }
    const roots = (s.scene.roots || [])
      .map((n) => removeNodeRec(n, id))
      .filter(Boolean)
    return { scene: { ...s.scene, roots }, selectedId: s.selectedId === id ? null : s.selectedId, _undoLabel: 'Remove Screen' }
  }),
})))
window.useEditorStore = useEditorStore

// Helper to enqueue a log entry without needing a store setter in scope
function queueLog(level, message) {
  try {
    const fn = useEditorStore.getState().addLog
    if (fn) fn({ level, message })
  } catch { }
}

// Integer coercion helper for pixel-based values
function toInt(val, fallback = 0) {
  const n = Number(val)
  if (!Number.isFinite(n)) return Number.isFinite(fallback) ? Math.round(Number(fallback)) : 0
  return Math.round(n)
}

function updateNode(node, id, fn) {
  if (node.id === id) return fn(node)
  if (!node.children?.length) return node
  return { ...node, children: node.children.map((c) => updateNode(c, id, fn)) }
}

function pickScreenTarget(scene, selectedId) {
  if (!scene) return null
  // if selected is a screen, use it
  if (selectedId) {
    const n = findNode(scene.roots || [], selectedId)
    if (n && n.kind?.type === 'screen') return n.id
  }
  // otherwise first screen found
  const q = [...(scene.roots || [])]
  while (q.length) {
    const n = q.shift()
    if (n?.kind?.type === 'screen') return n.id
    if (n?.children?.length) q.push(...n.children)
  }
  return null
}

function findNode(nodes, id) {
  const stack = [...nodes]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.id === id) return n
    if (n.children?.length) stack.push(...n.children)
  }
  return null
}

// --- Media Session singleton ---
// The session is created lazily (after the store exists) and wired to sync
// transport state back into zustand so all existing components keep working.

let _mediaSession = null

/**
 * Get (or create) the global MediaSession instance.
 * @returns {object} MediaSession
 */
export function getMediaSession() {
  if (!_mediaSession) {
    _mediaSession = createMediaSession({
      getStore: () => useEditorStore.getState(),
      broadcastFn: async (event, payload) => {
        try {
          const { broadcastToDisplays } = await import('./display/displayManager.js')
          broadcastToDisplays(event, payload)
        } catch { }
      },
      uiUpdateInterval: 100,
    })

    // Sync session time updates back into zustand
    _mediaSession.subscribe({
      onTimeUpdate(time) {
        // Only update store if session is authoritative (playing)
        const s = useEditorStore.getState()
        if (s.playing) {
          useEditorStore.setState({ time })
        }
      },
      onStateChange(newState) {
        const playing = newState === 'playing'
        useEditorStore.setState({ playing })
      },
    })
  }
  return _mediaSession
}
