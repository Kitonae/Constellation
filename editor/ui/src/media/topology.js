// Topology — analogous to MF's IMFTopology (a DAG of pipeline nodes).
//
// A topology represents the media pipeline as a directed acyclic graph:
//   Source nodes  → produce media data (asset + clip placement)
//   Transform nodes → process data (effects, format conversion)
//   Output nodes  → consume data (render instructions)
//
// The renderer builds a topology from the current timeline state, then
// walks it to produce RenderItems. This replaces the hardcoded
// source→render path in computeRenderList() with an extensible graph.

import { getActiveClips, getClipSourceTime, getClipOpacity } from './timeline.js'
import { extFromUri, isVideo as isVideoAsset } from './asset.js'
import { resolveUriSync } from './uri.js'
import { effectsToTransforms, chainToCSS } from './transform.js'

const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'])

// --- Node types ---

export const NODE_SOURCE = 'source'
export const NODE_TRANSFORM = 'transform'
export const NODE_OUTPUT = 'output'

// --- ID generation ---

let _topoIdCounter = 0

function topoId(prefix) {
  return `${prefix}-${(++_topoIdCounter).toString(36)}`
}

// --- Topology factory ---

/**
 * Create an empty topology.
 * @returns {Topology}
 */
export function createTopology() {
  return {
    nodes: new Map(),
    edges: [],
  }
}

/**
 * Add a source node to the topology.
 * Wraps a media asset + clip placement + resolved source URL.
 *
 * @param {Topology} topo
 * @param {object} data - { asset, clip, src, mediaType, sourceTime, trackIndex }
 * @returns {string} node ID
 */
export function addSourceNode(topo, data) {
  const id = topoId('src')
  topo.nodes.set(id, { id, type: NODE_SOURCE, data })
  return id
}

/**
 * Add a transform node to the topology.
 * Wraps an ordered array of transforms (effect chain).
 *
 * @param {Topology} topo
 * @param {Transform[]} transforms
 * @returns {string} node ID
 */
export function addTransformNode(topo, transforms) {
  const id = topoId('tfm')
  topo.nodes.set(id, { id, type: NODE_TRANSFORM, data: { transforms } })
  return id
}

/**
 * Add an output node to the topology.
 * Wraps the final render properties (position, size, opacity, etc.).
 *
 * @param {Topology} topo
 * @param {object} data - render properties
 * @returns {string} node ID
 */
export function addOutputNode(topo, data) {
  const id = topoId('out')
  topo.nodes.set(id, { id, type: NODE_OUTPUT, data })
  return id
}

/**
 * Connect two nodes in the topology (directed edge: from → to).
 *
 * @param {Topology} topo
 * @param {string} fromId
 * @param {string} toId
 */
export function connectNodes(topo, fromId, toId) {
  topo.edges.push({ from: fromId, to: toId })
}

// --- Topology construction from timeline ---

/**
 * Build a topology from a timeline at a given presentation time.
 *
 * For each active clip, creates:
 *   source → [transform] → output
 *
 * If the clip has no effects, source connects directly to output
 * (the topology loader skips the transform node).
 *
 * @param {Timeline} timeline  - migrated timeline
 * @param {Map|object[]} assets - asset lookup (Map or array)
 * @param {number} time        - current presentation time
 * @param {object} [opts]
 * @returns {Topology}
 */
export function buildFromTimeline(timeline, assets, time, opts = {}) {
  const topo = createTopology()

  if (!timeline || !assets) return topo

  // Build asset lookup
  const assetMap = assets instanceof Map ? assets : new Map()
  if (Array.isArray(assets)) {
    for (const a of assets) assetMap.set(a.id, a)
  }

  const activeClips = getActiveClips(timeline, time, {
    skipOverlaps: opts.skipOverlaps ?? true,
    skipMuted: true,
  })

  for (const { clip, trackIndex } of activeClips) {
    const asset = assetMap.get(clip.assetId)
    if (!asset) continue

    const uri = asset.uri || ''
    const src = resolveUriSync(uri)

    const ext = extFromUri(uri) || extFromUri(asset.name || '')
    const isVideo = VIDEO_EXTS.has(ext) || isVideoAsset(asset)
    const mediaType = isVideo ? 'video' : (asset.type || 'image')

    const sourceTime = isVideo ? getClipSourceTime(clip, time) : 0

    // Source node
    const srcId = addSourceNode(topo, {
      asset,
      clip,
      src,
      mediaType,
      sourceTime,
      trackIndex,
    })

    // Transform node (only if clip has active effects)
    const transforms = effectsToTransforms(clip.effects)
    const hasActiveEffects = transforms.some(t => t.enabled)
    let lastId = srcId

    if (hasActiveEffects) {
      const tfmId = addTransformNode(topo, transforms)
      connectNodes(topo, srcId, tfmId)
      lastId = tfmId
    }

    // Output node (render properties)
    const transform = clip.transform || {}
    const opacity = getClipOpacity(clip, time)
    const filter = chainToCSS(transforms)

    const outId = addOutputNode(topo, {
      clipId: clip.id,
      assetId: clip.assetId,
      x: transform.x ?? 0,
      y: transform.y ?? 0,
      width: transform.width ?? 0,
      height: transform.height ?? 0,
      rotation: transform.rotation ?? 0,
      opacity,
      filter,
    })
    connectNodes(topo, lastId, outId)
  }

  return topo
}

// --- Topology walking ---

/**
 * Walk a topology and produce RenderItems.
 *
 * Traverses from output nodes backward through the graph, collecting
 * source data + transform results into flat RenderItem objects.
 *
 * @param {Topology} topo
 * @returns {RenderItem[]}
 */
export function walkTopology(topo) {
  if (!topo?.nodes?.size) return []

  // Build reverse adjacency: for each node, which nodes feed into it
  const inbound = new Map()
  for (const edge of topo.edges) {
    if (!inbound.has(edge.to)) inbound.set(edge.to, [])
    inbound.get(edge.to).push(edge.from)
  }

  // Find all output nodes
  const outputNodes = []
  for (const [, node] of topo.nodes) {
    if (node.type === NODE_OUTPUT) outputNodes.push(node)
  }

  const items = []

  for (const outNode of outputNodes) {
    // Walk backward to find the source node
    const sourceData = _findSource(topo, outNode.id, inbound)
    if (!sourceData) continue

    items.push({
      clipId: outNode.data.clipId,
      assetId: outNode.data.assetId,
      src: sourceData.src,
      mediaType: sourceData.mediaType,
      x: outNode.data.x,
      y: outNode.data.y,
      width: outNode.data.width,
      height: outNode.data.height,
      rotation: outNode.data.rotation,
      opacity: outNode.data.opacity,
      filter: outNode.data.filter,
      sourceTime: sourceData.sourceTime,
      trackIndex: sourceData.trackIndex,
      asset: sourceData.asset,
      clip: sourceData.clip,
    })
  }

  return items
}

/**
 * Walk backward from a node to find its source node data.
 * @private
 */
function _findSource(topo, nodeId, inbound) {
  const node = topo.nodes.get(nodeId)
  if (!node) return null
  if (node.type === NODE_SOURCE) return node.data

  const parents = inbound.get(nodeId)
  if (!parents?.length) return null

  // Recurse through first parent (linear chains for now)
  return _findSource(topo, parents[0], inbound)
}

/**
 * Get all nodes of a given type from a topology.
 * @param {Topology} topo
 * @param {string} type - NODE_SOURCE | NODE_TRANSFORM | NODE_OUTPUT
 * @returns {object[]}
 */
export function getNodesByType(topo, type) {
  const result = []
  for (const [, node] of topo.nodes) {
    if (node.type === type) result.push(node)
  }
  return result
}

/**
 * Get downstream nodes connected to a given node.
 * @param {Topology} topo
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getDownstream(topo, nodeId) {
  return topo.edges
    .filter(e => e.from === nodeId)
    .map(e => topo.nodes.get(e.to))
    .filter(Boolean)
}

/**
 * Get upstream nodes connected to a given node.
 * @param {Topology} topo
 * @param {string} nodeId
 * @returns {object[]}
 */
export function getUpstream(topo, nodeId) {
  return topo.edges
    .filter(e => e.to === nodeId)
    .map(e => topo.nodes.get(e.from))
    .filter(Boolean)
}
