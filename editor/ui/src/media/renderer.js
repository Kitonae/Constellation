// Render Pipeline — analogous to MF's Topology Loader (partial → full topology resolution).
//
// Pure function that takes timeline state + assets + time and produces a list
// of RenderItems ready for DOM rendering. Consumed by both Viewport2D and
// DisplayWindow, eliminating the ~150 lines of duplicated render logic.

import { getActiveClips, getClipSourceTime, getClipOpacity, getClipFilterString } from './timeline.js'
import { isVideo as isVideoAsset, extFromUri, getAssetDuration } from './asset.js'
import { resolveUriSync } from './uri.js'

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

const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'])

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

  const assetMap = new Map()
  for (const a of assets) {
    assetMap.set(a.id, a)
  }

  const activeClips = getActiveClips(timeline, time, {
    skipOverlaps: opts.skipOverlaps ?? true,
    skipMuted: true,
  })

  const items = []

  for (const { clip, trackIndex } of activeClips) {
    const asset = assetMap.get(clip.assetId)
    if (!asset) continue

    // Resolve URI to a playable URL (sync — for frame-by-frame rendering)
    const uri = asset.uri || ''
    const src = resolveUriSync(uri)

    // Determine media type
    const ext = extFromUri(uri) || extFromUri(asset.name || '')
    const isVideo = VIDEO_EXTS.has(ext) || isVideoAsset(asset)
    const mediaType = isVideo ? 'video' : (asset.type || 'image')

    // Transform
    const transform = clip.transform || {}
    const x = transform.x ?? 0
    const y = transform.y ?? 0
    const width = transform.width ?? 0   // 0 = natural
    const height = transform.height ?? 0 // 0 = natural
    const rotation = transform.rotation ?? 0

    // Appearance
    const opacity = getClipOpacity(clip, time)
    const filter = getClipFilterString(clip)

    // Source time (for video seeking)
    const sourceTime = isVideo ? getClipSourceTime(clip, time) : 0

    items.push({
      clipId: clip.id,
      assetId: clip.assetId,
      src,
      mediaType,
      x,
      y,
      width,
      height,
      rotation,
      opacity,
      filter,
      sourceTime,
      trackIndex,
      asset,
      clip,
    })
  }

  return items
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
