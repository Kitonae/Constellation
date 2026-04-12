// Scene graph mutation slice

import { createDefaultProject } from '../project/projectCodec.js'
import { queueLog } from './log.js'

export function createSceneSlice(set) {
  return {
    scene: null,
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
  }
}

// --- Scene graph helpers ---

function updateNode(node, id, fn) {
  if (node.id === id) return fn(node)
  if (!node.children?.length) return node
  return { ...node, children: node.children.map((c) => updateNode(c, id, fn)) }
}

export function findNode(nodes, id) {
  const stack = [...nodes]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.id === id) return n
    if (n.children?.length) stack.push(...n.children)
  }
  return null
}
