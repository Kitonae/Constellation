import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../store.js'
import { loadMonitors, getCachedMonitors } from '../output/monitors.js'
import { outputRect, monitorFor, fillMonitor, snapRect, unionRect, fitTransform } from '../output/placement.js'
import NumberInput from './inspector/NumberInput.jsx'

const SNAP_VIEW_PX = 10
const DRAG_THRESHOLD_PX = 3

const STATE_COLOR = {
  ready: 'var(--success)',
  open: 'var(--success)',
  launching: 'var(--warn)',
  error: 'var(--error)',
  blocked: 'var(--error)',
}

/**
 * The Output view: the desktop's displays drawn to scale, with every output
 * window on them, so assigning a screen to a monitor is a drag and covering
 * one exactly is a button.
 *
 * A screen with no `kind.output` is "not placed": its window opens wherever
 * Windows puts it, as before this panel existed. Placing it stores physical
 * desktop coordinates on the node; the screen effect in App sees the change
 * through the screen key and reopens the window there.
 */
export default function OutputPanel() {
  const scene = useEditorStore((s) => s.scene)
  const outputs = useEditorStore((s) => s.outputs)
  const selectedId = useEditorStore((s) => s.selectedId)
  const setSelected = useEditorStore((s) => s.setSelected)
  const updateScreenOutput = useEditorStore((s) => s.updateScreenOutput)
  const requestScreenReopen = useEditorStore((s) => s.requestScreenReopen)

  const [monitors, setMonitors] = useState(() => getCachedMonitors())
  const refresh = useCallback(() => { loadMonitors().then(setMonitors) }, [])
  useEffect(() => { refresh() }, [refresh])

  const screens = useMemo(() => (scene?.roots || []).filter((n) => n.kind?.type === 'screen'), [scene])
  const placed = useMemo(() => screens.filter((n) => n.kind?.output), [screens])
  const unplaced = useMemo(() => screens.filter((n) => !n.kind?.output), [screens])

  // --- Map geometry ------------------------------------------------------
  const mapRef = useRef(null)
  const [view, setView] = useState({ w: 800, h: 500 })
  useEffect(() => {
    const el = mapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setView({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const [drag, setDrag] = useState(null) // { id, x, y } live position while dragging
  const dragRef = useRef(null)

  const rects = useMemo(() => {
    const m = new Map()
    for (const n of placed) {
      const r = outputRect(n)
      if (drag?.id === n.id) { r.x = drag.x; r.y = drag.y }
      m.set(n.id, r)
    }
    return m
  }, [placed, drag])

  // Fitted to the committed rects, not the live drag position: re-fitting
  // while a window is being dragged shrinks the map under the pointer, so
  // the same hand movement covers more desktop the further it goes.
  const bounds = useMemo(() => {
    const b = unionRect([...monitors, ...placed.map(outputRect)])
    // Breathing room so a window nudged past a display edge stays visible.
    const pad = Math.max(b.w, b.h) * 0.04
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
  }, [monitors, placed])
  const tf = useMemo(() => fitTransform(bounds, view.w, view.h), [bounds, view])
  const toView = (r) => ({
    left: (r.x - bounds.x) * tf.scale + tf.ox,
    top: (r.y - bounds.y) * tf.scale + tf.oy,
    width: r.w * tf.scale,
    height: r.h * tf.scale,
  })

  // --- Dragging an output on the map ---------------------------------------
  const onOutputPointerDown = (n) => (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    setSelected(n.id)
    const r = outputRect(n)
    const d = { id: n.id, startX: e.clientX, startY: e.clientY, origX: r.x, origY: r.y, moved: false, x: r.x, y: r.y }
    dragRef.current = d
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
  }
  const onOutputPointerMove = (n) => (e) => {
    const d = dragRef.current
    if (!d || d.id !== n.id) return
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    d.moved = true
    const r = outputRect(n)
    const raw = { x: Math.round(d.origX + dx / tf.scale), y: Math.round(d.origY + dy / tf.scale), w: r.w, h: r.h }
    const others = placed.filter((o) => o.id !== n.id).map(outputRect)
    const snapped = e.altKey ? raw : snapRect(raw, monitors, others, SNAP_VIEW_PX / tf.scale)
    d.x = snapped.x; d.y = snapped.y
    setDrag({ id: n.id, x: d.x, y: d.y })
  }
  const onOutputPointerUp = (n) => (e) => {
    const d = dragRef.current
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
    if (!d || d.id !== n.id) return
    dragRef.current = null
    setDrag(null)
    if (d.moved && (d.x !== d.origX || d.y !== d.origY)) {
      updateScreenOutput(n.id, { ...n.kind.output, x: d.x, y: d.y })
    }
  }

  const primary = monitors.find((m) => m.primary) || monitors[0] || null

  return (
    <div className="output-panel">
      <div className="panel__head">
        <span className="panel__title">Output</span>
        <span className="panel__count">{monitors.length} display{monitors.length === 1 ? '' : 's'} · {screens.length} output{screens.length === 1 ? '' : 's'}</span>
        <button type="button" className="btn btn--ghost panel__head-action" onClick={refresh}>Refresh displays</button>
      </div>

      <div className="output-panel__body">
        <div className="output-map" ref={mapRef} onPointerDown={() => setSelected(null)}>
          {monitors.map((m) => {
            const v = toView(m)
            return (
              <div key={m.id} className={'output-monitor' + (m.primary ? ' is-primary' : '')} style={v}>
                <div className="output-monitor__label">
                  <span className="output-monitor__name">{m.name}</span>
                  <span className="output-monitor__meta">{m.w} × {m.h}{m.scale !== 1 ? ` · ${Math.round(m.scale * 100)}%` : ''}{m.primary ? ' · primary' : ''}</span>
                </div>
              </div>
            )
          })}

          {placed.map((n) => {
            const r = rects.get(n.id)
            const v = toView(r)
            const st = outputs[n.id]
            const isSel = n.id === selectedId
            const type = n.kind?.screenType || 'web'
            return (
              <div
                key={n.id}
                className={'output-window' + (isSel ? ' is-selected' : '') + (drag?.id === n.id ? ' is-dragging' : '') + ` output-window--${type}`}
                style={v}
                title={`${n.name || n.id} · ${r.w} × ${r.h} at ${r.x}, ${r.y}`}
                onPointerDown={onOutputPointerDown(n)}
                onPointerMove={onOutputPointerMove(n)}
                onPointerUp={onOutputPointerUp(n)}
              >
                <span className="output-window__dot" style={{ background: STATE_COLOR[st?.state] || 'var(--text-muted)' }} />
                <span className="output-window__name">{n.name || n.id}</span>
                <span className="output-window__meta">{r.w} × {r.h}</span>
              </div>
            )
          })}

          {!monitors.length && <div className="output-map__empty">No displays reported.</div>}
        </div>

        <aside className="output-list">
          {screens.length === 0 && (
            <div className="output-list__empty">No outputs yet. Right-click the stage to add a screen.</div>
          )}
          {screens.map((n) => {
            const r = outputRect(n)
            const on = r ? monitorFor(r, monitors) : null
            const st = outputs[n.id]
            const type = n.kind?.screenType || 'web'
            const isSel = n.id === selectedId
            const px = n.kind?.pixels || [0, 0]
            const fillTarget = on || primary
            return (
              <div key={n.id} className={'output-card' + (isSel ? ' is-selected' : '')} onClick={() => setSelected(n.id)}>
                <div className="output-card__head">
                  <span className="output-window__dot" style={{ background: STATE_COLOR[st?.state] || 'var(--text-muted)' }} title={st?.state || 'stopped'} />
                  <span className="output-card__name">{n.name || n.id}</span>
                  <span className={`output-card__type output-card__type--${type}`}>{type === 'renderer' ? 'Renderer' : 'Web'}</span>
                </div>
                <div className="output-card__meta">
                  {px[0]} × {px[1]}
                  {' · '}
                  {r ? (on ? `on ${on.name}` : 'off every display') : 'not placed'}
                  {n.kind?.enabled === false ? ' · disabled' : ''}
                </div>

                {r ? (
                  <>
                    <div className="output-card__row">
                      <NumberInput prefix="X" step={1} unit="px" value={r.x} scrubLabel="Place Output"
                        onChange={(v) => updateScreenOutput(n.id, { ...n.kind.output, x: Math.round(v) })} />
                      <NumberInput prefix="Y" step={1} unit="px" value={r.y} scrubLabel="Place Output"
                        onChange={(v) => updateScreenOutput(n.id, { ...n.kind.output, y: Math.round(v) })} />
                    </div>
                    <label className="output-card__check">
                      <input type="checkbox" checked={!!n.kind.output.borderless}
                        onChange={(e) => updateScreenOutput(n.id, { ...n.kind.output, borderless: e.target.checked })} />
                      Borderless
                      {type === 'web' && <span className="output-card__hint">renderer only</span>}
                    </label>
                    <div className="output-card__actions">
                      {fillTarget && (
                        <button type="button" className="btn btn--ghost" title={`Cover ${fillTarget.name} exactly: ${fillTarget.w} × ${fillTarget.h}, borderless`}
                          onClick={(e) => { e.stopPropagation(); updateScreenOutput(n.id, fillMonitor(fillTarget)) }}>
                          Fill {fillTarget.name}
                        </button>
                      )}
                      <button type="button" className="btn btn--ghost" onClick={(e) => { e.stopPropagation(); updateScreenOutput(n.id, null) }}>Unplace</button>
                      {type === 'renderer' && (
                        <button type="button" className="btn btn--ghost" onClick={(e) => { e.stopPropagation(); requestScreenReopen(n.id) }}>Relaunch</button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="output-card__actions">
                    <select
                      value=""
                      onChange={(e) => {
                        const m = monitors.find((mm) => mm.id === e.target.value)
                        if (m) updateScreenOutput(n.id, { output: { x: m.x, y: m.y, borderless: false } })
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <option value="" disabled>Place on…</option>
                      {monitors.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.w} × {m.h})</option>)}
                    </select>
                    {primary && (
                      <button type="button" className="btn btn--ghost" title={`Cover ${primary.name} exactly, borderless`}
                        onClick={(e) => { e.stopPropagation(); updateScreenOutput(n.id, fillMonitor(primary)) }}>
                        Fill {primary.name}
                      </button>
                    )}
                  </div>
                )}
                {st?.error && <div className="output-card__error">{st.error}</div>}
              </div>
            )
          })}
          {unplaced.length > 0 && placed.length === 0 && screens.length > 0 && (
            <div className="output-list__hint">Placed outputs appear on the map above and can be dragged between displays. Hold Alt while dragging to skip snapping.</div>
          )}
        </aside>
      </div>
    </div>
  )
}
