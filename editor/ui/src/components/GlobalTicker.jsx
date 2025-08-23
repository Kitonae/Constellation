import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store.js'
import { broadcastToDisplays } from '../display/displayManager.js'

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
        if (s.playing) {
          if (!loop._lastEmitAt || now - loop._lastEmitAt > 50) {
            try { broadcastToDisplays('display:snapshot', { project: s.project, scene: s.scene, time: s.time }) } catch {}
            loop._lastEmitAt = now
          }
        }
      } catch {}
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [tick])

  return null
}
