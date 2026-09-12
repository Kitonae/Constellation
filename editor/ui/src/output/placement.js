// Geometry for the Output panel: Windows displays and where output windows
// sit on them.
//
// Everything here is in physical pixels of Windows' virtual-screen space.
// That is what a display natively is, what the renderer (per-monitor DPI
// aware) places its window in, and what is stored on the screen node as
// `kind.output = { x, y, borderless }`. Logical (scaled) coordinates only
// matter for `window.open`, and `toLogicalPosition` handles that one case.

/**
 * Wails `Screens.GetAll()` records → one plain shape.
 *
 * Physical bounds are preferred; the logical ones are kept alongside for the
 * web display windows. Primary first, then left to right, so lists and
 * defaults are stable.
 */
export function normalizeMonitors(screens) {
  const out = (screens || []).map((s, i) => {
    const pb = s.PhysicalBounds || s.Bounds || {}
    const lb = s.Bounds || pb
    const scale = Number(s.ScaleFactor) > 0 ? Number(s.ScaleFactor) : 1
    return {
      id: String(s.ID ?? i),
      name: s.Name || `Display ${i + 1}`,
      x: pb.X | 0, y: pb.Y | 0,
      w: Math.max(1, pb.Width | 0), h: Math.max(1, pb.Height | 0),
      lx: lb.X | 0, ly: lb.Y | 0,
      scale,
      primary: !!s.IsPrimary,
    }
  })
  out.sort((a, b) => (a.primary === b.primary ? a.x - b.x || a.y - b.y : a.primary ? -1 : 1))
  return out
}

/** The one display a plain browser can see about itself. */
export function browserMonitors() {
  if (typeof window === 'undefined' || !window.screen) return []
  const dpr = window.devicePixelRatio || 1
  return [{
    id: 'browser',
    name: 'Display 1',
    x: 0, y: 0,
    w: Math.round(window.screen.width * dpr), h: Math.round(window.screen.height * dpr),
    lx: 0, ly: 0,
    scale: dpr,
    primary: true,
  }]
}

/** Smallest rect containing every rect given. */
export function unionRect(rects) {
  const rs = (rects || []).filter(Boolean)
  if (!rs.length) return { x: 0, y: 0, w: 1920, h: 1080 }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const r of rs) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** The rect an output window occupies, or null when the screen is not placed. */
export function outputRect(node) {
  const k = node?.kind || {}
  const o = k.output
  if (!o) return null
  return { x: o.x | 0, y: o.y | 0, w: Math.max(1, k.pixels?.[0] | 0), h: Math.max(1, k.pixels?.[1] | 0) }
}

/** The part of a screen's identity that its placement contributes. */
export function outputKeyPart(kind) {
  const o = kind?.output
  return o ? `${o.x | 0},${o.y | 0},${o.borderless ? 1 : 0}` : ''
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Which display an output is on: the one under its centre, else the one it
 * overlaps most, else null (entirely off every display).
 */
export function monitorFor(rect, monitors) {
  if (!rect || !monitors?.length) return null
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
  const under = monitors.find((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h)
  if (under) return under
  let best = null, bestArea = 0
  for (const m of monitors) {
    const a = overlapArea(rect, m)
    if (a > bestArea) { best = m; bestArea = a }
  }
  return best
}

/** The placement and resolution that cover a display exactly. */
export function fillMonitor(monitor) {
  return { output: { x: monitor.x, y: monitor.y, borderless: true }, pixels: [monitor.w, monitor.h] }
}

/**
 * Snap a rect's edges to display edges and to other outputs' edges.
 *
 * Each axis snaps independently, to whichever candidate is nearest within
 * `threshold` (physical pixels). Left snaps to lefts and rights; right snaps
 * to lefts and rights; the same on Y. So an output can butt up against a
 * neighbour or sit flush with a display corner without pixel-hunting.
 */
export function snapRect(rect, monitors, others, threshold) {
  const xs = [], ys = []
  for (const r of [...(monitors || []), ...(others || [])]) {
    xs.push(r.x, r.x + r.w)
    ys.push(r.y, r.y + r.h)
  }
  const snapAxis = (start, size, cands) => {
    let best = null, bestD = threshold + 1
    for (const c of cands) {
      for (const [edge, d] of [[start, c - start], [start + size, c - (start + size)]]) {
        void edge
        if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = d }
      }
    }
    return best === null ? start : start + best
  }
  return { x: snapAxis(rect.x, rect.w, xs), y: snapAxis(rect.y, rect.h, ys) }
}

/**
 * Map desktop space into a view of viewW × viewH, keeping aspect, with `pad`
 * view pixels of margin. Returns the scale and the view-space offset of the
 * desktop origin: view = (desktop - bounds.xy) * scale + offset.
 */
export function fitTransform(bounds, viewW, viewH, pad = 24) {
  const availW = Math.max(1, viewW - pad * 2)
  const availH = Math.max(1, viewH - pad * 2)
  const scale = Math.min(availW / Math.max(1, bounds.w), availH / Math.max(1, bounds.h))
  const ox = pad + (availW - bounds.w * scale) / 2
  const oy = pad + (availH - bounds.h * scale) / 2
  return { scale, ox, oy }
}

/**
 * Where `window.open` should put a web display for a rect: its left/top are
 * logical (scaled) pixels, so convert through the display the rect is on.
 */
export function toLogicalPosition(rect, monitors) {
  const m = monitorFor(rect, monitors)
  if (!m) return { left: rect.x, top: rect.y }
  return {
    left: Math.round(m.lx + (rect.x - m.x) / m.scale),
    top: Math.round(m.ly + (rect.y - m.y) / m.scale),
  }
}
