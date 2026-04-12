import { useEffect } from 'react'
import { useEditorStore } from '../store.js'
import { getTimelineItemDuration, getTimelineItemStart } from '../project/projectCodec.js'

/**
 * Subscribes to store time changes and updates clip DOM visibility + video sync
 * at 60fps without triggering React re-renders. This is the hot-path animation code.
 *
 * @param {React.MutableRefObject<Map>} clipRefs - Map of clip ID -> React ref to DOM element
 * @param {React.MutableRefObject<Map>} videoRefs - Map of clip ID -> React ref to video element
 * @param {Array} allTimelineItems - All non-overlapping timeline items
 * @param {Function} setTimeDisplay - Throttled state setter for UI timecode display
 * @param {React.MutableRefObject<number>} lastTimeUiRef - Last UI update timestamp
 */
export default function useClipVisibilitySync(clipRefs, videoRefs, allTimelineItems, setTimeDisplay, lastTimeUiRef) {
  useEffect(() => {
    const unsub = useEditorStore.subscribe((state) => {
      const t = state.time || 0
      const now = performance.now()
      if (now - lastTimeUiRef.current > 125) { lastTimeUiRef.current = now; setTimeDisplay(t) }
      // Update clip visibility via direct DOM
      clipRefs.current.forEach((ref, id) => {
        const el = ref.current
        if (!el) return
        const m = allTimelineItems.find(mm => mm.id === id)
        if (!m) return
        const start = getTimelineItemStart(m)
        const dur = getTimelineItemDuration(m)
        const active = t >= start && t <= start + dur
        el.style.display = active ? 'flex' : 'none'
      })
      // Video playback in viewport removed — native renderer handles video.
      // videoRefs kept for API compatibility but no longer synced.
    })
    return () => { try { unsub() } catch { } }
  }, [allTimelineItems, clipRefs, videoRefs, setTimeDisplay, lastTimeUiRef])
}
