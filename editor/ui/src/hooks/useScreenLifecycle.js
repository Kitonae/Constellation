import { useEffect, useRef } from 'react'
import { useEditorStore, getMediaSession } from '../store.js'
import { openDisplayWindow, closeDisplayWindow } from '../display/displayManager.js'

export function useScreenLifecycle() {
  const scene = useEditorStore((s) => s.scene)
  const addLog = useEditorStore((s) => s.addLog)
  const prevScreensRef = useRef(new Map())

  useEffect(() => {
    const roots = scene?.roots || []
    const currentScreens = new Map()

    for (const n of roots) {
      if (n.kind?.type === 'screen') {
        const enabled = (n.kind?.enabled ?? true)
        const screenType = n.kind?.screenType || 'web'
        const px = n.kind?.pixels?.[0] || 0
        const py = n.kind?.pixels?.[1] || 0
        currentScreens.set(n.id, { screenType })
        if (enabled && px > 0 && py > 0) {
          if (screenType === 'web') {
            openDisplayWindow(n.id, px, py)
          } else if (screenType === 'renderer') {
            window.go?.main?.App?.OpenRendererScreen(n.id, px, py)
              ?.catch(e => { console.error('Failed to open renderer screen:', e); addLog({ level: 'error', message: `Renderer launch failed: ${e}` }) })
          }
        } else {
          if (screenType === 'web') {
            closeDisplayWindow(n.id)
          } else if (screenType === 'renderer') {
            window.go?.main?.App?.CloseRendererScreen(n.id)?.catch(e => console.warn('CloseRendererScreen:', e))
          }
        }
      }
    }

    // Close screens that were removed from the scene
    for (const [id, prev] of prevScreensRef.current) {
      if (!currentScreens.has(id)) {
        if (prev.screenType === 'web') {
          closeDisplayWindow(id)
        } else if (prev.screenType === 'renderer') {
          window.go?.main?.App?.CloseRendererScreen(id)?.catch(e => console.warn('CloseRendererScreen:', e))
        }
      }
    }
    prevScreensRef.current = currentScreens
    try { getMediaSession().broadcastSnapshot() } catch { }
  }, [scene, addLog])
}
