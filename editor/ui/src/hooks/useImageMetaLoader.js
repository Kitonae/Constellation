import { useEffect } from 'react'
import { resolveImageSrc, inlineFromUri } from '../components/MediaThumb.jsx'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg']

/**
 * Preloads image natural sizes for clip placements.
 * Skips video files. Falls back to inline base64 if asset protocol blocks access.
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
        const ext = String(clip.uri).split('?')[0].split('#')[0].split('.').pop().toLowerCase()
        if (VIDEO_EXTENSIONS.includes(ext)) continue
        const src = await resolveImageSrc(clip.uri)
        if (cancelled) return
        if (!src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: img.naturalWidth, h: img.naturalHeight, src } }))
            resolve()
          }
          img.onerror = async () => {
            try {
              const inlined = await inlineFromUri(clip.uri)
              if (inlined) {
                const probe = new Image()
                probe.onload = () => {
                  setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: probe.naturalWidth, h: probe.naturalHeight, src: inlined } }))
                  resolve()
                }
                probe.onerror = () => resolve()
                probe.src = inlined
                return
              }
            } catch { }
            resolve()
          }
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [placements, imageMeta, setImageMeta])
}
