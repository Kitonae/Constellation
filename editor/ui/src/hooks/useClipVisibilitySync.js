import { useEffect, useMemo } from 'react'
import { getMediaSession } from '../store.js'

/**
 * Drives clip visibility straight from the PresentationClock, writing to the
 * DOM without re-rendering React.
 *
 * It used to also drive a throttled timecode state setter for the 2D
 * viewport, but that value was never rendered anywhere - pure re-render
 * churn at 8Hz.
 *
 * Previously this subscribed to the whole zustand store, so it also fired on
 * unrelated changes such as log entries, and did a linear `find` per clip on
 * every tick. Now it only sees clock ticks and looks clips up in a Map built
 * once per timeline change.
 *
 * @param {React.MutableRefObject<Map>} clipRefs - clip id -> React ref to DOM element
 * @param {React.MutableRefObject<Map>} videoRefs - clip id -> React ref to video element
 * @param {Array} allTimelineItems - All non-overlapping timeline items
 */
export default function useClipVisibilitySync(clipRefs, videoRefs, allTimelineItems) {
  const spans = useMemo(() => {
    const map = new Map()
    for (const m of allTimelineItems) {
      if (!m?.id) continue
      const start = Number(m.start ?? m.start_at_seconds) || 0
      const dur = Math.max(0, Number(m.duration ?? ((m.out_seconds - m.in_seconds) || 0)) || 0)
      map.set(m.id, { start, end: start + dur })
    }
    return map
  }, [allTimelineItems])

  useEffect(() => {
    const apply = (t = 0) => {
      clipRefs.current.forEach((ref, id) => {
        const el = ref.current
        if (!el) return
        const span = spans.get(id)
        if (!span) return
        el.style.display = (t >= span.start && t <= span.end) ? 'flex' : 'none'
      })
      // Video playback in the viewport is the native renderer's job;
      // videoRefs is kept for API compatibility but not synced here.
    }
    const clock = getMediaSession().getClock()
    const unsub = clock.subscribe({ onTick: apply, onSeek: apply, onStop: () => apply(0) })
    apply(clock.getTime())
    return () => { try { unsub() } catch { } }
  }, [spans, clipRefs, videoRefs])
}
