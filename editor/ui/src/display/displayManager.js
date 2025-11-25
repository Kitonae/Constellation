import { useEditorStore } from '../store.js'
import { GetFileServerPort } from '../wails/wailsjs/go/main/App.js'

const opened = new Map()

export function hasOpenDisplays() {
  return opened.size > 0
}

export async function openDisplayWindow(screenId, width, height) {
  const label = `display-${screenId}`
  if (opened.has(label)) {
    const existing = opened.get(label)
    if (existing.win && !existing.win.closed) {
      existing.win.focus()
      return existing
    }
  }
  
  const w = Math.max(100, Math.floor(width))
  const h = Math.max(100, Math.floor(height))
  
  let url = `/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`
  
  // Try to get sidecar port for external window
  try {
    const port = await GetFileServerPort()
    if (port > 0) {
      url = `http://localhost:${port}/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`
    }
  } catch (e) {
    console.warn('Failed to get sidecar port, using relative URL', e)
  }

  const win = window.open(url, label, `width=${w},height=${h},resizable=yes`)
  
  opened.set(label, { screenId, width, height, win })
  
  // After opening, push a snapshot via postMessage
  setTimeout(() => {
    try {
      const s = useEditorStore.getState()
      broadcastToDisplays('display:snapshot', { project: s.project, scene: s.scene, time: s.time || 0 })
    } catch {}
  }, 500)
  
  return opened.get(label)
}

export function closeDisplayWindow(screenId) {
  const label = `display-${screenId}`
  broadcastToDisplays('display:close', { screenId })
  opened.delete(label)
}

export function broadcastToDisplays(event, payload) {
  // Use postMessage to all opened windows
  for (const [label, data] of opened.entries()) {
    if (data.win && !data.win.closed) {
      try {
        data.win.postMessage({ event, payload }, '*')
      } catch (e) {
        console.error('Failed to postMessage to', label, e)
      }
    }
  }
}
