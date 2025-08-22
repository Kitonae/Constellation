import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { useEditorStore } from '../store.js'
import { resolveImageSrc } from './MediaThumb.jsx'

export default function Viewport2D() {
  const scene = useEditorStore((s) => s.scene)
  const project = useEditorStore((s) => s.project)
  const time = useEditorStore((s) => s.time)
  const selectedClipId = useEditorStore((s) => s.selectedClipId)
  const setSelectedClip = useEditorStore((s) => s.setSelectedClip)
  const selectedId = useEditorStore((s) => s.selectedId)
  const setSelected = useEditorStore((s) => s.setSelected)
  const scrollRef = useRef(null)
  const [containerSize, setContainerSize] = useState({ w: 100, h: 100 })
  const [zoom, setZoom] = useState(1.0) // 1.0 = 100%
  const [pan, setPan] = useState(null) // { startX, startY, startLeft, startTop }
  const [imageMeta, setImageMeta] = useState({}) // { [clipId]: { w, h, src } }

  useEffect(() => {
    const onResize = () => {
      const el = scrollRef.current
      if (!el) return
      setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    }
    onResize()
    const ro = new ResizeObserver(onResize)
    if (scrollRef.current) ro.observe(scrollRef.current)
    return () => ro.disconnect()
  }, [])

  const BASE_SCALE = 50 // pixels per scene unit at 100%
  const scale = BASE_SCALE * zoom
  const STAGE_W = 4000
  const STAGE_H = 3000
  const center = { x: STAGE_W / 2, y: STAGE_H / 2 }

  const nodes = useMemo(() => (scene?.roots ?? []), [scene])
  const nodeIndex = useMemo(() => {
    const map = new Map()
    function walk(n){ if(!n) return; map.set(n.id, n); (n.children||[]).forEach(walk) }
    nodes.forEach(walk)
    return map
  }, [nodes])
  const mediaById = useMemo(() => Object.fromEntries((project?.media||[]).map(m => [m.id, m])), [project])
  const activePlacements = useMemo(() => {
    const res = []
    const tracks = project?.timeline?.tracks || []
    for (const t of tracks) {
      if (!t.media) continue
      const m = t.media
      const start = m.start_at_seconds || 0
      const dur = Math.max(0, (m.out_seconds - m.in_seconds) || 0)
      if (time < start || time > start + dur) continue
      const screen = m.target_node_id ? nodeIndex.get(m.target_node_id) : null
      const clip = mediaById[m.clip_id]
      res.push({ tm: m, screen, clip })
    }
    return res
  }, [project, time, nodeIndex, mediaById])

  // Preload image sources and natural sizes for active clips
  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of activePlacements) {
        if (!clip?.uri || imageMeta[tm.clip_id]) continue
        const src = await resolveImageSrc(clip.uri)
        if (cancelled) return
        if (!src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: img.naturalWidth, h: img.naturalHeight, src } }))
            resolve()
          }
          img.onerror = () => resolve()
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [activePlacements, imageMeta])

  // Center the scroll on first mount
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollLeft = (STAGE_W - sc.clientWidth) / 2
    sc.scrollTop = (STAGE_H - sc.clientHeight) / 2
  }, [])

  const onPointerDown = useCallback((e) => {
    if (!(e.ctrlKey && e.altKey)) return
    const sc = scrollRef.current
    if (!sc) return
    setPan({ startX: e.clientX, startY: e.clientY, startLeft: sc.scrollLeft, startTop: sc.scrollTop })
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const onPointerMove = useCallback((e) => {
    if (!pan) return
    const sc = scrollRef.current
    if (!sc) return
    const dx = e.clientX - pan.startX
    const dy = e.clientY - pan.startY
    sc.scrollLeft = pan.startLeft - dx
    sc.scrollTop = pan.startTop - dy
    e.preventDefault()
  }, [pan])

  const onPointerUp = useCallback((e) => {
    if (!pan) return
    setPan(null)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    e.preventDefault()
  }, [pan])

  const onWheel = useCallback((e) => {
    // Zoom on mouse wheel; keep point under cursor stable
    // Use smooth multiplier; positive deltaY zooms out, negative zooms in
    e.preventDefault()
    const sc = scrollRef.current
    if (!sc) return
    const rect = sc.getBoundingClientRect()
    const contentLeft = sc.scrollLeft + (e.clientX - rect.left)
    const contentTop = sc.scrollTop + (e.clientY - rect.top)

    // Convert current content pixel to world point
    const worldX = (contentLeft - center.x) / scale
    const worldY = (center.y - contentTop) / scale

    // Compute next zoom
    const factor = Math.exp(-e.deltaY * 0.0015)
    const nextZoom = clamp(zoom * factor, 0.2, 6)
    if (nextZoom === zoom) return
    const nextScale = BASE_SCALE * nextZoom
    setZoom(nextZoom)

    // Compute new content pixel for the same world point
    const newPx = center.x + worldX * nextScale
    const newPy = center.y - worldY * nextScale
    // Adjust scroll so the point under the mouse stays fixed
    sc.scrollLeft = newPx - (e.clientX - rect.left)
    sc.scrollTop = newPy - (e.clientY - rect.top)
  }, [zoom, scale, center.x, center.y])

  // Attach a non-passive wheel listener to fully prevent default scrolling
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const handler = (ev) => onWheel(ev)
    sc.addEventListener('wheel', handler, { passive: false })
    return () => sc.removeEventListener('wheel', handler)
  }, [onWheel])

  // Ctrl/Cmd +/- keyboard zoom centered on viewport center
  useEffect(() => {
    const onKey = (e) => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod) return
      const key = e.key
      const code = e.code
      const plus = key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd'
      const minus = key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract'
      if (!plus && !minus) return

      // avoid when typing
      const t = e.target
      const tag = (t?.tagName || '').toLowerCase()
      if (t?.isContentEditable || tag === 'input' || tag === 'textarea') return

      e.preventDefault()
      const sc = scrollRef.current
      if (!sc) return
      const rect = sc.getBoundingClientRect()
      // center of viewport
      const clientX = rect.left + rect.width / 2
      const clientY = rect.top + rect.height / 2
      const contentLeft = sc.scrollLeft + (clientX - rect.left)
      const contentTop = sc.scrollTop + (clientY - rect.top)

      const worldX = (contentLeft - center.x) / scale
      const worldY = (center.y - contentTop) / scale

      const step = 1.1
      const nextZoom = clamp(zoom * (plus ? step : 1/step), 0.2, 6)
      if (nextZoom === zoom) return
      const nextScale = BASE_SCALE * nextZoom
      setZoom(nextZoom)

      const newPx = center.x + worldX * nextScale
      const newPy = center.y - worldY * nextScale
      sc.scrollLeft = newPx - (clientX - rect.left)
      sc.scrollTop = newPy - (clientY - rect.top)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [zoom, scale, center.x, center.y])

  return (
    <div
      ref={scrollRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ position:'relative', width: '100%', height: '100%', overflow: 'auto', background:'#0b0d12', cursor: pan ? 'grabbing' : 'default', overscrollBehavior: 'contain' }}
    >
      <div style={{ position:'relative', width: STAGE_W, height: STAGE_H, ...dotGridBg(center, scale) }}>
        {/* axes */}
        <div style={{ position:'absolute', left: center.x, top: 0, bottom: 0, width: 1, background: '#3a4e85' }} />
        <div style={{ position:'absolute', top: center.y, left: 0, right: 0, height: 1, background: '#3a4e85' }} />

        {/* draw screens */}
        {nodes.map((n) => (
          <Node2D key={n.id} node={n} center={center} scale={scale} selectedId={selectedId} onSelect={setSelected} />
        ))}

        {activePlacements.map(({ tm, screen, clip }, idx) => {
          const spos = screen?.transform?.position || { x: 0, y: 0, z: 0 }
          const cx = center.x + (spos.x ?? 0) * scale
          const cy = center.y - (spos.y ?? 0) * scale
          const mpos = tm.position || { x: 0, y: 0 }
          const meta = imageMeta[tm.clip_id]
          const baseW = meta?.w || 100
          const baseH = meta?.h || 100
          const targetWpx = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW
          const targetHpx = (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH
          const w = Math.max(2, targetWpx * zoom)
          const h = Math.max(2, targetHpx * zoom)
          const left = cx + (mpos.x || 0) * scale - w / 2
          const top = cy - (mpos.y || 0) * scale - h / 2
          const isSel = selectedClipId === tm.clip_id
          return (
            <div key={idx}
              onClick={(e)=>{ e.stopPropagation(); setSelectedClip(tm.clip_id) }}
              title={(clip?.name || tm.clip_id) + ` (${(tm.start_at_seconds||0).toFixed?.(2)}s)`}
              style={{ position:'absolute', left, top, width:w, height:h, background:'#0b0d12', border:`1px solid ${isSel?'#6aa0ff':'#3a4060'}`, boxShadow:isSel?'0 0 0 1px #6aa0ff66':'none', borderRadius:4, overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center', color:'#c7cfdb', fontSize:11, pointerEvents:'auto', zIndex: 5 }}
            >
              {imageMeta[tm.clip_id]?.src ? (
                <img src={imageMeta[tm.clip_id].src} alt={clip?.name || tm.clip_id} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              ) : (
                <span style={{ padding:'0 4px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{clip?.name || tm.clip_id}</span>
              )}
              {/* White 1px bounding box overlay */}
              <div style={{ position:'absolute', inset:0, border:'1px solid #ffffff', pointerEvents:'none' }} />
            </div>
          )
        })}

      </div>
      {/* Zoom indicators anchored to the viewport (window fixed) */}
      <div style={{ position:'fixed', top: 12, right: 12, display:'grid', gap:6, justifyItems:'end', zIndex: 9999, pointerEvents: 'none' }}>
        <div style={{ padding:'2px 6px', fontSize:12, color:'#b9c3d6', background:'#0f1115cc', border:'1px solid #232636', borderRadius:4 }}>
          {Math.round(zoom * 100)}%
        </div>
        <div style={{ pointerEvents: 'auto' }}>
          <ZoomLevelBar zoom={zoom} />
        </div>
      </div>
    </div>
  )
}

function Node2D({ node, center, scale, selectedId, onSelect }) {
  const t = node.transform
  const x = (t?.position?.x ?? 0) * scale + center.x
  const y = center.y - (t?.position?.y ?? 0) * scale
  const s = t?.scale ?? { x: 1, y: 1, z: 1 }
  const isSelected = node.id === selectedId

  const children = (node.children ?? []).map((c) => (
    <Node2D key={c.id} node={c} center={center} scale={scale} selectedId={selectedId} onSelect={onSelect} />
  ))

  if (node.kind?.type === 'screen') {
    const w = Math.max(0.2, s.x) * scale
    const h = Math.max(0.2, s.y) * scale
    return (
      <>
        <div
          onClick={(e)=>{ e.stopPropagation(); onSelect(node.id) }}
          title={node.name || node.id}
          style={{ position:'absolute', left: x - w/2, top: y - h/2, width: w, height: h, background: isSelected ? '#1c274a' : '#101520', border: `1px solid ${isSelected ? '#6aa0ff' : '#2a3148'}`, borderRadius: 4, zIndex: 1 }}
        />
        {children}
      </>
    )
  }

  // default: draw a small dot for other nodes
  return (
    <>
      <div onClick={(e)=>{ e.stopPropagation(); onSelect(node.id) }} style={{ position:'absolute', left: x-2, top: y-2, width:4, height:4, background:'#5a78ff', borderRadius: 2 }} title={node.name || node.id} />
      {children}
    </>
  )
}

function gridBg() {
  // legacy; not used
  return {}
}

function dotGridBg(center, scale) {
  // Dots spaced in world units so spacing scales with zoom
  const worldMinor = 0.2 // world units between minor dots (10px at 1x with BASE_SCALE=50)
  const minorStep = Math.max(2, Math.round(scale * worldMinor))
  const majorStep = minorStep * 10
  const mod = (v, m) => ((v % m) + m) % m
  // radial-gradient dot sits at the center of each tile -> subtract half step
  const offXMinor = mod(center.x - minorStep / 2, minorStep)
  const offYMinor = mod(center.y - minorStep / 2, minorStep)
  const offXMajor = mod(center.x - majorStep / 2, majorStep)
  const offYMajor = mod(center.y - majorStep / 2, majorStep)
  const minor = 'radial-gradient(#2a375b 1px, transparent 1px)'
  const major = 'radial-gradient(#4a63a8 2px, transparent 2px)'
  return {
    backgroundImage: `${minor}, ${major}`,
    backgroundSize: `${minorStep}px ${minorStep}px, ${majorStep}px ${majorStep}px`,
    backgroundPosition: `${offXMinor}px ${offYMinor}px, ${offXMajor}px ${offYMajor}px`,
  }
}

function ZoomLevelBar({ zoom }) {
  // Discrete levels to visualize progression across the range (0.2x–6x)
  const levels = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6]
  return (
    <div style={{ display:'flex', gap:4, padding:'2px 4px', background:'#0f1115cc', border:'1px solid #232636', borderRadius:4 }}>
      {levels.map((lv) => {
        const filled = zoom >= lv * 0.98 // small tolerance
        const isOne = Math.abs(lv - 1) < 1e-6
        return (
          <div key={lv}
            title={`${Math.round(lv*100)}%`}
            style={{
              width: 10,
              height: 8,
              background: filled ? '#6aa0ff' : '#2a3148',
              border: `1px solid ${isOne ? '#89b4ff' : '#3a4060'}`,
              borderRadius: 2,
            }}
          />
        )
      })}
    </div>
  )
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }
