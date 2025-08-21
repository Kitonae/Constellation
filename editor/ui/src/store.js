import { create } from 'zustand'
import { parseProject } from './utils/parseProject.js'

export const useEditorStore = create((set, get) => ({
  project: null,
  scene: null,
  time: 0,
  playing: false,
  selectedId: null,
  gizmoMode: 'translate',
  loadProject: (json) => {
    const proj = parseProject(json)
    set({ project: proj, scene: proj.scene, selectedId: null, time: 0 })
  },
  // Add a generic media clip to the project's media bin
  addMediaClip: ({ id, name, uri, duration_seconds }) => set((s) => {
    if (!s.project) return {}
    const clip = {
      id: id || `clip-${Math.random().toString(36).slice(2, 8)}`,
      name: name || 'Clip',
      uri,
      duration_seconds: duration_seconds ?? 10,
    }
    return { project: { ...s.project, media: [...(s.project.media ?? []), clip] } }
  }),
  // Insert an existing clip onto the timeline
  addClipToTimeline: ({ clipId, startAt, duration, targetNodeId }) => set((s) => {
    if (!s.project) return {}
    const clip = (s.project.media || []).find((m) => m.id === clipId)
    if (!clip) return {}
    const dur = duration ?? clip.duration_seconds ?? 10
    const target = targetNodeId || pickScreenTarget(s.scene, s.selectedId) || ''
    const tm = { target_node_id: target, clip_id: clipId, in_seconds: 0, out_seconds: dur, start_at_seconds: startAt ?? (s.time || 0) }
    const nextTimeline = s.project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, (s.time || 0) + dur) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: tm }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, tm.start_at_seconds + dur)
    return { project: { ...s.project, timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds } } }
  }),
  // Add an image media clip and a timeline track targeting a screen
  addImageToShow: ({ filePath, name, duration = 10 }) => set((s) => {
    if (!s.project) return {}
    const id = `img-${Math.random().toString(36).slice(2, 8)}`
    const clip = { id, name: name || id, uri: toFileUri(String(filePath)), duration_seconds: duration }
    // pick target screen: selected if it's a screen, otherwise first screen in scene
    const target = pickScreenTarget(s.scene, s.selectedId)
    const tm = {
      target_node_id: target ?? '',
      clip_id: id,
      in_seconds: 0,
      out_seconds: duration,
      start_at_seconds: s.time || 0,
    }
    const nextTimeline = s.project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, (s.time || 0) + duration) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: tm }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, tm.start_at_seconds + duration)
    return {
      project: {
        ...s.project,
        media: [...(s.project.media ?? []), clip],
        timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds },
      }
    }
  }),
  tick: (dt) => {
    if (!get().playing) return
    set((s) => ({ time: s.time + dt }))
  },
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  seek: (t) => set({ time: t }),
  setSelected: (id) => set({ selectedId: id }),
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
}))

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
