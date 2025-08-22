import { create } from 'zustand'
import { parseProject } from './utils/parseProject.js'

export const useEditorStore = create((set, get) => ({
  project: null,
  scene: null,
  time: 0,
  playing: false,
  viewMode: '2d', // '2d' | '3d'
  showOutputOverlay: true,
  selectedId: null,
  selectedClipId: null, // timeline selection
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
  clearLogs: () => set({ logs: [] }),
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
  addClipToTimeline: ({ clipId, startAt, duration, targetNodeId }) => set((s) => {
    if (!s.project) return {}
    const clip = (s.project.media || []).find((m) => m.id === clipId)
    if (!clip) return {}
    const dur = duration ?? clip.duration_seconds ?? 10
    const target = targetNodeId || pickScreenTarget(s.scene, s.selectedId) || ''
    const tm = {
      target_node_id: target,
      clip_id: clipId,
      in_seconds: 0,
      out_seconds: dur,
      start_at_seconds: startAt ?? (s.time || 0),
      position: { x: 0, y: 0 },
      // 0 means use natural dimensions; renderer falls back to image width/height
      scale: { x: 0, y: 0 },
    }
    const nextTimeline = s.project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, (s.time || 0) + dur) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: tm }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, tm.start_at_seconds + dur)
    queueLog('info', `Inserted clip '${clip.name}' at ${tm.start_at_seconds.toFixed(2)}s`)
    return { project: { ...s.project, timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds } } }
  }),
  // Add an image media clip and a timeline track targeting a screen
  addImageToShow: ({ filePath, name, duration = 10 }) => set((s) => {
    const baseProj = s.project ?? defaultProject(s.scene)
    const id = `img-${Math.random().toString(36).slice(2, 8)}`
    const clip = { id, name: name || id, uri: toFileUri(String(filePath)), duration_seconds: duration }
    // pick target screen: selected if it's a screen, otherwise first screen in scene
    const target = pickScreenTarget(s.scene ?? baseProj.scene, s.selectedId)
    const tm = {
      target_node_id: target ?? '',
      clip_id: id,
      in_seconds: 0,
      out_seconds: duration,
      start_at_seconds: s.time || 0,
      position: { x: 0, y: 0 },
      // 0 means use natural dimensions; renderer falls back to image width/height
      scale: { x: 0, y: 0 },
    }
    const nextTimeline = baseProj.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, (s.time || 0) + duration) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: tm }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, tm.start_at_seconds + duration)
    queueLog('info', `Added image '${clip.name}' targeting ${tm.target_node_id || 'scene'} at ${tm.start_at_seconds.toFixed(2)}s`)
    const nextProj = {
      ...baseProj,
      media: [...(baseProj.media ?? []), clip],
      timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds },
    }
    return s.project ? { project: nextProj } : { project: nextProj, scene: baseProj.scene }
  }),
  // Update a timeline clip's 2D transform parameters
  updateClipTransform: ({ clipId, position, scale }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).map((t) => {
      if (!t.media || t.media.clip_id !== clipId) return t
      const m = t.media
      return {
        media: {
          ...m,
          position: position ? { x: position.x ?? m.position?.x ?? 0, y: position.y ?? m.position?.y ?? 0 } : (m.position ?? { x: 0, y: 0 }),
          scale: scale ? { x: scale.x ?? m.scale?.x ?? 1, y: scale.y ?? m.scale?.y ?? 1 } : (m.scale ?? { x: 1, y: 1 }),
        }
      }
    })
    return { project: { ...s.project, timeline: { ...(s.project.timeline || {}), tracks } } }
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
  setSelectedClip: (clipId) => set({ selectedClipId: clipId }),
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
  // Remove a clip from the timeline by id
  removeClip: (clipId) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).filter((t) => !(t.media && t.media.clip_id === clipId))
    const nextTl = { ...(s.project.timeline || {}), tracks }
    return { project: { ...s.project, timeline: nextTl }, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId }
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
}))

// Helper to enqueue a log entry without needing a store setter in scope
function queueLog(level, message) {
  try {
    const fn = useEditorStore.getState().addLog
    if (fn) fn({ level, message })
  } catch {}
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
