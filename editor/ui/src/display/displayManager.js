import { GetFileServerPort } from '@bindings/app.js'

// screenId → { screenId, width, height, win }
const opened = new Map()

export function hasOpenDisplays() {
  return opened.size > 0
}

export function getDisplayWindow(screenId) {
  return opened.get(screenId)?.win ?? null
}

/**
 * Open (or reuse) the child window for a web screen and return its handle.
 *
 * Deliberately does *not* focus an already-open window: the caller used to
 * re-run this on every scene change, so every screen nudge stole focus from
 * the editor. Snapshot delivery is the DisplaySink's job, not this function's.
 */
export async function openDisplayWindow(screenId, width, height) {
  const existing = opened.get(screenId)
  if (existing?.win && !existing.win.closed) return existing.win

  const w = Math.max(100, Math.floor(width))
  const h = Math.max(100, Math.floor(height))

  let url = `/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`

  // Prefer the sidecar origin so the child window can load local media
  try {
    const port = await GetFileServerPort()
    if (port > 0) {
      url = `http://localhost:${port}/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`
    }
  } catch (e) {
    console.warn('Failed to get sidecar port, using relative URL', e)
  }

  const win = window.open(url, `display-${screenId}`, `width=${w},height=${h},resizable=yes`)
  if (!win) return null
  opened.set(screenId, { screenId, width: w, height: h, win })
  return win
}

export function closeDisplayWindow(screenId) {
  const entry = opened.get(screenId)
  opened.delete(screenId)
  if (!entry?.win || entry.win.closed) return
  try { entry.win.postMessage({ event: 'display:close', payload: { screenId } }, '*') } catch { }
}
