import React, { useMemo, useRef, useEffect, useState, useCallback, Suspense } from 'react'
import { useEditorStore } from '../store.js'
import { openImageDialog } from '../utils/fileDialogs.js'
import { resolveFileUrl } from '../utils/videoUtils.js'
import { computeFadeOpacity, buildFilterString } from '../utils/mediaUtils.js'
import { extFromUri, mediaTypeFromExt } from '../media/asset.js'
import {
  findMediaAssetByTimelineItem,
  getNonOverlappingTrackItems,
  getTimelineItemAssetId,
  getTimelineItemDuration,
  getTimelineItemStart,
} from '../project/projectCodec.js'
import useClipVisibilitySync from '../hooks/useClipVisibilitySync.js'
import useImageMetaLoader from '../hooks/useImageMetaLoader.js'
import { generateModelThumbnail } from '../utils/modelThumbnail.js'

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
  const [dragClip, setDragClip] = useState(null) // { targets: { [id]: { origX, origY, currentX, currentY } }, startX, startY, isDragging }
  const dragClipRef = useRef(null)
  const clipDraggedRef = useRef(false)
  const [menu, setMenu] = useState({ open: false, x: 0, y: 0 })
  const [marquee, setMarquee] = useState(null) // { x1, y1, x2, y2 }
  const draggedRef = useRef(false)
  const [tool, setTool] = useState('select') // 'select' | 'hand'
  const [shiftHeld, setShiftHeld] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceHeldRef = useRef(false)
  const [dragScreen, setDragScreen] = useState(null) // { nodeId, origX, origY, startX, startY, currentX, currentY }
  const dragScreenRef = useRef(null)

  // Global failsafe: if the pointer is released outside the element, end any active clip drag
  useEffect(() => {
    const endDrag = (e) => {
      if (dragClipRef.current && dragClipRef.current.targets && e.type !== 'pointercancel') {
        Object.entries(dragClipRef.current.targets).forEach(([id, data]) => {
          if (data.currentX !== undefined) {
            useEditorStore.getState().updateClipTransform({ timelineId: id, position: { x: data.currentX, y: data.currentY } })
          }
        })
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

  // Track shift key and handle Delete key for removing selected screen/clip
  useEffect(() => {
    const down = (e) => {
      if (e.key === 'Shift') setShiftHeld(true)
      if (e.key === ' ') { setSpaceHeld(true); spaceHeldRef.current = true; e.preventDefault() }
      if (e.key === 'f' || e.key === 'F') {
        // Trigger frame all via a synthetic click on the button
        document.querySelector('[title="Frame All (F)"]')?.click()
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const st = useEditorStore.getState()
        const sel = st.selectedId
        if (sel) {
          const nodes = st.scene?.roots || []
          const stack = [...nodes]
          while (stack.length) {
            const n = stack.pop()
            if (!n) continue
            if (n.id === sel) {
              if (n.kind?.type === 'screen') st.removeScreenNode(sel)
              break
            }
            if (n.children?.length) stack.push(...n.children)
          }
        } else if (st.selectedClipId) {
          st.removeClip(st.selectedClipId)
        }
      }
    }
    const up = (e) => {
      if (e.key === 'Shift') setShiftHeld(false)
      if (e.key === ' ') { setSpaceHeld(false); spaceHeldRef.current = false }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', () => { setShiftHeld(false); setSpaceHeld(false); spaceHeldRef.current = false })
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Global failsafe: commit screen drag on pointer release anywhere
  useEffect(() => {
    const endScreenDrag = (e) => {
      const d = dragScreenRef.current
      if (!d) return
      if (d.currentX !== undefined) {
        useEditorStore.getState().updateNodeTransform(d.nodeId, {
          position: { x: d.currentX, y: d.currentY, z: 0 },
        })
      }
      setDragScreen(null)
      dragScreenRef.current = null
    }
    window.addEventListener('pointerup', endScreenDrag, true)
    window.addEventListener('pointercancel', endScreenDrag, true)
    return () => {
      window.removeEventListener('pointerup', endScreenDrag, true)
      window.removeEventListener('pointercancel', endScreenDrag, true)
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
    return tracks.flatMap((t) => getNonOverlappingTrackItems(t))
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
      const clip = mediaById[getTimelineItemAssetId(m)]
      res.push({ tm: m, screen, clip })
    }
    return res
  }, [allTimelineItems, nodeIndex, mediaById])

  // 60fps store subscription for clip visibility + video sync (extracted hook)
  useClipVisibilitySync(clipRefs, videoRefs, allTimelineItems, setTimeDisplay, lastTimeUiRef)

  // Preload image natural sizes for clip placements (extracted hook)
  useImageMetaLoader(placements, imageMeta, setImageMeta)

  // Center the scroll on first mount
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollLeft = (STAGE_W - sc.clientWidth) / 2
    sc.scrollTop = (STAGE_H - sc.clientHeight) / 2
  }, [])

  const onPointerDown = useCallback((e) => {
    const isHand = tool === 'hand' || spaceHeldRef.current || (e.ctrlKey && e.altKey) || e.button === 1
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
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'auto', background: '#0b0d12', cursor: pan ? 'grabbing' : ((tool === 'hand' || spaceHeld) ? 'grab' : 'default'), overscrollBehavior: 'contain', outline: shiftHeld ? '2px solid #00e5ff' : 'none', outlineOffset: '-2px' }}
      >
        <div
          ref={stageRef}
          style={{ position: 'relative', width: STAGE_W, height: STAGE_H, ...dotGridBg(center, zoom) }}
          onClick={(e) => { if (!draggedRef.current && !e.ctrlKey) { setSelected(null); setSelectedClips([]) } }}
          onPointerDown={(e) => {
            // Start marquee selection only on empty space (not when Ctrl+Alt panning or clicking a clip)
            if (e.button !== 0) return
            if (tool === 'hand' || spaceHeldRef.current || (e.ctrlKey && e.altKey)) return
            if (e.target !== stageRef.current) return
            const sc = scrollRef.current
            if (!sc) return
            const rect = sc.getBoundingClientRect()
            const x = sc.scrollLeft + (e.clientX - rect.left)
            const y = sc.scrollTop + (e.clientY - rect.top)
            setMarquee({ x1: x, y1: y, x2: x, y2: y })
            draggedRef.current = false
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
            setMarquee((m) => {
              if (m) draggedRef.current = true
              return (m ? { ...m, x2: x, y2: y } : m)
            })
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
              const meta = imageMeta[getTimelineItemAssetId(tm)]
              const baseW = meta?.w || 100
              const baseH = meta?.h || 100
              const targetWpx = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW
              const targetHpx = (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH
              const w = Math.max(2, targetWpx * ratio)
              const h = Math.max(2, targetHpx * ratio)
              const left = cx + (tm.position?.x || 0) * ratio - w / 2
              const top = cy - (tm.position?.y || 0) * ratio - h / 2
              const inter = (mx < left + w) && (mx + mw > left) && (my < top + h) && (my + mh > top)
              const start = getTimelineItemStart(tm)
              const dur = getTimelineItemDuration(tm)
              const isActive = tNow >= start && tNow <= start + dur
              if (inter && isActive) picked.push(tm.id)
            }
            const current = new Set(selectedClipIds)
            picked.forEach(id => current.add(id))
            setSelectedClips(Array.from(current))
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
            <Node2D key={n.id} node={n} center={center} scale={scale} selectedId={selectedId} onSelect={setSelected} highlight={dnd.over && dnd.screenId === n.id} shiftHeld={shiftHeld} dragScreen={dragScreen} setDragScreen={setDragScreen} dragScreenRef={dragScreenRef} />
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
            const meta = imageMeta[getTimelineItemAssetId(tm)]
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
            const start = getTimelineItemStart(tm)
            const dur = getTimelineItemDuration(tm)
            const isActive = tNow >= start && tNow <= start + dur

            const finalOpacity = computeFadeOpacity(tm, tNow)

            return (
              <div key={idx} ref={getClipRef(tm.id)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (clipDraggedRef.current) {
                    clipDraggedRef.current = false
                    return
                  }
                  if (e.ctrlKey) {
                    if (selectedClipIds.includes(tm.id)) {
                      setSelectedClips(selectedClipIds.filter(id => id !== tm.id))
                    } else {
                      setSelectedClips([...selectedClipIds, tm.id])
                    }
                  } else {
                    setSelectedClips([tm.id])
                  }
                }}
                onPointerDown={(e) => {
                  if (tool === 'hand') return
                  if (e.button !== 0) return
                  e.stopPropagation()
                  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }

                  const isSelected = selectedClipIds.includes(tm.id)
                  const draggingIds = isSelected ? [...new Set([...selectedClipIds, tm.id])] : [tm.id]
                  const targets = {}
                  draggingIds.forEach(id => {
                    const item = allTimelineItems.find(m => m.id === id)
                    if (item) {
                      targets[id] = {
                        origX: item.position?.x || 0,
                        origY: item.position?.y || 0
                      }
                    }
                  })

                  const d = { startX: e.clientX, startY: e.clientY, targets, isDragging: false }
                  setDragClip(d)
                  dragClipRef.current = d
                  clipDraggedRef.current = false
                }}
                onPointerMove={(e) => {
                  if (!dragClipRef.current) return
                  if ((e.buttons & 1) === 0) { setDragClip(null); dragClipRef.current = null; return }

                  const dx = e.clientX - dragClipRef.current.startX
                  const dy = e.clientY - dragClipRef.current.startY

                  if (!dragClipRef.current.isDragging && Math.hypot(dx, dy) > 3) {
                    dragClipRef.current.isDragging = true
                  }

                  const newTargets = {}
                  Object.entries(dragClipRef.current.targets).forEach(([id, init]) => {
                    newTargets[id] = {
                      ...init,
                      currentX: init.origX + dx / ratio,
                      currentY: init.origY - dy / ratio
                    }
                  })

                  const newDrag = { ...dragClipRef.current, targets: newTargets }
                  dragClipRef.current = newDrag
                  setDragClip(newDrag)
                }}
                onPointerUp={(e) => {
                  if (dragClipRef.current) {
                    if (dragClipRef.current.isDragging) {
                      clipDraggedRef.current = true
                      Object.entries(dragClipRef.current.targets).forEach(([id, data]) => {
                        if (data.currentX !== undefined) {
                          useEditorStore.getState().updateClipTransform({ timelineId: id, position: { x: data.currentX, y: data.currentY } })
                        }
                      })
                    }
                    setDragClip(null)
                    dragClipRef.current = null
                  }
                  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
                }}
                onDragStart={(e) => { e.preventDefault() }}
                onPointerCancel={(e) => { if (dragClipRef.current) { setDragClip(null); dragClipRef.current = null } try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { } }}
                title={(clip?.name || getTimelineItemAssetId(tm)) + ` (${getTimelineItemStart(tm).toFixed?.(2)}s)`}
                style={{
                  position: 'absolute',
                  left: (dragClip?.targets?.[tm.id]?.currentX !== undefined) ? (cx + dragClip.targets[tm.id].currentX * ratio - w / 2) : left,
                  top: (dragClip?.targets?.[tm.id]?.currentY !== undefined) ? (cy - dragClip.targets[tm.id].currentY * ratio - h / 2) : top,
                  width: w,
                  height: h,
                  background: '#0b0d12',
                  border: `1px solid ${isSel ? '#ffcc00' : '#3a4060'}`,
                  boxShadow: isSel ? '0 0 0 1px #ffcc0066' : 'none',
                  borderRadius: 4,
                  overflow: 'hidden',
                  display: isActive ? 'flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#c7cfdb',
                  fontSize: 11,
                  pointerEvents: shiftHeld ? 'none' : 'auto',
                  zIndex: 5,
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                  MozUserSelect: 'none',
                  WebkitUserDrag: 'none',
                  touchAction: 'none',
                  opacity: shiftHeld ? 0.4 : finalOpacity,
                  filter: shiftHeld ? 'grayscale(1)' : buildFilterString(tm)
                }}
              >
                {(() => {
                  const uri_ = String(clip?.uri || '')
                  const ext = extFromUri(uri_) || extFromUri(clip?.name || '')
                  const isVideo = mediaTypeFromExt(ext) === 'video'
                  if (isVideo) {
                    return <VideoFrame clip={clip} style={{ width: '100%', height: '100%' }} />
                  }
                  if (imageMeta[getTimelineItemAssetId(tm)]?.src) {
                    return <img src={imageMeta[getTimelineItemAssetId(tm)].src} alt={clip?.name || getTimelineItemAssetId(tm)} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', userSelect: 'none', WebkitUserDrag: 'none' }} />
                  }
                  return <span style={{ padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none' }}>{clip?.name || getTimelineItemAssetId(tm)}</span>
                })()}
                {/* White 1px bounding box overlay */}
                <div style={{ position: 'absolute', inset: 0, border: '1px solid #ffffff', pointerEvents: 'none' }} />
              </div>
            )
          })}
        </div>
      </div>
      {/* Selection label (top-left of stage) */}
      <SelectionOverlay nodes={nodes} nodeIndex={nodeIndex} selectedId={selectedId} selectedClipId={selectedClipId} />

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
          <div style={{ display: 'flex', flexDirection: 'row', background: '#0f1115', border: '1px solid #232636', borderRadius: 4, overflow: 'hidden', pointerEvents: 'auto', boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
            <IconButton onClick={() => {
              // Compute bounding box of all screens and clips in world-space
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
              let hasContent = false

              for (const n of nodes) {
                if (n.kind?.type !== 'screen') continue
                const px = n.kind?.pixels?.[0] || 0
                const py = n.kind?.pixels?.[1] || 0
                if (px <= 0 || py <= 0) continue
                const sx = n.transform?.position?.x || 0
                const sy = n.transform?.position?.y || 0
                minX = Math.min(minX, sx - px / 2)
                maxX = Math.max(maxX, sx + px / 2)
                minY = Math.min(minY, sy - py / 2)
                maxY = Math.max(maxY, sy + py / 2)
                hasContent = true
              }

              for (const { tm } of placements) {
                const mx = tm.position?.x || 0
                const my = tm.position?.y || 0
                const meta = imageMeta[getTimelineItemAssetId(tm)]
                const tw = (tm.scale?.x > 0 ? tm.scale.x : meta?.w) || 100
                const th = (tm.scale?.y > 0 ? tm.scale.y : meta?.h) || 100
                minX = Math.min(minX, mx - tw / 2)
                maxX = Math.max(maxX, mx + tw / 2)
                minY = Math.min(minY, my - th / 2)
                maxY = Math.max(maxY, my + th / 2)
                hasContent = true
              }

              if (!hasContent) return

              const padding = 100
              const worldW = (maxX - minX) + padding * 2
              const worldH = (maxY - minY) + padding * 2
              const sc = scrollRef.current
              if (!sc) return
              const viewW = sc.clientWidth
              const viewH = sc.clientHeight

              const fitZoom = Math.min(viewW / worldW, viewH / worldH) * Z_NEUTRAL / BASE_SCALE
              const clampedZoom = clamp(fitZoom, 0.01, 20)
              setZoom(clampedZoom)

              const newRatio = (clampedZoom / Z_NEUTRAL)
              const centerWorldX = (minX + maxX) / 2
              const centerWorldY = (minY + maxY) / 2
              requestAnimationFrame(() => {
                const s = scrollRef.current
                if (!s) return
                s.scrollLeft = STAGE_W / 2 + centerWorldX * newRatio - s.clientWidth / 2
                s.scrollTop = STAGE_H / 2 - centerWorldY * newRatio - s.clientHeight / 2
              })
            }} title="Frame All (F)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M15 3v18" /><path d="M3 9h18" /><path d="M3 15h18" /></svg>
            </IconButton>
          </div>
        </div>
      </div>

      {menu.open && (
        <div style={{ position: 'fixed', left: menu.x, top: menu.y, background: '#0f1115', border: '1px solid #232636', borderRadius: 4, zIndex: 5000, minWidth: 160, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} onClick={(e) => { e.stopPropagation() }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
          <StageMenu
            onAddScreen={(screenType) => {
              setMenu({ open: false, x: 0, y: 0 })
              useEditorStore.getState().addScreenNode({ pixels: [1920, 1080], screenType })
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

function VideoFrame({ clip, style }) {
  const [thumb, setThumb] = useState(null)
  const uri = String(clip?.uri || '')

  useEffect(() => {
    let cancelled = false
    async function loadThumb() {
      try {
        const { generateVideoThumbnail } = await import('../utils/videoUtils.js')
        const dataUrl = await generateVideoThumbnail(uri, 0)
        if (!cancelled) setThumb(dataUrl)
      } catch { }
    }
    if (uri) loadThumb()
    return () => { cancelled = true }
  }, [uri])

  if (thumb) {
    return <img src={thumb} alt={clip?.name || ''} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', ...style }} />
  }
  return <span style={{ padding: '0 4px', color: '#888', fontSize: 11, userSelect: 'none', ...style }}>{clip?.name || 'video'}</span>
}

function Node2D({ node, center, scale, selectedId, onSelect, highlight, shiftHeld, dragScreen, setDragScreen, dragScreenRef }) {
  const t = node.transform
  const Z_NEUTRAL = 0.2
  const ratio = scale / 50 // since scale already includes zoom/Z_NEUTRAL, and BASE_SCALE is 50
  const posX = (t?.position?.x ?? 0)
  const posY = (t?.position?.y ?? 0)
  const x = posX * ratio + center.x
  const y = center.y - posY * ratio
  const s = t?.scale ?? { x: 1, y: 1, z: 1 }
  const isSelected = node.id === selectedId

  const children = (node.children ?? []).map((c) => (
    <Node2D key={c.id} node={c} center={center} scale={scale} selectedId={selectedId} onSelect={onSelect} shiftHeld={shiftHeld} dragScreen={dragScreen} setDragScreen={setDragScreen} dragScreenRef={dragScreenRef} />
  ))

  if (node.kind?.type === 'screen') {
    const px = node.kind?.pixels?.[0] || 0
    const py = node.kind?.pixels?.[1] || 0
    const w = Math.max(2, px * (ratio))
    const h = Math.max(2, py * (ratio))
    const isRenderer = (node.kind?.screenType || 'web') === 'renderer'
    const borderColor = isSelected || highlight ? '#ffcc00' : '#3a4e85'

    // Apply drag offset if this screen is being dragged
    const isDragging = dragScreen?.nodeId === node.id
    const drawX = isDragging && dragScreen.currentX !== undefined ? dragScreen.currentX * ratio + center.x : x
    const drawY = isDragging && dragScreen.currentY !== undefined ? center.y - dragScreen.currentY * ratio : y
    const screenLabel = `${node.name || node.id} (${px}x${py})`
    const typeTag = isRenderer ? 'NDI' : 'Web'

    return (
      <>
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
          onPointerDown={(e) => {
            if (!shiftHeld || e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
            onSelect(node.id)
            const d = { nodeId: node.id, origX: posX, origY: posY, startX: e.clientX, startY: e.clientY }
            setDragScreen(d)
            dragScreenRef.current = d
          }}
          onPointerMove={(e) => {
            const d = dragScreenRef.current
            if (!d || d.nodeId !== node.id) return
            if ((e.buttons & 1) === 0) { setDragScreen(null); dragScreenRef.current = null; return }
            const dx = e.clientX - d.startX
            const dy = e.clientY - d.startY
            const next = { ...d, currentX: d.origX + dx / ratio, currentY: d.origY - dy / ratio }
            dragScreenRef.current = next
            setDragScreen(next)
          }}
          onPointerUp={(e) => {
            const d = dragScreenRef.current
            if (!d || d.nodeId !== node.id) return
            if (d.currentX !== undefined) {
              useEditorStore.getState().updateNodeTransform(d.nodeId, {
                position: { x: d.currentX, y: d.currentY, z: 0 },
              })
            }
            setDragScreen(null)
            dragScreenRef.current = null
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
          }}
          title={screenLabel}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{ position: 'absolute', left: drawX - w / 2, top: drawY - h / 2, width: w, height: h, background: isSelected ? 'rgba(30,40,80,0.5)' : 'rgba(16,21,32,0.5)', border: `1px dashed ${borderColor}`, borderRadius: 2, zIndex: 1, cursor: shiftHeld ? 'move' : (isSelected ? 'not-allowed' : 'default') }}
        >
          {shiftHeld && <>
            <span style={{ position: 'absolute', top: 3, left: 5, fontSize: 10, color: '#8898b8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: w - 10, pointerEvents: 'none', userSelect: 'none' }}>
              {screenLabel}
            </span>
            <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9, color: isRenderer ? '#a78bfa' : '#6aa0ff', fontWeight: 600, pointerEvents: 'none', userSelect: 'none', background: 'rgba(0,0,0,0.4)', padding: '1px 4px', borderRadius: 2 }}>
              {typeTag}
            </span>
          </>}
        </div>
        {children}
      </>
    )
  }

  // Model nodes: render thumbnail preview
  if (node.kind?.type === 'model') {
    return <ModelNode2D node={node} x={x} y={y} ratio={ratio} isSelected={isSelected} onSelect={onSelect}>{children}</ModelNode2D>
  }

  // default: draw a small dot for other nodes
  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); onSelect(node.id) }} style={{ position: 'absolute', left: x - 2, top: y - 2, width: 4, height: 4, background: '#5a78ff', borderRadius: 2 }} title={node.name || node.id} />
      {children}
    </>
  )
}

function ModelNode2D({ node, x, y, ratio, isSelected, onSelect, children }) {
  const [thumb, setThumb] = useState(null)
  const uri = node.kind?.uri

  useEffect(() => {
    if (!uri) return
    let cancelled = false
    generateModelThumbnail(uri).then(url => {
      if (!cancelled) setThumb(url)
    })
    return () => { cancelled = true }
  }, [uri])

  const sz = Math.max(40, 80 * ratio)
  const borderColor = isSelected ? '#ffcc00' : '#a78bfa'

  return (
    <>
      <div
        onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
        title={node.name || node.id}
        style={{
          position: 'absolute',
          left: x - sz / 2,
          top: y - sz / 2,
          width: sz,
          height: sz,
          border: `1px dashed ${borderColor}`,
          borderRadius: 4,
          background: '#0b0d12',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 2,
          overflow: 'hidden',
        }}
      >
        {thumb ? (
          <img src={thumb} alt={node.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} draggable={false} />
        ) : (
          <span className="ms" style={{ fontSize: Math.max(16, sz * 0.4), color: '#a78bfa', opacity: 0.8 }}>view_in_ar</span>
        )}
        <span style={{
          position: 'absolute', bottom: 2, left: 0, right: 0,
          fontSize: Math.max(8, Math.min(10, sz * 0.11)),
          color: '#c7cfdb', textAlign: 'center',
          background: 'rgba(0,0,0,0.6)', padding: '1px 4px',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {node.name || 'Model'}
        </span>
      </div>
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
      <MenuItem label="Add Web Screen" onClick={() => onAddScreen('web')} />
      <MenuItem label="Add Renderer Screen" onClick={() => onAddScreen('renderer')} />
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

// Cache for the grid tile canvas data URL
const _gridCache = { key: '', url: '' }

function dotGridBg(center, zoom) {
  const Z_NEUTRAL = 0.2
  const BASE_SCALE = 50
  const pxPerUnit = BASE_SCALE * (zoom / Z_NEUTRAL)

  // Adaptive: pick smallest world-space interval that gives >= 16px on screen
  const levels = [10, 50, 100, 500, 1000, 5000]
  let minorWorld = 100
  for (const lv of levels) {
    if (lv * pxPerUnit >= 16) { minorWorld = lv; break }
  }
  const majorMult = 10
  const minorPx = Math.round(minorWorld * pxPerUnit)
  const tilePx = minorPx * majorMult // tile = one major cell = 10 minor cells

  if (minorPx < 4) return { background: '#0b0d12' }

  // Build a single canvas tile with both minor and major dots baked in
  const cacheKey = `${tilePx}_${minorPx}`
  if (_gridCache.key !== cacheKey) {
    const c = document.createElement('canvas')
    c.width = tilePx
    c.height = tilePx
    const ctx = c.getContext('2d')

    // Minor dots
    ctx.fillStyle = '#2a375b'
    for (let gy = 0; gy < majorMult; gy++) {
      for (let gx = 0; gx < majorMult; gx++) {
        if (gx === 0 && gy === 0) continue // skip origin — major dot goes there
        const x = gx * minorPx
        const y = gy * minorPx
        ctx.beginPath()
        ctx.arc(x, y, 1, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Major dot at tile origin (0,0) — larger and brighter
    ctx.fillStyle = '#6a8fd8'
    ctx.beginPath()
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2)
    ctx.fill()

    _gridCache.key = cacheKey
    _gridCache.url = c.toDataURL()
  }

  // Offset so tile origin aligns with world origin (center of stage)
  const mod = (v, m) => ((v % m) + m) % m
  const offX = mod(center.x, tilePx)
  const offY = mod(center.y, tilePx)

  return {
    backgroundImage: `url(${_gridCache.url})`,
    backgroundSize: `${tilePx}px ${tilePx}px`,
    backgroundPosition: `${offX}px ${offY}px`,
    backgroundRepeat: 'repeat',
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

function SelectionOverlay({ nodes, nodeIndex, selectedId, selectedClipId }) {
  let text = ''
  if (selectedClipId) {
    try {
      const proj = useEditorStore.getState().project
      const mediaEntry = findMediaAssetByTimelineItem(proj, selectedClipId)
      text = mediaEntry?.name || mediaEntry?.id || selectedClipId
    } catch { text = selectedClipId }
  } else if (selectedId) {
    const n = nodeIndex.get(selectedId)
    if (n) {
      const prefix = n.kind?.type === 'screen'
        ? `Screen (${n.kind?.screenType || 'web'})`
        : 'Node'
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
