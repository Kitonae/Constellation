import { WebviewWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { useEditorStore } from '../store.js'

const opened = new Map()

export function hasOpenDisplays() {
  return opened.size > 0
}

export async function openDisplayWindow(screenId, width, height) {
  const label = `display-${screenId}`
  if (opened.has(label)) return opened.get(label)
  try {
    const existing = WebviewWindow.getByLabel(label)
    if (existing) { opened.set(label, existing); return existing }
  } catch {}
  const url = `/?display=1&screenId=${encodeURIComponent(screenId)}&w=${width}&h=${height}`
  const win = new WebviewWindow(label, {
    url,
    width: Math.max(100, Math.floor(width)),
    height: Math.max(100, Math.floor(height)),
    resizable: true,
    title: `Display ${screenId}`,
  })
  opened.set(label, win)
  // Remove from registry when window is destroyed/closed
  try {
    const unlistenDestroyed = await win.listen('tauri://destroyed', () => {
      opened.delete(label)
      try { unlistenDestroyed && unlistenDestroyed() } catch {}
    })
  } catch {}
  // When the window is created, push a snapshot so it has initial content
  try {
    const unlisten = await win.listen('tauri://created', () => {
      try {
        const s = useEditorStore.getState()
        const p = emit('display:snapshot', { project: s.project, scene: s.scene, time: s.time })
        if (p && typeof p.then === 'function') p.catch(() => {})
      } catch {}
      try { unlisten && unlisten() } catch {}
    })
  } catch {}
  return win
}

export function closeDisplayWindow(screenId) {
  const label = `display-${screenId}`
  let win = opened.get(label)
  if (!win) {
    try { win = WebviewWindow.getByLabel(label) } catch { win = null }
  }
  if (win && typeof win.close === 'function') {
    try {
      const p = win.close()
      if (p && typeof p.then === 'function') {
        p.catch(() => {})
      }
    } catch {}
  }
  opened.delete(label)
}

export function broadcastToDisplays(event, payload) {
  // In Tauri v1, emit() broadcasts to all windows
  try {
    const p = emit(event, payload)
    if (p && typeof p.then === 'function') p.catch(() => {})
  } catch {}
}
