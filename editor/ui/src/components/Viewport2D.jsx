import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { useEditorStore } from '../store.js'
import { computeFadeOpacity, buildFilterString } from '../utils/mediaUtils.js'
import { extFromUri, mediaTypeFromExt } from '../media/asset.js'
import {
  getNonOverlappingTrackItems,
  getTimelineItemAssetId,
  getTimelineItemDuration,
  getTimelineItemStart,
} from '../project/projectCodec.js'
import useClipVisibilitySync from '../hooks/useClipVisibilitySync.js'
import useImageMetaLoader from '../hooks/useImageMetaLoader.js'
import { clamp, dotGridBg, scaleFromZoom, ratioFromZoom, stageCenter, STAGE_W, STAGE_H, BASE_SCALE, Z_NEUTRAL } from './viewport2d/viewportMath.js'
import { Node2D } from './viewport2d/Node2D.jsx'
import { VideoFrame } from './viewport2d/VideoFrame.jsx'
import { StageMenu } from './viewport2d/StageMenu.jsx'
import { SelectionOverlay } from './viewport2d/SelectionOverlay.jsx'
import { IconButton } from './viewport2d/IconButton.jsx'
import { ModelPreview } from './viewport2d/ModelPreview.jsx'

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
        const t = e.target
        const tag = (t?.tagName || '').toLowerCase()
        if (t?.isContentEditable || tag === 'input' || tag === 'textarea') return
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

  const scale = scaleFromZoom(zoom)
  const center = stageCenter()

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
          const ratio = ratioFromZoom(zoom)
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
          const ratio = ratioFromZoom(zoom)
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
            const ratio = ratioFromZoom(zoom)
            const picked = []
            const tNow = useEditorStore.getState().time
            for (const { tm, screen, clip: mc } of placements) {
              const spos = screen?.transform?.position || { x: 0, y: 0, z: 0 }
              const cx = center.x + (spos.x ?? 0) * scale
              const cy = center.y - (spos.y ?? 0) * scale
              const isModelHit = /\.(gltf|glb|obj)$/i.test(mc?.name || mc?.uri || '')
              let w, h
              if (isModelHit) {
                const ms = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : 1
                const bsz = 200 * ms
                w = Math.max(2, bsz * ratio)
                h = w
              } else {
                const meta = imageMeta[getTimelineItemAssetId(tm)]
                const baseW = meta?.w || 100
                const baseH = meta?.h || 100
                const targetWpx = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW
                const targetHpx = (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH
                w = Math.max(2, targetWpx * ratio)
                h = Math.max(2, targetHpx * ratio)
              }
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
            const ratio = ratioFromZoom(zoom)
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
            const isModel = /\.(gltf|glb|obj)$/i.test(clip?.name || clip?.uri || '')
            const ratio = ratioFromZoom(zoom)
            let w, h
            if (isModel) {
              // 3D models: scale is a uniform multiplier, base size 200px
              const modelScale = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : 1
              const baseSz = 200 * modelScale
              w = Math.max(2, baseSz * ratio)
              h = w
            } else {
              const baseW = meta?.w || 100
              const baseH = meta?.h || 100
              const targetWpx = (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW
              const targetHpx = (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH
              w = Math.max(2, targetWpx * ratio)
              h = Math.max(2, targetHpx * ratio)
            }
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
                  background: isModel ? 'transparent' : '#0b0d12',
                  border: `1px solid ${isSel ? '#ffcc00' : (isModel ? 'transparent' : '#3a4060')}`,
                  boxShadow: isSel ? '0 0 0 1px #ffcc0066' : 'none',
                  borderRadius: 4,
                  overflow: isModel ? 'visible' : 'hidden',
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
                  const mediaType = mediaTypeFromExt(ext)
                  const isModel = /\.(gltf|glb|obj)$/i.test(clip?.name || uri_)
                  if (isModel) {
                    return <ModelPreview uri={uri_} size={Math.max(w, h)} />
                  }
                  if (mediaType === 'video') {
                    return <VideoFrame clip={clip} style={{ width: '100%', height: '100%' }} />
                  }
                  if (imageMeta[getTimelineItemAssetId(tm)]?.src) {
                    return <img src={imageMeta[getTimelineItemAssetId(tm)].src} alt={clip?.name || getTimelineItemAssetId(tm)} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', userSelect: 'none', WebkitUserDrag: 'none' }} />
                  }
                  return <span style={{ padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none' }}>{clip?.name || getTimelineItemAssetId(tm)}</span>
                })()}
                {/* White 1px bounding box overlay (hidden for 3D models) */}
                {!isModel && <div style={{ position: 'absolute', inset: 0, border: '1px solid #ffffff', pointerEvents: 'none' }} />}
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

              for (const { tm, clip: mc } of placements) {
                const mx = tm.position?.x || 0
                const my = tm.position?.y || 0
                const isModelFrame = /\.(gltf|glb|obj)$/i.test(mc?.name || mc?.uri || '')
                let tw, th
                if (isModelFrame) {
                  const ms = (tm.scale?.x > 0 ? tm.scale.x : 1)
                  tw = th = 200 * ms
                } else {
                  const meta = imageMeta[getTimelineItemAssetId(tm)]
                  tw = (tm.scale?.x > 0 ? tm.scale.x : meta?.w) || 100
                  th = (tm.scale?.y > 0 ? tm.scale.y : meta?.h) || 100
                }
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

