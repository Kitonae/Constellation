import { useEffect } from 'react'
import { resolveUriSync } from '../media/uri.js'
import { resolveFileUrl } from '../utils/videoUtils.js'
import { getNaturalSize } from '../media/naturalSize.js'
import { assetKind } from '../media/kind.js'

/**
 * Preloads natural sizes and render sources for the 2D viewport's clips.
 *
 * The probing itself lives in `media/naturalSize.js` (cached and
 * concurrency-limited) — this hook only maps the result into the viewport's
 * `{ [clipId]: { w, h, src } }` shape and keeps the 1920x1080 fallback so a
 * clip whose file will not decode is still visible and draggable.
 *
 * @param {Array} placements - Array of { tm, clip } objects
 * @param {Object} imageMeta - Current metadata state
 * @param {Function} setImageMeta - State setter
 */
export default function useImageMetaLoader(placements, imageMeta, setImageMeta) {
  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of placements) {
        if (!clip?.uri || imageMeta[tm.clip_id]) continue
        const kind = assetKind(clip.uri) === 'unknown' ? assetKind(clip.name || '') : assetKind(clip.uri)
        const size = await getNaturalSize(clip.uri, kind)
        if (cancelled) return
        const src = kind === 'video' ? resolveFileUrl(clip.uri) : resolveUriSync(clip.uri)
        if (kind === 'video') {
          setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: size?.w || 1920, h: size?.h || 1080, src: src || null } }))
          continue
        }
        if (!size || !src) continue
        setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: size.w, h: size.h, src } }))
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [placements, imageMeta, setImageMeta])
}
