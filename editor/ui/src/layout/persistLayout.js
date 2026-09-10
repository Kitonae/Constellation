/**
 * Panel sizes that survive a restart.
 *
 * The three panes used to be `useState` seeded from `window.innerWidth` at
 * mount: they reset on every launch and kept their old pixel widths when the
 * OS window was resized, so a shrunk window could leave no room for the
 * viewport at all.
 */

import { useEditorStore } from '../store.js'

const KEY = 'constellation.editor.layout.v1'
const SAVE_DEBOUNCE_MS = 150

/** Bounds for the current window size. Exported so App can re-clamp on resize. */
export function layoutBounds(w = window.innerWidth, h = window.innerHeight) {
  return {
    mediaWidth: { min: 150, max: Math.max(150, Math.floor(w * 0.45)) },
    inspectorWidth: { min: 200, max: Math.max(200, Math.floor(w * 0.45)) },
    timelineHeight: { min: 80, max: Math.max(80, Math.min(600, h - 240)) },
  }
}

/** Force a layout object inside the current window's bounds. */
export function clampLayout(layout, w, h) {
  const b = layoutBounds(w, h)
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
  const fit = (v, range, fallback) => Math.max(range.min, Math.min(range.max, num(v, fallback)))
  return {
    ...layout,
    mediaWidth: fit(layout?.mediaWidth, b.mediaWidth, 300),
    inspectorWidth: fit(layout?.inspectorWidth, b.inspectorWidth, 320),
    timelineHeight: fit(layout?.timelineHeight, b.timelineHeight, 320),
    mediaCollapsed: !!layout?.mediaCollapsed,
    inspectorCollapsed: !!layout?.inspectorCollapsed,
    timelineCollapsed: !!layout?.timelineCollapsed,
  }
}

/** The stored layout, clamped, or defaults sized from the current window. */
export function loadLayout(defaults) {
  let stored = null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw) stored = JSON.parse(raw)
  } catch { /* storage unavailable */ }
  const base = stored || {
    ...defaults,
    mediaWidth: Math.floor(window.innerWidth * 0.2),
    inspectorWidth: Math.floor(window.innerWidth * 0.22),
  }
  return clampLayout(base)
}

/**
 * Start mirroring the store's layout slice into localStorage.
 * @returns {() => void} unsubscribe
 */
export function startLayoutPersistence() {
  let timer = 0
  let last = useEditorStore.getState().layout
  const unsub = useEditorStore.subscribe((s) => {
    if (s.layout === last) return
    last = s.layout
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = 0
      try { window.localStorage.setItem(KEY, JSON.stringify(last)) } catch { /* ignore */ }
    }, SAVE_DEBOUNCE_MS)
  })
  return () => { if (timer) clearTimeout(timer); unsub() }
}
