import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { useEditorStore } from '../store.js'
import { openImageDialog } from '../utils/fileDialogs.js'
import { resolveImageSrc, inlineFromUri } from './MediaThumb.jsx'

export default function Viewport2D() {
  const scene = useEditorStore((s) => s.scene)
  const project = useEditorStore((s) => s.project)
  // Throttle time-dependent React updates; direct DOM updates for clip positions
  const [timeDisplay, setTimeDisplay] = useState(useEditorStore.getState().time || 0)
  const lastTimeUiRef = useRef(0)
  const selectedClipId = useEditorStore((s) => s.selectedClipId)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds || [])
  const setSelectedClip = useEditorStore((s) => s.setSelectedClip)
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips)
  const selectedId = useEditorStore((s) => s.selectedId)
  const setSelected = useEditorStore((s) => s.setSelected)
  const showOutputOverlay = useEditorStore((s) => s.showOutputOverlay)
  const scrollRef = useRef(null)
  const stageRef = useRef(null)
  const [containerSize, setContainerSize] = useState({ w: 100, h: 100 })
  // Default zoomed way out; neutral (1:1 px) is 20%
  const [zoom, setZoom] = useState(0.02)
  const [pan, setPan] = useState(null) // { startX, startY, startLeft, startTop }
  const [imageMeta, setImageMeta] = useState({}) // { [clipId]: { w, h, src } }
  const [dnd, setDnd] = useState({ over: false, screenId: null, left: 0, top: 0 })
  const [dragClip, setDragClip] = useState(null) // { id, startX, startY, origX, origY }
  const dragClipRef = useRef(null)
  const [menu, setMenu] = useState({ open: false, x: 0, y: 0 })
  const [marquee, setMarquee] = useState(null) // { x1, y1, x2, y2 }
  const [tool, setTool] = useState('select') // 'select' | 'hand'

  // Global failsafe: if the pointer is released outside the element, end any active clip drag
  useEffect(() => {
    const endDrag = (e) => {
      if (dragClipRef.current && dragClipRef.current.currentX !== undefined && e.type !== 'pointercancel') {
        const { id, currentX, currentY } = dragClipRef.current
        useEditorStore.getState().updateClipTransform({ timelineId: id, position: { x: currentX, y: currentY } })
      }
      setDragClip((d) => d ? null : d)
      dragClipRef.current = null
    }
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)
    window.addEventListener('mouseup', endDrag, true)
    window.addEventListener('touchend', endDrag, true)
    return () => {
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
      window.removeEventListener('mouseup', endDrag, true)
      window.removeEventListener('touchend', endDrag, true)
    }
  }, [])

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

  const BASE_SCALE = 50 // pixels per scene unit at neutral zoom
  const Z_NEUTRAL = 0.2
  const scale = BASE_SCALE * (zoom / Z_NEUTRAL)
  const STAGE_W = 4000
  const STAGE_H = 3000
  const center = { x: STAGE_W / 2, y: STAGE_H / 2 }

  const nodes = useMemo(() => (scene?.roots ?? []), [scene])
  const nodeIndex = useMemo(() => {
    const map = new Map()
    function walk(n) { if (!n) return; map.set(n.id, n); (n.children || []).forEach(walk) }
    nodes.forEach(walk)
    return map
  }, [nodes])
  const mediaById = useMemo(() => Object.fromEntries((project?.media || []).map(m => [m.id, m])), [project])
  const allTimelineItems = useMemo(() => {
    const tracks = project?.timeline?.tracks || []
    return tracks.filter(t => t.media).map(t => t.media)
  }, [project])
  const clipRefs = useRef(new Map())
  const getClipRef = (id) => {
    if (!clipRefs.current.has(id)) clipRefs.current.set(id, React.createRef())
    return clipRefs.current.get(id)
  }
  const videoRefs = useRef(new Map())
  const getVideoRef = (id) => {
    if (!videoRefs.current.has(id)) videoRefs.current.set(id, React.createRef())
    return videoRefs.current.get(id)
  }
  const placements = useMemo(() => {
    const res = []
    for (const m of allTimelineItems) {
      const screen = m.target_node_id ? nodeIndex.get(m.target_node_id) : null
      const clip = mediaById[m.clip_id]
      res.push({ tm: m, screen, clip })
    }
    return res
  }, [allTimelineItems, nodeIndex, mediaById])

  // Subscribe to time to update active clip visibility/positions without full recalculation via React state each frame
  useEffect(() => {
    const unsub = useEditorStore.subscribe((state) => {
      const t = state.time || 0
      const now = performance.now()
      if (now - lastTimeUiRef.current > 125) { lastTimeUiRef.current = now; setTimeDisplay(t) }
      // Update class visibility
      clipRefs.current.forEach((ref, id) => {
        const el = ref.current
        if (!el) return
        const m = allTimelineItems.find(mm => mm.id === id)
        if (!m) return
        const start = (m.start ?? m.start_at_seconds) || 0
        const dur = Math.max(0, (m.duration ?? ((m.out_seconds - m.in_seconds) || 0)))
        const active = t >= start && t <= start + dur
        el.style.display = active ? 'flex' : 'none'
      })
      // Sync video currentTime to timeline offset
      videoRefs.current.forEach((ref, id) => {
        const vid = ref.current
        if (!vid) return
        const m = allTimelineItems.find(mm => mm.id === id)
        if (!m) return
        const start = (m.start ?? m.start_at_seconds) || 0
        const offset = Math.max(0, t - start)
        try {
          if (Math.abs((vid.currentTime || 0) - offset) > 0.03) vid.currentTime = offset
        } catch { }
      })
    })
    return () => { try { unsub() } catch { } }
  }, [allTimelineItems])

  // Preload image sources and natural sizes for clips used in placements
  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of placements) {
        if (!clip?.uri || imageMeta[tm.clip_id]) continue
        // Skip videos for meta probe; use defaults
        const ext = String(clip.uri).split('?')[0].split('#')[0].split('.').pop().toLowerCase()
        if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'].includes(ext)) continue
        const src = await resolveImageSrc(clip.uri)
        if (cancelled) return
        if (!src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: img.naturalWidth, h: img.naturalHeight, src } }))
            resolve()
          }
          img.onerror = async () => {
            // Try inline fallback if asset protocol blocks access (403)
            try {
              const inlined = await inlineFromUri(clip.uri)
              if (inlined) {
                const probe = new Image()
                probe.onload = () => {
                  setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: probe.naturalWidth, h: probe.naturalHeight, src: inlined } }))
                  resolve()
                }
                probe.onerror = () => resolve()
                probe.src = inlined
                return
              }
            } catch { }
            resolve()
          }
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [placements, imageMeta])

  // Center the scroll on first mount
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollLeft = (STAGE_W - sc.clientWidth) / 2
    sc.scrollTop = (STAGE_H - sc.clientHeight) / 2
  }, [])

  const onPointerDown = useCallback((e) => {
    const isHand = tool === 'hand' || (e.ctrlKey && e.altKey) || e.button === 1
    if (!isHand) return
    const sc = scrollRef.current
    if (!sc) return
    setPan({ startX: e.clientX, startY: e.clientY, startLeft: sc.scrollLeft, startTop: sc.scrollTop })
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    e.preventDefault()
    e.stopPropagation()
  }, [tool])

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
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
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
    const nextZoom = clamp(zoom * factor, 0.01, 20)
    if (nextZoom === zoom) return
    const nextScale = BASE_SCALE * (nextZoom / Z_NEUTRAL)
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
      const nextZoom = clamp(zoom * (plus ? step : 1 / step), 0.01, 20)
      if (nextZoom === zoom) return
      const nextScale = BASE_SCALE * (nextZoom / Z_NEUTRAL)
      setZoom(nextZoom)

      const newPx = center.x + worldX * nextScale
      const newPy = center.y - worldY * nextScale
      sc.scrollLeft = newPx - (clientX - rect.left)
      sc.scrollTop = newPy - (clientY - rect.top)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [zoom, scale, center.x, center.y])

  useEffect(() => {
    if (!menu.open) return
    const close = () => setMenu(m => ({ ...m, open: false }))
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu.open])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={scrollRef}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ open: true, x: e.clientX, y: e.clientY }) }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types?.includes('application/x-constellation-clip-id') && !e.dataTransfer?.types?.includes('text/plain')) return
          e.preventDefault()
          const sc = scrollRef.current
          if (!sc) return
          const rect = sc.getBoundingClientRect()
          const contentLeft = sc.scrollLeft + (e.clientX - rect.left)
          const contentTop = sc.scrollTop + (e.clientY - rect.top)
          const Z_NEUTRAL = 0.2
          const ratio = (zoom / Z_NEUTRAL)
          let target = null
          for (const n of nodes) {
            if (n.kind?.type !== 'screen' || (n.kind?.enabled === false)) continue
            const spos = n.transform?.position || { x: 0, y: 0, z: 0 }
            const cx = center.x + (spos.x || 0) * scale
            const cy = center.y - (spos.y || 0) * scale
            const px = n.kind?.pixels?.[0] || 0
            const py = n.kind?.pixels?.[1] || 0
            const w = Math.max(2, px * ratio)
            const h = Math.max(2, py * ratio)
            const left = cx - w / 2
            const top = cy - h / 2
            if (contentLeft >= left && contentLeft <= left + w && contentTop >= top && contentTop <= top + h) {
              target = { id: n.id }
              break
            }
          }
          setDnd({ over: !!target, screenId: target?.id || null, left: contentLeft, top: contentTop })
        }}
        onDragLeave={() => setDnd({ over: false, screenId: null, left: 0, top: 0 })}
        onDrop={(e) => {
          const clipId = e.dataTransfer.getData('application/x-constellation-clip-id') || e.dataTransfer.getData('text/plain')
          if (!clipId) return
          e.preventDefault()
          const sc = scrollRef.current
          if (!sc) return
          const rect = sc.getBoundingClientRect()
          const contentLeft = sc.scrollLeft + (e.clientX - rect.left)
          const contentTop = sc.scrollTop + (e.clientY - rect.top)
          const Z_NEUTRAL = 0.2
          const ratio = (zoom / Z_NEUTRAL)
          // No per-screen association; position relative to world center
          const pos = { x: (contentLeft - center.x) / ratio, y: (center.y - contentTop) / ratio }
          const { addClipToTimeline, time } = useEditorStore.getState()
          addClipToTimeline({ clipId, startAt: time, position: pos })
          setDnd({ over: false, screenId: null, left: 0, top: 0 })
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', background: '#0b0d12', cursor: pan ? 'grabbing' : (tool === 'hand' ? 'grab' : 'default'), overscrollBehavior: 'contain' }}
      >
        <div
          ref={stageRef}
          style={{ position: 'relative', width: STAGE_W, height: STAGE_H, ...dotGridBg(center, zoom) }}
          onClick={() => { if (!marquee) { setSelected(null); setSelectedClips([]) } }}
          onPointerDown={(e) => {
            // Start marquee selection only on empty space (not when Ctrl+Alt panning or clicking a clip)
            if (e.button !== 0) return
            if (tool === 'hand' || (e.ctrlKey && e.altKey)) return
            if (e.target !== stageRef.current) return
            const sc = scrollRef.current
            if (!sc) return
            const rect = sc.getBoundingClientRect()
            const x = sc.scrollLeft + (e.clientX - rect.left)
            const y = sc.scrollTop + (e.clientY - rect.top)
            setMarquee({ x1: x, y1: y, x2: x, y2: y })
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerMove={(e) => {
            if (!marquee) return
            const sc = scrollRef.current
            if (!sc) return
            const rect = sc.getBoundingClientRect()
            const x = sc.scrollLeft + (e.clientX - rect.left)
            const y = sc.scrollTop + (e.clientY - rect.top)
            setMarquee((m) => (m ? { ...m, x2: x, y2: y } : m))
            e.preventDefault()
          }}
          onPointerUp={(e) => {
            if (!marquee) return
            // Normalize marquee rect
            const mx = Math.min(marquee.x1, marquee.x2)
            const my = Math.min(marquee.y1, marquee.y2)
            const mw = Math.abs(marquee.x2 - marquee.x1)
            const mh = Math.abs(marquee.y2 - marquee.y1)
            // Collect all intersecting clips
            const ratio = (zoom / Z_NEUTRAL)
            const picked = []
            const tNow = useEditorStore.getState().time
            for (const { tm, screen } of placements) {
              const spos = screen?.transform?.position || { x: 0, y: 0, z: 0 }
              const cx = center.x + (spos.x ?? 0) * scale
              const cy = center.y - (spos.y ?? 0) * scale
              const meta = imageMeta[tm.clip_id]
              const baseW = meta?.w || 100
              const baseH = meta?.h || 100
              const targetWpx = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW
              const targetHpx = (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH
              const w = Math.max(2, targetWpx * ratio)
              const h = Math.max(2, targetHpx * ratio)
              const left = cx + (tm.position?.x || 0) * ratio - w / 2
              const top = cy - (tm.position?.y || 0) * ratio - h / 2
              const inter = (mx < left + w) && (mx + mw > left) && (my < top + h) && (my + mh > top)
              const start = (tm.start ?? tm.start_at_seconds) || 0
              const dur = Math.max(0, (tm.duration ?? ((tm.out_seconds - tm.in_seconds) || 0)))
              const isActive = tNow >= start && tNow <= start + dur
              if (inter && isActive) picked.push(tm.id)
            }
            setSelectedClips(picked)
            setMarquee(null)
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {marquee && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
                border: '1px dashed #6aa0ff',
                background: 'rgba(106,160,255,0.12)',
                pointerEvents: 'none',
                zIndex: 1000,
              }}
            />
          )}
          {/* axes */}
          <div style={{ position: 'absolute', left: center.x, top: 0, bottom: 0, width: 1, background: '#3a4e85' }} />
          <div style={{ position: 'absolute', top: center.y, left: 0, right: 0, height: 1, background: '#3a4e85' }} />

          {/* draw screens */}
          {nodes.map((n) => (
            <Node2D key={n.id} node={n} center={center} scale={scale} selectedId={selectedId} onSelect={setSelected} highlight={dnd.over && dnd.screenId === n.id} />
          ))}

          {/* Output overlay: represent each screen's pixel output area */}
          {showOutputOverlay && nodes.map((n) => n).filter(n => n.kind?.type === 'screen' && (n.kind?.enabled ?? true)).map((screen) => {
            const spos = screen.transform?.position || { x: 0, y: 0, z: 0 }
            const cx = center.x + (spos.x || 0) * scale
            const cy = center.y - (spos.y || 0) * scale
            const px = screen.kind?.pixels?.[0] || 0
            const py = screen.kind?.pixels?.[1] || 0
            const ratio = (zoom / Z_NEUTRAL)
            const w = Math.max(2, px * ratio)
            const h = Math.max(2, py * ratio)
            const left = cx - w / 2
            const top = cy - h / 2
            return (
              <div key={`out-${screen.id}`} style={{ position: 'absolute', left, top, width: w, height: h, border: '1px dashed #6aa0ff', background: 'rgba(90,120,255,0.07)', zIndex: 50, pointerEvents: 'none' }} title={`Output ${px}x${py}`} />
            )
          })}

          {placements.map(({ tm, screen, clip }, idx) => {
            const tNow = useEditorStore.getState().time
            const spos = screen?.transform?.position || { x: 0, y: 0, z: 0 }
            const cx = center.x + (spos.x ?? 0) * scale
            const cy = center.y - (spos.y ?? 0) * scale
            const mpos = tm.position || { x: 0, y: 0 }
            const meta = imageMeta[tm.clip_id]
            const baseW = meta?.w || 100
            const baseH = meta?.h || 100
            const targetWpx = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW
            const targetHpx = (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH
            const ratio = (zoom / Z_NEUTRAL)
            const w = Math.max(2, targetWpx * ratio)
            const h = Math.max(2, targetHpx * ratio)
            const left = cx + (mpos.x || 0) * ratio - w / 2
            const top = cy - (mpos.y || 0) * ratio - h / 2
            const isSel = selectedClipId === tm.id || selectedClipIds.includes(tm.id)
            const start = (tm.start ?? tm.start_at_seconds) || 0
            const dur = Math.max(0, (tm.duration ?? ((tm.out_seconds - tm.in_seconds) || 0)))
            const isActive = tNow >= start && tNow <= start + dur
            return (
              <div key={idx} ref={getClipRef(tm.id)}
                onClick={(e) => { e.stopPropagation(); setSelectedClips([tm.id]) }}
                onPointerDown={(e) => {
                  if (tool === 'hand') return
                  if (e.button !== 0) return
                  e.stopPropagation()
                  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
                  const d = { id: tm.id, startX: e.clientX, startY: e.clientY, origX: mpos.x || 0, origY: mpos.y || 0 }
                  setDragClip(d)
                  dragClipRef.current = d
                }}
                onPointerMove={(e) => {
                  if (!dragClipRef.current || dragClipRef.current.id !== tm.id) return
                  if ((e.buttons & 1) === 0) { setDragClip(null); dragClipRef.current = null; return }
                  const dx = e.clientX - dragClipRef.current.startX
                  const dy = e.clientY - dragClipRef.current.startY
                  const nextX = dragClipRef.current.origX + dx / ratio
                  const nextY = dragClipRef.current.origY - dy / ratio
                  dragClipRef.current = { ...dragClipRef.current, currentX: nextX, currentY: nextY }
                  setDragClip({ ...dragClipRef.current })
                }}
                onPointerUp={(e) => {
                  if (dragClipRef.current?.id === tm.id) {
                    if (dragClipRef.current.currentX !== undefined) {
                      useEditorStore.getState().updateClipTransform({ timelineId: tm.id, position: { x: dragClipRef.current.currentX, y: dragClipRef.current.currentY } })
                    }
                    setDragClip(null)
                    dragClipRef.current = null
                  }
                  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
                }}
                onDragStart={(e) => { e.preventDefault() }}
                onPointerCancel={(e) => { if (dragClipRef.current?.id === tm.id) { setDragClip(null); dragClipRef.current = null } try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { } }}
                title={(clip?.name || tm.clip_id) + ` (${(tm.start_at_seconds || 0).toFixed?.(2)}s)`}
                style={{ position: 'absolute', left: (dragClip?.id === tm.id && dragClip.currentX !== undefined) ? (cx + dragClip.currentX * ratio - w / 2) : left, top: (dragClip?.id === tm.id && dragClip.currentY !== undefined) ? (cy - dragClip.currentY * ratio - h / 2) : top, width: w, height: h, background: '#0b0d12', border: `1px solid ${isSel ? '#6aa0ff' : '#3a4060'}`, boxShadow: isSel ? '0 0 0 1px #6aa0ff66' : 'none', borderRadius: 4, overflow: 'hidden', display: isActive ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', color: '#c7cfdb', fontSize: 11, pointerEvents: 'auto', zIndex: 5, userSelect: 'none', WebkitUserSelect: 'none', MozUserSelect: 'none', WebkitUserDrag: 'none', touchAction: 'none' }}
              >
                {(() => {
                  const ext = String(clip?.uri || '').split('?')[0].split('#')[0].split('.').pop().toLowerCase()
                  const isVideo = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'].includes(ext)
                  if (isVideo) {
                    return <VideoFrame clip={clip} refEl={getVideoRef(tm.id)} style={{ width: '100%', height: '100%' }} />
                  }
                  if (imageMeta[tm.clip_id]?.src) {
                    return <img src={imageMeta[tm.clip_id].src} alt={clip?.name || tm.clip_id} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', userSelect: 'none', WebkitUserDrag: 'none' }} />
                  }
                  return <span style={{ padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none' }}>{clip?.name || tm.clip_id}</span>
                })()}
                {/* White 1px bounding box overlay */}
                <div style={{ position: 'absolute', inset: 0, border: '1px solid #ffffff', pointerEvents: 'none' }} />
              </div>
            )
          })}
        </div>
      </div>
      {/* Selection label (top-left of stage) */}
      <SelectionOverlay nodes={nodes} nodeIndex={nodeIndex} mediaById={mediaById} selectedId={selectedId} selectedClipId={selectedClipId} />

      {/* Viewport Controls */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'row', gap: 8, zIndex: 10, pointerEvents: 'none' }}>
        {/* Tool toggle */}
        <div style={{ display: 'flex', flexDirection: 'row', background: '#0f1115', border: '1px solid #232636', borderRadius: 4, overflow: 'hidden', pointerEvents: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
          <IconButton active={tool === 'select'} onClick={() => setTool('select')} title="Select">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" /><path d="M13 13l6 6" /></svg>
          </IconButton>
          <div style={{ width: 1, background: '#232636' }} />
          <IconButton active={tool === 'hand'} onClick={() => setTool('hand')} title="Pan">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" /><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" /><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
          </IconButton>
        </div>

        {/* Zoom controls */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <div style={{ display: 'flex', flexDirection: 'row', background: '#0f1115', border: '1px solid #232636', borderRadius: 4, overflow: 'hidden', pointerEvents: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
            <IconButton onClick={() => setZoom(z => clamp(z / 1.25, 0.01, 20))} title="Zoom Out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
            </IconButton>
            <div style={{ width: 1, background: '#232636' }} />
            <IconButton onClick={() => setZoom(z => clamp(z * 1.25, 0.01, 20))} title="Zoom In">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
            </IconButton>
          </div>
          <div style={{ padding: '2px 6px', fontSize: 12, color: '#b9c3d6', background: '#0f1115cc', border: '1px solid #232636', borderRadius: 4 }}>
            {Math.round(zoom * 100)}%
          </div>
        </div>
      </div>

      {menu.open && (
        <div style={{ position: 'fixed', left: menu.x, top: menu.y, background: '#0f1115', border: '1px solid #232636', borderRadius: 4, zIndex: 5000, minWidth: 160, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} onClick={(e) => { e.stopPropagation() }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
          <StageMenu
            onAddScreen={() => {
              setMenu({ open: false, x: 0, y: 0 })
              useEditorStore.getState().addScreenNode({ pixels: [1920, 1080] })
            }}
            onRemoveClip={() => {
              setMenu({ open: false, x: 0, y: 0 })
              const st = useEditorStore.getState()
              if (st.selectedClipId) st.removeClip(st.selectedClipId)
            }}
            onRemoveScreen={() => {
              setMenu({ open: false, x: 0, y: 0 })
              const st = useEditorStore.getState()
              const sel = st.selectedId
              if (!sel) return
              // ensure selected is a screen
              const nodes = st.scene?.roots || []
              const stack = [...nodes]
              let isScreen = false
              while (stack.length) {
                const n = stack.pop()
                if (!n) continue
                if (n.id === sel) { isScreen = n.kind?.type === 'screen'; break }
                if (n.children?.length) stack.push(...n.children)
              }
              if (isScreen) st.removeScreenNode(sel)
            }}
          />
        </div>
      )}
    </div>
  )
}

function VideoFrame({ clip, refEl, style }) {
  useEffect(() => {
    async function setSrc() {
      try {
        const uri = String(clip?.uri || '')
        if (!refEl?.current) return
        // Handle data:, http(s):, and file:// in Tauri
        if (/^data:/.test(uri) || /^https?:/.test(uri)) {
          refEl.current.src = uri
          return
        }
        if (uri.startsWith('file://')) {
          // (Tauri support removed)
          return
        }
      } catch { }
    }
    setSrc()
  }, [clip?.uri, refEl])
  return (
    <video ref={refEl} muted playsInline preload="auto" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', ...style }} />
  )
}

function Node2D({ node, center, scale, selectedId, onSelect, highlight }) {
  const t = node.transform
  const Z_NEUTRAL = 0.2
  const ratio = scale / 50 // since scale already includes zoom/Z_NEUTRAL, and BASE_SCALE is 50
  const x = (t?.position?.x ?? 0) * (ratio) + center.x
  const y = center.y - (t?.position?.y ?? 0) * (ratio)
  const s = t?.scale ?? { x: 1, y: 1, z: 1 }
  const isSelected = node.id === selectedId

  const children = (node.children ?? []).map((c) => (
    <Node2D key={c.id} node={c} center={center} scale={scale} selectedId={selectedId} onSelect={onSelect} />
  ))

  if (node.kind?.type === 'screen') {
    const px = node.kind?.pixels?.[0] || 0
    const py = node.kind?.pixels?.[1] || 0
    const w = Math.max(2, px * (ratio))
    const h = Math.max(2, py * (ratio))
    return (
      <>
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
          title={node.name || node.id}
          style={{ position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h, background: isSelected ? '#1c274a' : '#101520', border: `2px ${highlight ? 'dashed' : 'solid'} ${isSelected || highlight ? '#6aa0ff' : '#2a3148'}`, borderRadius: 4, zIndex: 1 }}
        />
        {children}
      </>
    )
  }

  // default: draw a small dot for other nodes
  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); onSelect(node.id) }} style={{ position: 'absolute', left: x - 2, top: y - 2, width: 4, height: 4, background: '#5a78ff', borderRadius: 2 }} title={node.name || node.id} />
      {children}
    </>
  )
}

function gridBg() {
  // legacy; not used
  return {}
}

function StageMenu({ onAddScreen, onRemoveClip, onRemoveScreen }) {
  const hasSelectedClip = useEditorStore((s) => !!s.selectedClipId)
  const selectedId = useEditorStore((s) => s.selectedId)
  const scene = useEditorStore((s) => s.scene)
  const isScreenSelected = useMemo(() => {
    if (!selectedId || !scene?.roots) return false
    const stack = [...scene.roots]
    while (stack.length) {
      const n = stack.pop()
      if (!n) continue
      if (n.id === selectedId) return n.kind?.type === 'screen'
      if (n.children?.length) stack.push(...n.children)
    }
    return false
  }, [selectedId, scene])
  return (
    <div>
      <MenuItem label="Add Screen" onClick={onAddScreen} />
      {hasSelectedClip && <MenuItem label="Remove Selected Clip" onClick={onRemoveClip} />}
      {isScreenSelected && <MenuItem label="Remove Screen" onClick={onRemoveScreen} />}
    </div>
  )
}

function MenuItem({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#c7cfdb', border: 'none', padding: '8px 12px', cursor: 'pointer' }}>
      {label}
    </button>
  )
}

function dotGridBg(center, zoom) {
  // Grid spacing scales with zoom relative to neutral 20%
  const Z_NEUTRAL = 0.2
  const factor = (zoom || Z_NEUTRAL) / Z_NEUTRAL
  const minorStep = Math.max(1, Math.round(100 * factor))
  const majorStep = Math.max(1, Math.round(1000 * factor))
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
  // Discrete levels with neutral at 20%; include deeper zoom-out
  const NEUTRAL = 0.2
  const levels = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 4, 10]
  return (
    <div style={{ display: 'flex', gap: 4, padding: '2px 4px', background: '#0f1115cc', border: '1px solid #232636', borderRadius: 4 }}>
      {levels.map((lv) => {
        const filled = zoom >= lv * 0.98 // small tolerance
        const isNeutral = Math.abs(lv - NEUTRAL) < 1e-6
        return (
          <div key={lv}
            title={`${Math.round(lv * 100)}%`}
            style={{
              width: 10,
              height: 8,
              background: filled ? '#6aa0ff' : '#2a3148',
              border: `1px solid ${isNeutral ? '#89b4ff' : '#3a4060'}`,
              borderRadius: 2,
            }}
          />
        )
      })}
    </div>
  )
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

function SelectionOverlay({ nodes, nodeIndex, mediaById, selectedId, selectedClipId }) {
  let text = ''
  if (selectedClipId) {
    // selectedClipId refers to timeline item id; resolve clip via tracks
    try {
      const proj = useEditorStore.getState().project
      let mediaEntry = null
      if (proj?.timeline?.tracks) {
        for (const t of proj.timeline.tracks) {
          if (t.media && t.media.id === selectedClipId) {
            mediaEntry = (proj.media || []).find(m => m.id === t.media.clip_id)
            break
          }
        }
      }
      text = mediaEntry?.name || mediaEntry?.id || selectedClipId
    } catch { text = selectedClipId }
  } else if (selectedId) {
    const n = nodeIndex.get(selectedId)
    if (n) {
      const prefix = n.kind?.type === 'screen' ? 'Screen' : 'Node'
      text = `${prefix}: ${n.name || n.id}`
    }
  }
  if (!text) return null
  return (
    <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, pointerEvents: 'none', padding: '2px 6px', fontSize: 12, color: '#b9c3d6', background: '#0f1115cc', border: '1px solid #232636', borderRadius: 4 }}>
      {text}
    </div>
  )
}

function IconButton({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? '#2a3148' : 'transparent',
        color: active ? '#6aa0ff' : '#c7cfdb',
        border: 'none',
        cursor: 'pointer',
        outline: 'none',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#1c202b' }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}
