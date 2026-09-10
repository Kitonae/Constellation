import { useEffect } from 'react'
import { resolveImageSrc } from '../components/MediaThumb.jsx'
import { getVideoMetadata, resolveFileUrl } from '../utils/videoUtils.js'
import { extFromUri, isVideoName } from '../media/asset.js'

/**
 * Preloads image/video natural sizes for clip placements.
 * For videos, probes dimensions via a hidden <video> element.
 *
 * @param {Array} placements - Array of { tm, clip } objects
 * @param {Object} imageMeta - Current image metadata state { [clipId]: { w, h, src } }
 * @param {Function} setImageMeta - State setter for image metadata
 */
export default function useImageMetaLoader(placements, imageMeta, setImageMeta) {
  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of placements) {
        if (!clip?.uri || imageMeta[tm.clip_id]) continue
        const uriStr = String(clip.uri)
        const ext = extFromUri(uriStr) || extFromUri(clip.name || '')
        if (isVideoName('x.' + ext)) {
          // Probe video dimensions
          try {
            const meta = await getVideoMetadata(clip.uri)
            if (cancelled) return
            const videoSrc = resolveFileUrl(clip.uri)
            setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: meta.width || 1920, h: meta.height || 1080, src: videoSrc } }))
          } catch {
            if (cancelled) return
            // Fallback to 1920x1080 so the clip isn't invisible
            setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: 1920, h: 1080, src: null } }))
          }
          continue
        }
        const src = await resolveImageSrc(clip.uri)
        if (cancelled) return
        if (!src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: img.naturalWidth, h: img.naturalHeight, src } }))
            resolve()
          }
          img.onerror = () => resolve()
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [placements, imageMeta, setImageMeta])
}
