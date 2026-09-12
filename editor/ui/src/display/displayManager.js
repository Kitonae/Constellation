import { GetFileServerPort, GetFileServerToken } from '@bindings/app.js'
import { getCachedMonitors } from '../output/monitors.js'
import { toLogicalPosition, monitorFor } from '../output/placement.js'

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
export async function openDisplayWindow(screenId, width, height, place = null) {
  const existing = opened.get(screenId)
  if (existing?.win && !existing.win.closed) return existing.win

  const w = Math.max(100, Math.floor(width))
  const h = Math.max(100, Math.floor(height))

  // `place` is physical desktop pixels (the Output panel's space); the
  // window features want logical ones, sized for the display it lands on.
  let features = `width=${w},height=${h},resizable=yes`
  if (place) {
    const monitors = getCachedMonitors()
    const rect = { x: place.x, y: place.y, w, h }
    const { left, top } = toLogicalPosition(rect, monitors)
    const scale = monitorFor(rect, monitors)?.scale || 1
    features = `width=${Math.round(w / scale)},height=${Math.round(h / scale)},left=${left},top=${top},resizable=yes`
  }

  let url = `/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`

  // Prefer the sidecar origin so the child window can load local media. The
  // window is a plain browser page with none of the editor's bindings, so
  // the token it needs for that media travels in its URL.
  try {
    const [port, token] = await Promise.all([GetFileServerPort(), GetFileServerToken()])
    if (port > 0) {
      url = `http://localhost:${port}/?display=1&screenId=${encodeURIComponent(screenId)}&w=${w}&h=${h}`
        + `&token=${encodeURIComponent(token || '')}`
    }
  } catch (e) {
    console.warn('Failed to get sidecar port, using relative URL', e)
  }

  const win = window.open(url, `display-${screenId}`, features)
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

/**
 * Close every display window this page opened, tracked or not by the
 * screen effect. Returns how many were still open.
 */
export function closeAllDisplayWindows() {
  let n = 0
  for (const id of [...opened.keys()]) {
    const entry = opened.get(id)
    if (entry?.win && !entry.win.closed) n++
    closeDisplayWindow(id)
  }
  return n
}

// A reload of the editor page (Vite, or a devtools refresh) used to leave
// its display windows open with nothing driving them: the new page knew
// nothing about them, so Close All Displays could not reach them either.
// Take them down with the page instead.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { closeAllDisplayWindows() })
}
