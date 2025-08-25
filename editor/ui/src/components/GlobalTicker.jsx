import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store.js'
import { broadcastToDisplays, hasOpenDisplays } from '../display/displayManager.js'

export default function GlobalTicker() {
  const tick = useEditorStore((s) => s.tick)
  const rafRef = useRef(0)
  const lastRef = useRef(typeof performance !== 'undefined' ? performance.now() : Date.now())

  useEffect(() => {
    const loop = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const dt = Math.max(0, (now - lastRef.current) / 1000)
      lastRef.current = now
      tick(dt)
      // Throttle display updates: only when playing and at ~20fps
      try {
        const s = useEditorStore.getState()
        if (s.playing && hasOpenDisplays()) {
          if (!loop._lastEmitAt || now - loop._lastEmitAt > 50) {
            try { broadcastToDisplays('display:time', { time: s.time }) } catch {}
            loop._lastEmitAt = now
          }
        }
      } catch {}
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [tick])

  // When not playing, broadcast snapshots on seeks/time changes so displays stay in sync
  useEffect(() => {
    const unsub = useEditorStore.subscribe((s) => [s.time, s.playing], ([time, playing], [prevTime]) => {
      try {
        if (!playing && time !== prevTime && hasOpenDisplays()) {
          const st = useEditorStore.getState()
          broadcastToDisplays('display:snapshot', { project: st.project, scene: st.scene, time })
        }
      } catch {}
    })
    return () => { try { unsub() } catch {} }
  }, [])

  // When project/scene changes, push a full snapshot to displays if any are open
  useEffect(() => {
    const unsub = useEditorStore.subscribe((s) => [s.project, s.scene, s.time, s.playing], ([project, scene, time, playing], [prevProject, prevScene]) => {
      try {
        if (hasOpenDisplays() && (project !== prevProject || scene !== prevScene)) {
          broadcastToDisplays('display:snapshot', { project, scene, time })
        }
      } catch {}
    })
    return () => { try { unsub() } catch {} }
  }, [])

  return null
}
