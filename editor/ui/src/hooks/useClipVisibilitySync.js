import { useEffect, useMemo } from 'react'
import { getMediaSession } from '../store.js'
import { computeFadeOpacity } from '../utils/mediaUtils.js'

/**
 * Drives clip visibility and fade straight from the PresentationClock,
 * writing to the DOM without re-rendering React.
 *
 * Fade is written as the `--fade` custom property, which the clip's opacity
 * reads. The stage used to compute fade in render from the store's time,
 * which nothing updates as the clock runs, so a clip with a two-second fade
 * simply popped in at full opacity; the Opacity property worked because
 * editing it re-rendered the stage.
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
      const fades = (m.fade_in > 0) || (m.fade_out > 0)
      map.set(m.id, { start, end: start + dur, item: m, fades })
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
        const active = t >= span.start && t <= span.end
        el.style.display = active ? 'flex' : 'none'
        // Only clips that actually fade are written every tick; the rest
        // keep the value React rendered, which already includes opacity.
        if (active && span.fades) el.style.setProperty('--fade', String(computeFadeOpacity(span.item, t)))
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
