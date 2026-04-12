import { useEffect } from 'react'
import { resolveImageSrc } from '../components/MediaThumb.jsx'
import { getVideoMetadata, resolveFileUrl } from '../utils/videoUtils.js'
import { getTimelineItemAssetId } from '../project/projectCodec.js'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg']

/**
 * Preloads image/video natural sizes for clip placements.
 * For videos, probes dimensions via a hidden <video> element.
 * @param {Array} placements - Array of { tm, clip } objects
 * @param {Object} imageMeta - Current image metadata state { [clipId]: { w, h, src } }
 * @param {Function} setImageMeta - State setter for image metadata
 */
export default function useImageMetaLoader(placements, imageMeta, setImageMeta) {
  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of placements) {
        const assetId = getTimelineItemAssetId(tm)
        if (!clip?.uri || imageMeta[assetId]) continue
        const uriStr = String(clip.uri)
        const extFromUri = uriStr.startsWith('blob:') || uriStr.startsWith('data:') ? '' : uriStr.split('?')[0].split('#')[0].split('.').pop().toLowerCase()
        const ext = extFromUri || String(clip.name || '').split('.').pop().toLowerCase()
        if (VIDEO_EXTENSIONS.includes(ext)) {
          // Probe video dimensions
          try {
            const meta = await getVideoMetadata(clip.uri)
            if (cancelled) return
            const videoSrc = resolveFileUrl(clip.uri)
            setImageMeta((m) => ({ ...m, [assetId]: { w: meta.width || 1920, h: meta.height || 1080, src: videoSrc } }))
          } catch {
            if (cancelled) return
            // Fallback to 1920x1080 so the clip isn't invisible
            setImageMeta((m) => ({ ...m, [assetId]: { w: 1920, h: 1080, src: null } }))
          }
          continue
        }
        const src = await resolveImageSrc(clip.uri)
        if (cancelled) return
        if (!src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            setImageMeta((m) => ({ ...m, [assetId]: { w: img.naturalWidth, h: img.naturalHeight, src } }))
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
