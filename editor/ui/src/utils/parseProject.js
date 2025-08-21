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
    kind: null
  }
  if (n.screen) node.kind = { type: 'screen', pixels: [n.screen.pixels_x, n.screen.pixels_y] }
  if (n.light) node.kind = { type: 'light', light: n.light }
  if (n.camera) node.kind = { type: 'camera', cam: n.camera }
  if (n.mesh) node.kind = { type: 'mesh', mesh: n.mesh }
  return node
}

