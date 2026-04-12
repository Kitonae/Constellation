import { useEffect } from 'react'
import { useEditorStore, getMediaSession } from '../store.js'

/**
 * GlobalTicker — lightweight watchdog component.
 *
 * All playback timing and output fanout is handled by MediaSession and its
 * sinks (NativeSink for Go/DX12, broadcastFn for web display windows).
 * This component only runs the import-stuck watchdog on a slow RAF loop.
 */
export default function GlobalTicker() {
  // Ensure the MediaSession singleton is initialized early
  useEffect(() => { getMediaSession() }, [])

  // Watchdog: reset imports that appear stuck (> 15s with no progress)
  useEffect(() => {
    let rafId = 0
    let lastCheck = 0

    const loop = () => {
      const now = performance.now()
      // Check every ~2 seconds, not every frame
      if (now - lastCheck > 2000) {
        lastCheck = now
        try { useEditorStore.getState().resetImportingIfStuck?.() } catch { }
      }
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return null
}
