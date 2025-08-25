import { create } from 'zustand'
import { parseProject } from './utils/parseProject.js'

export const useEditorStore = create((set, get) => ({
  project: null,
  scene: null,
  time: 0,
  playing: false,
  importingMediaCount: 0,
  viewMode: '2d', // '2d' | '3d'
  showOutputOverlay: true,
  selectedId: null,
  selectedClipId: null, // primary selected timeline item id
  selectedClipIds: [], // multi-select support for stage/timeline
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
  beginImport: () => set((s) => ({ importingMediaCount: Math.max(0, (s.importingMediaCount||0) + 1) })),
  endImport: () => set((s) => ({ importingMediaCount: Math.max(0, (s.importingMediaCount||0) - 1) })),
  toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),
  setViewMode: (mode) => set({ viewMode: mode === '3d' ? '3d' : '2d' }),
  toggleViewMode: () => set((s) => ({ viewMode: s.viewMode === '2d' ? '3d' : '2d' })),
  toggleOutputOverlay: () => set((s) => ({ showOutputOverlay: !s.showOutputOverlay })),
  addScreenNode: ({ name, pixels, position, scale }) => set((s) => {
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
      kind: { type: 'screen', pixels: [px[0] | 0, px[1] | 0], enabled: true },
    }
    const nextScene = { ...scene, roots: [...(scene.roots || []), node] }
    // Ensure a project exists so Apply can work
    const proj = s.project || defaultProject(nextScene)
    return { scene: nextScene, project: proj, selectedId: id }
  }),
  loadProject: (json) => {
    const proj = parseProject(json)
    set({ project: proj, scene: proj.scene, selectedId: null, time: 0 })
  },
  // Add a generic media clip to the project's media bin
  addMediaClip: ({ id, name, uri, duration_seconds }) => set((s) => {
    const clip = {
      id: id || `clip-${Math.random().toString(36).slice(2, 8)}`,
      name: name || 'Clip',
      uri,
      duration_seconds: duration_seconds ?? 10,
    }
    const baseProj = s.project ?? defaultProject(s.scene)
    const nextProj = { ...baseProj, media: [...(baseProj.media ?? []), clip] }
    queueLog('info', `Imported media: ${clip.name}`)
    // If we had to create a default project, also ensure scene is set in store
    return s.project ? { project: nextProj } : { project: nextProj, scene: baseProj.scene }
  }),
  // Insert an existing clip onto the timeline
  addClipToTimeline: ({ clipId, startAt, duration, targetNodeId, position, scale }) => set((s) => {
    if (!s.project) return {}
    const clip = (s.project.media || []).find((m) => m.id === clipId)
    if (!clip) return {}
    const dur = duration ?? clip.duration_seconds ?? 10
    // No per-screen association; leave target empty
    const target = ''
    const tm = {
      id: `tl-${Math.random().toString(36).slice(2, 9)}`,
      target_node_id: target,
      clip_id: clipId,
      in_seconds: 0,
      out_seconds: dur,
      start_at_seconds: startAt ?? (s.time || 0),
      // new fields
      start: startAt ?? (s.time || 0),
      duration: dur,
      position: position ? { x: toInt(position.x, 0), y: toInt(position.y, 0) } : { x: 0, y: 0 },
      // 0 means use natural dimensions; renderer falls back to image width/height
      scale: scale ? { x: toInt(scale.x, 0), y: toInt(scale.y, 0) } : { x: 0, y: 0 },
    }
    const nextTimeline = s.project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, (s.time || 0) + dur) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: tm }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, (tm.start ?? tm.start_at_seconds) + (tm.duration ?? dur))
    queueLog('info', `Inserted clip '${clip.name}' at ${tm.start_at_seconds.toFixed(2)}s`)
    return { project: { ...s.project, timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds } } }
  }),
  // Add an image media clip and a timeline track targeting a screen
  // Accepts either a raw filePath (OS path) or a fully-resolved file URI.
  addImageToShow: ({ filePath, uri, name, duration = 10 }) => set((s) => {
    const baseProj = s.project ?? defaultProject(s.scene)
    const id = `img-${Math.random().toString(36).slice(2, 8)}`
    const clipUri = uri ? String(uri) : toFileUri(String(filePath))
    const clip = { id, name: name || id, uri: clipUri, duration_seconds: duration }
    // pick target screen: selected if it's a screen, otherwise first screen in scene
    // No per-screen association; leave target empty
    const target = ''
    const tm = {
      id: `tl-${Math.random().toString(36).slice(2, 9)}`,
      target_node_id: target ?? '',
      clip_id: id,
      in_seconds: 0,
      out_seconds: duration,
      start_at_seconds: s.time || 0,
      start: s.time || 0,
      duration,
      position: { x: 0, y: 0 },
      // 0 means use natural dimensions; renderer falls back to image width/height
      scale: { x: 0, y: 0 },
    }
    const nextTimeline = baseProj.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, (s.time || 0) + duration) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: tm }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, (tm.start ?? tm.start_at_seconds) + (tm.duration ?? duration))
    queueLog('info', `Added image '${clip.name}' targeting ${tm.target_node_id || 'scene'} at ${tm.start_at_seconds.toFixed(2)}s`)
    const nextProj = {
      ...baseProj,
      media: [...(baseProj.media ?? []), clip],
      timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds },
    }
    return s.project ? { project: nextProj } : { project: nextProj, scene: baseProj.scene }
  }),
  // Update a timeline clip's 2D transform parameters
  updateClipTransform: ({ clipId, timelineId, position, scale }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).map((t) => {
      const m = t.media
      const match = timelineId ? (m?.id === timelineId) : (clipId ? (m?.clip_id === clipId) : false)
      if (!m || !match) return t
      const nextPos = position
        ? { x: toInt(position.x, m.position?.x ?? 0), y: toInt(position.y, m.position?.y ?? 0) }
        : (m.position ? { x: toInt(m.position.x, 0), y: toInt(m.position.y, 0) } : { x: 0, y: 0 })
      const nextScale = scale
        ? { x: toInt(scale.x, m.scale?.x ?? 0), y: toInt(scale.y, m.scale?.y ?? 0) }
        : (m.scale ? { x: toInt(m.scale.x, 0), y: toInt(m.scale.y, 0) } : { x: 0, y: 0 })
      return { media: { ...m, position: nextPos, scale: nextScale } }
    })
    return { project: { ...s.project, timeline: { ...(s.project.timeline || {}), tracks } } }
  }),
  // Update timing for a clip (e.g., when dragging on timeline)
  updateClipStart: ({ clipId, timelineId, startAt }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tl = s.project.timeline
    const duration = Math.max(0, tl.duration_seconds ?? 0)
    const tracks = (tl.tracks || []).map((t) => {
      const m = t.media
      const match = timelineId ? (m?.id === timelineId) : (clipId ? (m?.clip_id === clipId) : false)
      if (!m || !match) return t
      const nextStart = Math.max(0, Math.min(duration, startAt ?? m.start ?? m.start_at_seconds ?? 0))
      return { media: { ...m, start_at_seconds: nextStart, start: nextStart } }
    })
    return { project: { ...s.project, timeline: { ...tl, tracks } } }
  }),
  // Update explicit duration for a clip (and legacy out_seconds)
  updateClipDuration: ({ clipId, timelineId, duration }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tl = s.project.timeline
    const nextDur = Math.max(0, duration ?? 0)
    const tracks = (tl.tracks || []).map((t) => {
      const m = t.media
      const match = timelineId ? (m?.id === timelineId) : (clipId ? (m?.clip_id === clipId) : false)
      if (!m || !match) return t
      return { media: { ...m, duration: nextDur, out_seconds: (m.in_seconds || 0) + nextDur } }
    })
    // Recompute timeline duration_seconds as max end
    const duration_seconds = tracks.reduce((acc, t) => {
      const m = t.media
      if (!m) return acc
      const st = m.start ?? m.start_at_seconds ?? 0
      const dur = m.duration ?? ((m.out_seconds - m.in_seconds) || 0)
      return Math.max(acc, st + dur)
    }, tl.duration_seconds || 0)
    return { project: { ...s.project, timeline: { ...tl, tracks, duration_seconds } } }
  }),
  tick: (dt) => {
    if (!get().playing) return
    set((s) => ({ time: s.time + dt }))
  },
  play: () => {
    queueLog('info', 'Local: play')
    set({ playing: true })
  },
  pause: () => {
    queueLog('info', 'Local: pause')
    set({ playing: false })
  },
  stop: () => {
    queueLog('info', 'Local: stop')
    set({ playing: false, time: 0 })
  },
  seek: (t) => set({ time: t }),
  setSelected: (id) => set({ selectedId: id }),
  setSelectedClip: (clipId) => set({ selectedClipId: clipId, selectedClipIds: clipId ? [clipId] : [] }),
  setSelectedClips: (clipIds) => set({ selectedClipIds: Array.isArray(clipIds) ? clipIds : [], selectedClipId: (clipIds && clipIds.length ? clipIds[0] : null) }),
  setGizmoMode: (mode) => set({ gizmoMode: mode }),
  updateNodeTransform: (id, next) => set((s) => ({ scene: {
    ...s.scene,
    roots: s.scene.roots.map((n) => updateNode(n, id, (node) => ({
      ...node,
      transform: {
        position: next.position ?? node.transform.position,
        rotation: next.rotation ?? node.transform.rotation,
        scale: next.scale ?? node.transform.scale,
      }
    })))
  } })),
  // Remove a clip instance from the timeline by timeline item id
  removeClip: (clipId) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).filter((t) => !(t.media && t.media.id === clipId))
    const nextTl = { ...(s.project.timeline || {}), tracks }
    return { project: { ...s.project, timeline: nextTl }, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId }
  }),
  // Remove a media clip from the bin and any timeline references
  removeMediaClip: (clipId) => set((s) => {
    if (!s.project) return {}
    const nextMedia = (s.project.media || []).filter((m) => m.id !== clipId)
    let nextTl = s.project.timeline || null
    if (nextTl?.tracks?.length) {
      const tracks = nextTl.tracks.filter((t) => !(t.media && t.media.clip_id === clipId))
      nextTl = { ...nextTl, tracks }
    }
    const nextProject = { ...s.project, media: nextMedia, ...(nextTl ? { timeline: nextTl } : {}) }
    const selectedClipId = s.selectedClipId === clipId ? null : s.selectedClipId
    return { project: nextProject, selectedClipId }
  }),
  updateScreenPixels: (id, pixels) => set((s) => ({ scene: {
    ...s.scene,
    roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
      if (node.kind?.type === 'screen') {
        return { ...node, kind: { ...node.kind, pixels: [pixels[0] | 0, pixels[1] | 0] } }
      }
      return node
    }))
  } })),
  updateScreenEnabled: (id, enabled) => set((s) => ({ scene: {
    ...s.scene,
    roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
      if (node.kind?.type === 'screen') {
        return { ...node, kind: { ...node.kind, enabled: !!enabled } }
      }
      return node
    }))
  } })),
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
    return { scene: { ...s.scene, roots }, selectedId: s.selectedId === id ? null : s.selectedId }
  }),
}))

  // Helper to enqueue a log entry without needing a store setter in scope
  function queueLog(level, message) {
  try {
    const fn = useEditorStore.getState().addLog
    if (fn) fn({ level, message })
  } catch {}
}

// Integer coercion helper for pixel-based values
function toInt(val, fallback = 0) {
  const n = Number(val)
  if (!Number.isFinite(n)) return Number.isFinite(fallback) ? Math.round(Number(fallback)) : 0
  return Math.round(n)
}

function defaultProject(scene) {
  const baseScene = scene ?? { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
  return {
    id: 'untitled',
    name: 'Untitled',
    scene: baseScene,
    media: [],
    timeline: { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: 60 },
  }
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

function toFileUri(p) {
  // Normalize separators
  let norm = p.replace(/\\/g, '/')
  // Windows drive letter path
  if (/^[A-Za-z]:\//.test(norm)) {
    return `file:///${norm}`
  }
  // Already starts with '/' (POSIX)
  if (norm.startsWith('/')) {
    return `file://${norm}`
  }
  // Fallback
  return `file://${norm}`
}
