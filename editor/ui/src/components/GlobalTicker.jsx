import { useEffect, useRef } from 'react'
import { useEditorStore, getMediaSession } from '../store.js'
import { broadcastToDisplays, hasOpenDisplays } from '../display/displayManager.js'

export default function GlobalTicker() {
  const tick = useEditorStore((s) => s.tick)
  const lastRendererPush = useRef(0)

  // Subscribe to PresentationClock for authoritative timing
  useEffect(() => {
    const session = getMediaSession()
    const clock = session.getClock()

    const unsub = clock.subscribe({
      onTick(time) {
        // Push time to native renderers at ~60fps
        const now = performance.now()
        if (now - lastRendererPush.current > 16) {
          try { window.go?.main?.App?.PushTime(time) } catch { }
          lastRendererPush.current = now
        }
      },
    })

    return unsub
  }, [])

  // Fallback RAF loop for store.tick (drives time when session isn't playing,
  // handles import watchdog, and display window broadcasts)
  useEffect(() => {
    let rafId = 0
    let lastT = performance.now()
    let lastEmit = 0

    const loop = () => {
      const now = performance.now()
      const dt = Math.max(0, (now - lastT) / 1000)
      lastT = now
      tick(dt)

      try {
        const s = useEditorStore.getState()
        try { s.resetImportingIfStuck && s.resetImportingIfStuck() } catch { }

        // Broadcast to web display windows
        if (s.playing && hasOpenDisplays()) {
          if (now - lastEmit > 50) {
            try { broadcastToDisplays('display:time', { time: s.time }) } catch { }
            lastEmit = now
          }
        }

        // Always push time to native renderers (covers paused scrubbing)
        if (now - lastRendererPush.current > 16) {
          try { window.go?.main?.App?.PushTime(s.time) } catch { }
          lastRendererPush.current = now
        }
      } catch { }

      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
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
          try { window.go?.main?.App?.PushTime(time) } catch { }
        }
      } catch { }
    })
    return () => { try { unsub() } catch { } }
  }, [])

  return null
}
