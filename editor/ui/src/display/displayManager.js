import { WebviewWindow } from '@tauri-apps/api/window'

const opened = new Map()

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
  return win
}

export function closeDisplayWindow(screenId) {
  const label = `display-${screenId}`
  const win = opened.get(label) || WebviewWindow.getByLabel(label)
  if (win) {
    try { win.close() } catch {}
  }
  opened.delete(label)
}

