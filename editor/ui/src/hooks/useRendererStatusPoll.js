import { useEffect } from 'react'
import { useEditorStore } from '../store.js'

const INTERVAL_MS = 2000

/**
 * One poll for every renderer output, mounted once by App.
 *
 * The Inspector used to run this loop itself, per selected screen, so status
 * only existed while you happened to be looking at that screen — and the
 * status bar could not summarise outputs at all. The Go backend still owns
 * the renderer lifecycle; this only reads.
 */
export default function useRendererStatusPoll() {
  useEffect(() => {
    const getStatus = window.go?.main?.App?.GetRendererStatus
    if (typeof getStatus !== 'function') return
    let cancelled = false

    const tick = async () => {
      const { outputs, setOutputStatus } = useEditorStore.getState()
      const ids = Object.entries(outputs)
        .filter(([, o]) => o?.type === 'renderer')
        .map(([id]) => id)
      for (const id of ids) {
        if (cancelled) return
        try {
          const s = await getStatus(id)
          if (cancelled || !s) continue
          setOutputStatus(id, { state: s.state || 'stopped', fps: s.fps || 0, error: s.error || '' })
        } catch { /* the process may be mid-restart */ }
      }
    }

    tick()
    const timer = setInterval(tick, INTERVAL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
}
