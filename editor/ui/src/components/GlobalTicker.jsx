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
        // Import watchdog
        try { s.resetImportingIfStuck && s.resetImportingIfStuck() } catch { }
        if (s.playing) {
          if (hasOpenDisplays()) {
            if (!loop._lastEmitAt || now - loop._lastEmitAt > 50) {
              try { broadcastToDisplays('display:time', { time: s.time }) } catch { }
              loop._lastEmitAt = now
            }
          }
          // Push time to native renderers via Go SSE
          if (!loop._lastRendererPush || now - loop._lastRendererPush > 16) {
            try { window.go?.main?.App?.PushTime(s.time) } catch { }
            loop._lastRendererPush = now
          }
        }
      } catch { }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [tick])

  // When not playing, broadcast snapshots on seeks/time changes so displays stay in sync
  useEffect(() => {
    const unsub = useEditorStore.subscribe((s) => [s.time, s.playing], ([time, playing], [prevTime]) => {
      try {
        if (!playing && time !== prevTime) {
          if (hasOpenDisplays()) {
            const st = useEditorStore.getState()
            const projToSend = st.project ? { ...st.project, media: undefined } : null
            broadcastToDisplays('display:snapshot', { project: projToSend, scene: st.scene, time })
          }
          // Push seek time to native renderers
          try { window.go?.main?.App?.PushTime(time) } catch { }
        }
      } catch { }
    })
    return () => { try { unsub() } catch { } }
  }, [])

  return null
}
