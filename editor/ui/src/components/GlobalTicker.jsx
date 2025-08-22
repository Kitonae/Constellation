import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store.js'
import { emit } from '@tauri-apps/api/event'

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
      // Emit snapshot for display windows
      try {
        const s = useEditorStore.getState()
        const payload = { project: s.project, scene: s.scene, time: s.time }
        emit('display:snapshot', payload)
      } catch {}
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [tick])

  return null
}
