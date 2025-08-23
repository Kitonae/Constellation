// Converts editor JSON (examples/scene.example.json) into a simplified runtime model

export function parseProject(json) {
  const project = json.project ?? json
  const scene = project.scene
  return {
    id: project.id,
    name: project.name,
    scene: parseScene(scene),
    media: project.media ?? [],
    timeline: project.timeline ?? null
  }
}

function parseScene(scene) {
  return {
    id: scene.id,
    name: scene.name,
    roots: (scene.roots ?? []).map(parseNode)
  }
}

function parseNode(n) {
  const t = n.transform
  const node = {
    id: n.id,
    name: n.name,
    transform: t,
    children: (n.children ?? []).map(parseNode),
    kind: null,
  }
  // New schema: node.kind with type discriminator
  if (n.kind?.type) {
    const k = n.kind
    switch (k.type) {
      case 'screen':
        node.kind = {
          type: 'screen',
          pixels: Array.isArray(k.pixels) ? [k.pixels[0] | 0, k.pixels[1] | 0] : [0, 0],
          enabled: k.enabled ?? true,
        }
        break
      case 'light':
        node.kind = { type: 'light', light: k.light }
        break
      case 'camera':
        node.kind = { type: 'camera', cam: k.cam ?? k.camera }
        break
      case 'mesh':
        node.kind = { type: 'mesh', mesh: k.mesh }
        break
      default:
        // Pass through unknown kinds to avoid data loss
        node.kind = k
        break
    }
  } else {
    // Legacy schema compatibility
    if (n.screen) node.kind = { type: 'screen', pixels: [n.screen.pixels_x, n.screen.pixels_y], enabled: n.screen.enabled ?? true }
    if (n.light) node.kind = { type: 'light', light: n.light }
    if (n.camera) node.kind = { type: 'camera', cam: n.camera }
    if (n.mesh) node.kind = { type: 'mesh', mesh: n.mesh }
  }
  return node
}
