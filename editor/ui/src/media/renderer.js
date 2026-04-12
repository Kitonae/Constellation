// Render Pipeline — analogous to MF's Topology Loader (partial → full topology resolution).
//
// Pure function that takes timeline state + assets + time and produces a list
// of RenderItems ready for DOM rendering. Consumed by both Viewport2D and
// DisplayWindow, eliminating the ~150 lines of duplicated render logic.
//
// Internally builds a topology (DAG of source → transform → output nodes)
// and walks it to produce the render list. The topology abstraction enables
// future extensibility (compositors, format converters, WebGL effects).

import { migrateTimeline } from './timeline.js'
import { buildFromTimeline, walkTopology } from './topology.js'

/**
 * @typedef {object} RenderItem
 * @property {string} clipId        - TimelineClip.id
 * @property {string} assetId       - MediaAsset.id
 * @property {string} src           - resolved playable URL
 * @property {'image'|'video'|'audio'|'unknown'} mediaType
 * @property {number} x             - position X (pixels from center)
 * @property {number} y             - position Y (pixels from center)
 * @property {number} width         - display width (0 = natural)
 * @property {number} height        - display height (0 = natural)
 * @property {number} rotation      - degrees
 * @property {number} opacity       - 0-1 (includes fade computation)
 * @property {string} filter        - CSS filter string
 * @property {number} sourceTime    - for videos: current time in source media
 * @property {number} trackIndex    - which track this came from
 * @property {object} asset         - reference to the full MediaAsset object
 * @property {object} clip          - reference to the full TimelineClip object
 */

/**
 * Compute the list of items to render at the given time.
 *
 * This is the "topology resolution" step — it takes the abstract timeline model
 * and resolves it into concrete render instructions.
 *
 * @param {object} timeline - Timeline object (new or legacy format)
 * @param {object[]} assets - Array of MediaAsset objects (or legacy clips)
 * @param {number} time     - Current presentation time in seconds
 * @param {object} [opts]
 * @param {boolean} [opts.skipOverlaps=true]
 * @returns {RenderItem[]}
 */
export function computeRenderList(timeline, assets, time, opts = {}) {
  if (!timeline || !assets) return []

  // Auto-migrate legacy format (tracks[].media[]) → new format (tracks[].clips[])
  const migrated = migrateTimeline(timeline)

  // Build a topology from the timeline state, then walk it to produce RenderItems.
  // This replaces the hardcoded source→render path with an extensible DAG.
  const topo = buildFromTimeline(migrated, assets, time, {
    skipOverlaps: opts.skipOverlaps ?? true,
  })

  return walkTopology(topo)
}

/**
 * Compute pixel-space layout for a RenderItem within a viewport.
 *
 * Converts the abstract (x, y, width, height) into absolute pixel coordinates
 * for a given viewport size, suitable for CSS positioning.
 *
 * @param {RenderItem} item
 * @param {number} viewportW - viewport width in pixels
 * @param {number} viewportH - viewport height in pixels
 * @param {object} [naturalSize] - { w, h } natural pixel dimensions of the media
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function computeItemLayout(item, viewportW, viewportH, naturalSize) {
  const baseW = naturalSize?.w || 100
  const baseH = naturalSize?.h || 100
  const w = Math.max(2, (item.width > 0) ? item.width : baseW)
  const h = Math.max(2, (item.height > 0) ? item.height : baseH)

  const cx = viewportW / 2
  const cy = viewportH / 2

  return {
    left: cx + (item.x || 0) - w / 2,
    top: cy - (item.y || 0) - h / 2, // Y is inverted (positive = up)
    width: w,
    height: h,
  }
}

/**
 * Compute pixel-space layout for a RenderItem within a 2D stage viewport
 * that has zoom/pan transforms.
 *
 * @param {RenderItem} item
 * @param {object} center - { x, y } center of the stage in content pixels
 * @param {number} ratio  - zoom ratio (zoom / Z_NEUTRAL)
 * @param {object} [naturalSize] - { w, h }
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function computeStageItemLayout(item, center, ratio, naturalSize) {
  const baseW = naturalSize?.w || 100
  const baseH = naturalSize?.h || 100
  const targetWpx = (item.width > 0) ? item.width : baseW
  const targetHpx = (item.height > 0) ? item.height : baseH
  const w = Math.max(2, targetWpx * ratio)
  const h = Math.max(2, targetHpx * ratio)

  return {
    left: center.x + (item.x || 0) * ratio - w / 2,
    top: center.y - (item.y || 0) * ratio - h / 2,
    width: w,
    height: h,
  }
}
