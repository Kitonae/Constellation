// Converts a show document into the editor's runtime model.
//
// NOTE ON THE DATA MODEL: the editor (store, Timeline, Viewport2D, Inspector)
// and the native renderer both consume the *legacy* timeline shape
// (`tracks[].media[]`, `duration_seconds`, `media[].duration_seconds`).
// The newer Track/Clip model lives in `media/timeline.js` and is applied
// on the fly by `computeRenderList`. Migrating here would orphan every clip,
// so `parseProject` deliberately passes media and timeline through unchanged.
//
// NOTE ON FIDELITY: everything this function does not interpret is carried
// through untouched, because what it returns is what gets saved. Rebuilding
// each object from named fields silently dropped whatever this build had no
// opinion about -- scene materials and meshes, and, more visibly, a screen's
// `kind.output` placement, so reopening a show scattered its outputs back
// onto the primary display. The shell validates and migrates the document
// before it arrives here; this only adapts it to the editor's shapes.

export function parseProject(json) {
  const project = json?.project ?? json ?? {}
  return {
    ...project,
    id: project.id,
    name: project.name,
    scene: parseScene(project.scene),
    media: project.media ?? [],
    timeline: project.timeline ?? null,
  }
}

function parseScene(scene) {
  if (!scene) return { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
  return {
    ...scene,
    id: scene.id,
    name: scene.name,
    roots: (scene.roots ?? []).map(parseNode),
  }
}

function parseNode(n) {
  const node = {
    ...n,
    id: n.id,
    name: n.name,
    transform: n.transform,
    children: (n.children ?? []).map(parseNode),
    kind: null,
  }
  // New schema: node.kind with type discriminator
  if (n.kind?.type) {
    const k = n.kind
    switch (k.type) {
      case 'screen':
        node.kind = normalizeScreenKind(k)
        break
      case 'light':
        node.kind = { ...k, type: 'light', light: k.light }
        break
      case 'camera':
        node.kind = { ...k, type: 'camera', cam: k.cam ?? k.camera }
        break
      case 'mesh':
        node.kind = { ...k, type: 'mesh', mesh: k.mesh }
        break
      default:
        // Pass through unknown kinds to avoid data loss
        node.kind = k
        break
    }
  } else {
    // Legacy schema: the kind lived in a sibling key. Convert it and drop the
    // old key, so a document saved from here has one shape rather than both.
    if (n.screen) {
      node.kind = normalizeScreenKind({
        ...n.screen,
        type: 'screen',
        pixels: [n.screen.pixels_x, n.screen.pixels_y],
      })
      delete node.kind.pixels_x
      delete node.kind.pixels_y
      delete node.screen
    }
    if (n.light) { node.kind = { type: 'light', light: n.light }; delete node.light }
    if (n.camera) { node.kind = { type: 'camera', cam: n.camera }; delete node.camera }
    if (n.mesh) { node.kind = { type: 'mesh', mesh: n.mesh }; delete node.mesh }
  }
  return node
}

/**
 * The three fields every consumer of a screen reads without checking, plus
 * whatever else the document carried -- notably `output`, the desktop
 * placement the Output panel writes.
 */
function normalizeScreenKind(k) {
  return {
    ...k,
    type: 'screen',
    screenType: k.screenType || 'web',
    pixels: Array.isArray(k.pixels) ? [k.pixels[0] | 0, k.pixels[1] | 0] : [0, 0],
    enabled: k.enabled ?? true,
  }
}
