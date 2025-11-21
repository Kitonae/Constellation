import { useEditorStore } from '../store.js'

const opened = new Map()

export function hasOpenDisplays() {
  return opened.size > 0
}

export async function openDisplayWindow(screenId, width, height) {
  const label = `display-${screenId}`
  if (opened.has(label)) return opened.get(label)
  const rt = (typeof window !== 'undefined') ? (window.runtime || null) : null
  const w = Math.max(100, Math.floor(width))
  const h = Math.max(100, Math.floor(height))
  if (rt && typeof rt.EventsEmit === 'function') {
    try { rt.EventsEmit('display:open', { screenId, width: w, height: h }) } catch {}
  } else {
    try { const url = `/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`; window.open(url, label, `width=${w},height=${h},resizable=yes`) } catch {}
  }
  opened.set(label, { screenId, width, height })
  // After opening, push a snapshot
  try {
    const s = useEditorStore.getState()
    const wrapper = { project: s.project, scene: s.scene }
    if (rt && typeof rt.EventsEmit === 'function') {
      try { rt.EventsEmit('display:snapshot', { project: wrapper.project, scene: wrapper.scene, time: s.time || 0 }) } catch {}
    } else {
      try { window.dispatchEvent(new CustomEvent('display:snapshot', { detail: { project: wrapper.project, scene: wrapper.scene, time: s.time || 0 } })) } catch {}
    }
  } catch {}
  return opened.get(label)
}

export function closeDisplayWindow(screenId) {
  const label = `display-${screenId}`
  const rt = (typeof window !== 'undefined') ? (window.runtime || null) : null
  try {
    if (rt && typeof rt.EventsEmit === 'function') rt.EventsEmit('display:close', { screenId })
    else window.dispatchEvent(new CustomEvent('display:close', { detail: { screenId } }))
  } catch {}
  opened.delete(label)
}

export function broadcastToDisplays(event, payload) {
  const rt = (typeof window !== 'undefined') ? (window.runtime || null) : null
  try {
    if (rt && typeof rt.EventsEmit === 'function') rt.EventsEmit(event, payload)
    else window.dispatchEvent(new CustomEvent(event, { detail: payload }))
  } catch {}
}
