import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { useEditorStore } from '../store.js'
import { computeOverlaps, computeFadeOpacity, buildFilterString } from '../utils/mediaUtils.js'
import { extFromUri, mediaTypeFromExt } from '../media/asset.js'
import useClipVisibilitySync from '../hooks/useClipVisibilitySync.js'
import useImageMetaLoader from '../hooks/useImageMetaLoader.js'
import { isEditableTarget } from '../hooks/useShortcuts.js'
import { viewportActions } from '../viewportActions.js'
import { trackMedia, clipStart, clipDuration } from '../utils/clipTime.js'
import { snapValue, snapOffsets, collectStageSnapTargets } from '../utils/snap.js'
import { resizeRect, isCorner } from '../utils/resizeRect.js'
import ContextMenu from './ContextMenu.jsx'
import Node2D from './viewport2d/Node2D.jsx'
import VideoFrame from './viewport2d/VideoFrame.jsx'
import SelectionOverlay from './viewport2d/SelectionOverlay.jsx'
import ViewportToolbar from './viewport2d/ViewportToolbar.jsx'
import ResizeHandles from './viewport2d/ResizeHandles.jsx'
import { dotGridBg } from './viewport2d/dotGridBg.js'
import {
  Z_NEUTRAL, ZOOM_MIN, ZOOM_MAX, STAGE_W, STAGE_H, STAGE_CENTER,
  clamp, ratioForZoom, scaleForZoom,
} from './viewport2d/constants.js'
import { worldToStage, stageToWorld, clipWorldRect, screenWorldRect, rectToStage, isClipActive, rectsIntersect } from './viewport2d/stageMath.js'

const DRAG_THRESHOLD_PX = 3
const SNAP_PX = 6
const MIN_CLIP_SIZE = 8

function Viewport2D() {
  const scene = useEditorStore((s) => s.scene)
  const project = useEditorStore((s) => s.project)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips)
  const selectedId = useEditorStore((s) => s.selectedId)
  const setSelected = useEditorStore((s) => s.setSelected)
  const showOutputOverlay = useEditorStore((s) => s.showOutputOverlay)

  const scrollRef = useRef(null)
  const stageRef = useRef(null)
  const [zoom, setZoom] = useState(0.02)
  const [pan, setPan] = useState(null)
  const [imageMeta, setImageMeta] = useState({})
  const [dnd, setDnd] = useState({ over: false, screenId: null })
  const [dragClip, setDragClip] = useState(null)
  const dragClipRef = useRef(null)
  const clipDraggedRef = useRef(false)
  const [menu, setMenu] = useState(null)
  const [marquee, setMarquee] = useState(null)
  const draggedRef = useRef(false)
  const [tool, setTool] = useState('select')
  const [shiftHeld, setShiftHeld] = useState(false)
  const [dragScreen, setDragScreen] = useState(null)
  const dragScreenRef = useRef(null)
  const [resize, setResize] = useState(null)
  const resizeRef = useRef(null)
  const [snapGuides, setSnapGuides] = useState(null)

  const scale = scaleForZoom(zoom)
  const ratio = ratioForZoom(zoom)
  const center = STAGE_CENTER
  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds])

  const nodes = useMemo(() => (scene?.roots ?? []), [scene])
  const nodeIndex = useMemo(() => {
    const map = new Map()
    function walk(n) { if (!n) return; map.set(n.id, n); (n.children || []).forEach(walk) }
    nodes.forEach(walk)
    return map
  }, [nodes])
  const mediaById = useMemo(() => Object.fromEntries((project?.media || []).map((m) => [m.id, m])), [project])
  const allTimelineItems = useMemo(() => {
    const tracks = project?.timeline?.tracks || []
    return tracks.flatMap((t) => {
      const list = trackMedia(t)
      const overlaps = computeOverlaps(list)
      return list.filter((m) => !overlaps.has(m.id))
    })
  }, [project])

  const clipRefs = useRef(new Map())
  const getClipRef = (id) => {
    if (!clipRefs.current.has(id)) clipRefs.current.set(id, React.createRef())
    return clipRefs.current.get(id)
  }
  const videoRefs = useRef(new Map())

  const placements = useMemo(() => {
    const res = []
    const live = new Set()
    for (const m of allTimelineItems) {
      const screen = m.target_node_id ? nodeIndex.get(m.target_node_id) : null
      live.add(m.id)
      res.push({ tm: m, screen, clip: mediaById[m.clip_id] })
    }
    // Drop refs for clips that are gone; these maps used to grow for the
    // lifetime of the session.
    for (const id of [...clipRefs.current.keys()]) if (!live.has(id)) clipRefs.current.delete(id)
    for (const id of [...videoRefs.current.keys()]) if (!live.has(id)) videoRefs.current.delete(id)
    return res
  }, [allTimelineItems, nodeIndex, mediaById])

  /** World rect of a clip, resolving a 0 scale through the probed size. */
  const rectOf = useCallback(
    ({ tm, screen }) => clipWorldRect(tm, screen, imageMeta[tm.clip_id]),
    [imageMeta],
  )

  // --- Drag commit --------------------------------------------------------

  /**
   * One idempotent commit for a clip drag.
   *
   * Both the element's pointerup and a window-level failsafe can fire (the
   * failsafe captures, so it usually wins). Dragging N clips also used to
   * write N times and therefore need N undo steps.
   */
  const commitClipDrag = useCallback(() => {
    const d = dragClipRef.current
    dragClipRef.current = null
    setDragClip(null)
    setSnapGuides(null)
    if (!d?.isDragging) return
    const patches = Object.entries(d.targets)
      .filter(([, v]) => v.currentX !== undefined)
      .map(([id, v]) => ({ timelineId: id, position: { x: v.currentX, y: v.currentY } }))
    if (!patches.length) return
    clipDraggedRef.current = true
    // Each clip lands at its own position, so a single shared patch will not
    // do; the batch is what turns N writes into one history entry.
    const st = useEditorStore.getState()
    st.beginUndoBatch(patches.length > 1 ? `Move ${patches.length} Clips` : 'Move Clip')
    try {
      for (const p of patches) st.updateClipTransform({ timelineId: p.timelineId, position: p.position, label: 'Move Clip' })
    } finally {
      st.endUndoBatch()
    }
  }, [])

  // Global failsafe: the pointer can be released outside the element.
  useEffect(() => {
    const endDrag = (e) => {
      if (e.type === 'pointercancel') { dragClipRef.current = null; setDragClip(null); return }
      if (dragClipRef.current) commitClipDrag()
    }
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)
    return () => {
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
    }
  }, [commitClipDrag])

  // Shift = screens-only picking mode. Space is no longer a pan modifier:
  // it plays and pauses, like every other editor.
  useEffect(() => {
    const down = (e) => {
      if (isEditableTarget(e.target)) return
      if (e.key === 'Shift') setShiftHeld(true)
    }
    const up = (e) => { if (e.key === 'Shift') setShiftHeld(false) }
    const onBlur = () => setShiftHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Global failsafe: commit a screen drag on release anywhere.
  useEffect(() => {
    const endScreenDrag = () => {
      const d = dragScreenRef.current
      if (!d) return
      if (d.moved && d.currentX !== undefined) {
        useEditorStore.getState().updateNodeTransform(d.nodeId, { position: { x: d.currentX, y: d.currentY, z: 0 } })
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

  // --- Zoom ---------------------------------------------------------------

  /** Zoom about a point, keeping whatever is under it fixed. */
  const applyZoom = useCallback((nextZoom, clientX, clientY) => {
    const sc = scrollRef.current
    if (!sc) return
    const target = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX)
    if (target === zoom) return
    const rect = sc.getBoundingClientRect()
    const ax = clientX ?? rect.left + rect.width / 2
    const ay = clientY ?? rect.top + rect.height / 2
    const contentLeft = sc.scrollLeft + (ax - rect.left)
    const contentTop = sc.scrollTop + (ay - rect.top)
    const world = stageToWorld(contentLeft, contentTop, ratioForZoom(zoom), center)

    setZoom(target)

    const after = worldToStage(world.x, world.y, ratioForZoom(target), center)
    sc.scrollLeft = after.x - (ax - rect.left)
    sc.scrollTop = after.y - (ay - rect.top)
  }, [zoom, center])

  const zoomTo100 = useCallback(() => applyZoom(Z_NEUTRAL), [applyZoom])

  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    const handler = (e) => {
      e.preventDefault()
      applyZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
    }
    sc.addEventListener('wheel', handler, { passive: false })
    return () => sc.removeEventListener('wheel', handler)
  }, [applyZoom, zoom])

  // Ctrl/Cmd +/-. Kept local (rather than in App's shortcut table) because
  // it needs the viewport's own geometry to anchor the zoom.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const plus = e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd'
      const minus = e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract'
      if (!plus && !minus) return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      applyZoom(zoom * (plus ? 1.1 : 1 / 1.1))
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [applyZoom, zoom])

  // --- Framing ------------------------------------------------------------

  const frameBounds = useCallback((bounds) => {
    if (!bounds) return
    const { minX, minY, maxX, maxY } = bounds
    const sc = scrollRef.current
    if (!sc) return
    const padding = 100
    const worldW = (maxX - minX) + padding * 2
    const worldH = (maxY - minY) + padding * 2
    if (!(worldW > 0 && worldH > 0)) return

    // Stage rects are measured in media pixels, and `ratioForZoom` is screen
    // pixels per media pixel, so the fit is ratio * Z_NEUTRAL. The old
    // formula also divided by BASE_SCALE, making every fit 50x too small —
    // it always bottomed out at the minimum zoom, so "Frame All" left the
    // content a few pixels across.
    const fitRatio = Math.min(sc.clientWidth / worldW, sc.clientHeight / worldH)
    const clamped = clamp(fitRatio * Z_NEUTRAL, ZOOM_MIN, ZOOM_MAX)
    setZoom(clamped)

    const c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    requestAnimationFrame(() => {
      const s = scrollRef.current
      if (!s) return
      const p = worldToStage(c.x, c.y, ratioForZoom(clamped), center)
      s.scrollLeft = p.x - s.clientWidth / 2
      s.scrollTop = p.y - s.clientHeight / 2
    })
  }, [center])

  /** Bounding box of a set of world rects. */
  const boundsOf = useCallback((rects) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let any = false
    for (const r of rects) {
      if (!r || !(r.w > 0) || !(r.h > 0)) continue
      minX = Math.min(minX, r.cx - r.w / 2)
      maxX = Math.max(maxX, r.cx + r.w / 2)
      minY = Math.min(minY, r.cy - r.h / 2)
      maxY = Math.max(maxY, r.cy + r.h / 2)
      any = true
    }
    return any ? { minX, minY, maxX, maxY } : null
  }, [])

  const frameAll = useCallback(() => {
    const rects = [
      ...nodes.filter((n) => n.kind?.type === 'screen').map(screenWorldRect),
      ...placements.map(rectOf),
    ]
    frameBounds(boundsOf(rects))
  }, [nodes, placements, rectOf, frameBounds, boundsOf])

  const frameSelected = useCallback(() => {
    const st = useEditorStore.getState()
    const rects = []
    if (st.selectedId) {
      const n = nodeIndex.get(st.selectedId)
      if (n?.kind?.type === 'screen') rects.push(screenWorldRect(n))
    }
    const wanted = new Set(st.selectedClipIds)
    for (const p of placements) if (wanted.has(p.tm.id)) rects.push(rectOf(p))
    const b = boundsOf(rects)
    if (!b) { st.setStatus('Nothing selected to frame', 'warn'); return }
    frameBounds(b)
  }, [nodeIndex, placements, rectOf, frameBounds, boundsOf])

  useEffect(() => {
    viewportActions.frameAll = frameAll
    viewportActions.frameSelected = frameSelected
    viewportActions.zoomTo100 = zoomTo100
    return () => {
      if (viewportActions.frameAll === frameAll) viewportActions.frameAll = null
      if (viewportActions.frameSelected === frameSelected) viewportActions.frameSelected = null
      if (viewportActions.zoomTo100 === zoomTo100) viewportActions.zoomTo100 = null
    }
  }, [frameAll, frameSelected, zoomTo100])

  // 60fps clip visibility + video sync
  useClipVisibilitySync(clipRefs, videoRefs, allTimelineItems)
  useImageMetaLoader(placements, imageMeta, setImageMeta)

  // Centre the scroll on first mount
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    sc.scrollLeft = (STAGE_W - sc.clientWidth) / 2
    sc.scrollTop = (STAGE_H - sc.clientHeight) / 2
  }, [])

  // --- Pan ----------------------------------------------------------------

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
    sc.scrollLeft = pan.startLeft - (e.clientX - pan.startX)
    sc.scrollTop = pan.startTop - (e.clientY - pan.startY)
    e.preventDefault()
  }, [pan])

  const onPointerUp = useCallback((e) => {
    if (!pan) return
    setPan(null)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
  }, [pan])

  // --- Snapping helpers ---------------------------------------------------

  const stageSnapTargets = useCallback((excludeIds) => collectStageSnapTargets({
    screens: nodes.filter((n) => n.kind?.type === 'screen' && (n.kind?.enabled ?? true)).map(screenWorldRect),
    clips: placements.map(rectOf),
    excludeIds,
  }), [nodes, placements, rectOf])

  // --- Resize -------------------------------------------------------------

  const singleSelected = selectedClipIds.length === 1
    ? placements.find((p) => p.tm.id === selectedClipIds[0])
    : null

  const onResizeStart = useCallback((handle, e) => {
    if (!singleSelected) return
    const r = rectOf(singleSelected)
    const d = {
      id: singleSelected.tm.id,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig: r,
      rect: r,
    }
    resizeRef.current = d
    setResize(d)
  }, [singleSelected, rectOf])

  useEffect(() => {
    if (!resize) return
    const onMove = (e) => {
      const d = resizeRef.current
      if (!d) return
      // Screen y grows downward, world y grows upward.
      const dx = (e.clientX - d.startX) / ratio
      const dy = -(e.clientY - d.startY) / ratio
      let next = resizeRect(d.orig, d.handle, dx, dy, {
        // Corners keep the aspect ratio; Shift frees it.
        keepAspect: isCorner(d.handle) && !e.shiftKey,
        minSize: MIN_CLIP_SIZE,
      })
      // Snap the edge the handle is actually dragging, then re-run the
      // resize with the adjusted delta so the geometry stays consistent.
      let guides = null
      if (!e.altKey) {
        const targets = stageSnapTargets([d.id])
        const threshold = SNAP_PX / ratio
        const movesW = d.handle.includes('w')
        const movesE = d.handle.includes('e')
        const movesN = d.handle.includes('n')
        const movesS = d.handle.includes('s')

        let adjDx = dx
        let adjDy = dy
        if (movesW || movesE) {
          const edge = movesW ? next.cx - next.w / 2 : next.cx + next.w / 2
          const r = snapValue(edge, targets.x, threshold)
          if (r.snapped) { adjDx = dx + r.delta; guides = { ...(guides || {}), x: r.target } }
        }
        if (movesN || movesS) {
          // North is the larger world y, so its screen delta is inverted.
          const edge = movesN ? next.cy + next.h / 2 : next.cy - next.h / 2
          const r = snapValue(edge, targets.y, threshold)
          if (r.snapped) { adjDy = dy + r.delta; guides = { ...(guides || {}), y: r.target } }
        }
        if (adjDx !== dx || adjDy !== dy) {
          next = resizeRect(d.orig, d.handle, adjDx, adjDy, {
            keepAspect: isCorner(d.handle) && !e.shiftKey,
            minSize: MIN_CLIP_SIZE,
          })
        }
      }
      const updated = { ...d, rect: next }
      resizeRef.current = updated
      setResize(updated)
      setSnapGuides(guides)
    }
    const onUp = () => {
      const d = resizeRef.current
      resizeRef.current = null
      setResize(null)
      setSnapGuides(null)
      if (!d) return
      const r = d.rect
      if (r.w === d.orig.w && r.h === d.orig.h && r.cx === d.orig.cx && r.cy === d.orig.cy) return
      const screen = singleSelected?.screen
      const spos = screen?.transform?.position || { x: 0, y: 0 }
      useEditorStore.getState().updateClipTransform({
        timelineId: d.id,
        position: { x: r.cx - (spos.x ?? 0), y: r.cy - (spos.y ?? 0) },
        scale: { x: Math.round(r.w), y: Math.round(r.h) },
        label: 'Resize Clip',
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [resize, ratio, stageSnapTargets, singleSelected])

  // --- Context menu -------------------------------------------------------

  const stageMenuItems = useCallback(() => {
    const st = useEditorStore.getState()
    const node = st.selectedId ? nodeIndex.get(st.selectedId) : null
    const isScreen = node?.kind?.type === 'screen'
    const clipCount = st.selectedClipIds.length
    return [
      { label: 'Add Web Screen', icon: 'desktop_windows', onClick: () => st.addScreenNode({ pixels: [1920, 1080], screenType: 'web' }) },
      { label: 'Add Renderer Screen', icon: 'cast', onClick: () => st.addScreenNode({ pixels: [1920, 1080], screenType: 'renderer' }) },
      ...(clipCount ? [
        { separator: true },
        { label: clipCount > 1 ? `Remove ${clipCount} Clips` : 'Remove Clip', icon: 'delete', danger: true, onClick: () => st.removeClips(st.selectedClipIds) },
      ] : []),
      ...(isScreen ? [
        { separator: true },
        { label: `Remove ${node.name || 'Screen'}`, icon: 'delete', danger: true, onClick: () => st.removeScreenNode(node.id) },
      ] : []),
    ]
  }, [nodeIndex])

  // --- Render -------------------------------------------------------------

  const resizeRectStage = resize
    ? rectToStage(resize.rect, ratio, center)
    : (singleSelected ? rectToStage(rectOf(singleSelected), ratio, center) : null)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={scrollRef}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types?.includes('application/x-constellation-clip-id') && !e.dataTransfer?.types?.includes('text/plain')) return
          e.preventDefault()
          const sc = scrollRef.current
          if (!sc) return
          const rect = sc.getBoundingClientRect()
          const contentLeft = sc.scrollLeft + (e.clientX - rect.left)
          const contentTop = sc.scrollTop + (e.clientY - rect.top)
          let target = null
          for (const n of nodes) {
            if (n.kind?.type !== 'screen' || n.kind?.enabled === false) continue
            const r = rectToStage(screenWorldRect(n), ratio, center)
            if (contentLeft >= r.left && contentLeft <= r.left + r.width && contentTop >= r.top && contentTop <= r.top + r.height) {
              target = n.id
              break
            }
          }
          setDnd({ over: !!target, screenId: target })
        }}
        onDragLeave={() => setDnd({ over: false, screenId: null })}
        onDrop={(e) => {
          const clipId = e.dataTransfer.getData('application/x-constellation-clip-id') || e.dataTransfer.getData('text/plain')
          if (!clipId) return
          e.preventDefault()
          const sc = scrollRef.current
          if (!sc) return
          const rect = sc.getBoundingClientRect()
          const world = stageToWorld(
            sc.scrollLeft + (e.clientX - rect.left),
            sc.scrollTop + (e.clientY - rect.top),
            ratio, center,
          )
          const { addClipToTimeline, time } = useEditorStore.getState()
          addClipToTimeline({ clipId, startAt: time, position: world })
          setDnd({ over: false, screenId: null })
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: 'relative', width: '100%', height: '100%', overflow: 'auto',
          background: 'var(--bg-deep)',
          cursor: pan ? 'grabbing' : (tool === 'hand' ? 'grab' : 'default'),
          overscrollBehavior: 'contain',
          outline: shiftHeld ? '2px solid var(--stage-mode)' : 'none',
          outlineOffset: '-2px',
        }}
      >
        <div
          ref={stageRef}
          style={{ position: 'relative', width: STAGE_W, height: STAGE_H, ...dotGridBg(center, zoom) }}
          onClick={(e) => {
            if (draggedRef.current || e.ctrlKey || e.shiftKey) return
            setSelected(null)
            setSelectedClips([])
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            if (tool === 'hand' || (e.ctrlKey && e.altKey)) return
            if (e.target !== stageRef.current) return
            const sc = scrollRef.current
            if (!sc) return
            const rect = sc.getBoundingClientRect()
            const x = sc.scrollLeft + (e.clientX - rect.left)
            const y = sc.scrollTop + (e.clientY - rect.top)
            // Shift adds, Alt subtracts, otherwise replace. The marquee used
            // to always union, so there was no way to narrow a selection.
            const mode = e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace'
            setMarquee({ x1: x, y1: y, x2: x, y2: y, mode })
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
            if (Math.hypot(x - marquee.x1, y - marquee.y1) > DRAG_THRESHOLD_PX) draggedRef.current = true
            setMarquee((m) => (m ? { ...m, x2: x, y2: y } : m))
            e.preventDefault()
          }}
          onPointerUp={(e) => {
            if (!marquee) return
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
            const box = {
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }
            setMarquee(null)
            if (!draggedRef.current) return
            const tNow = useEditorStore.getState().time
            const picked = []
            for (const p of placements) {
              if (!isClipActive(p.tm, tNow)) continue
              if (rectsIntersect(box, rectToStage(rectOf(p), ratio, center))) picked.push(p.tm.id)
            }
            const current = new Set(selectedClipIds)
            if (marquee.mode === 'replace') setSelectedClips(picked)
            else if (marquee.mode === 'add') setSelectedClips([...new Set([...current, ...picked])])
            else setSelectedClips([...current].filter((id) => !picked.includes(id)))
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {marquee && (
            <div style={{
              position: 'absolute',
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
              border: '1px dashed var(--accent)',
              background: 'rgba(106,160,255,0.12)',
              pointerEvents: 'none',
              zIndex: 1000,
            }} />
          )}

          {/* Axes */}
          <div style={{ position: 'absolute', left: center.x, top: 0, bottom: 0, width: 1, background: 'var(--stage-line)' }} />
          <div style={{ position: 'absolute', top: center.y, left: 0, right: 0, height: 1, background: 'var(--stage-line)' }} />

          {nodes.map((n) => (
            <Node2D key={n.id} node={n} center={center} scale={scale} selectedId={selectedId} onSelect={setSelected}
              highlight={dnd.over && dnd.screenId === n.id} shiftHeld={shiftHeld}
              dragScreen={dragScreen} setDragScreen={setDragScreen} dragScreenRef={dragScreenRef} />
          ))}

          {showOutputOverlay && nodes
            .filter((n) => n.kind?.type === 'screen' && (n.kind?.enabled ?? true))
            .map((screen) => {
              const r = rectToStage(screenWorldRect(screen), ratio, center)
              return (
                <div key={`out-${screen.id}`}
                  style={{ position: 'absolute', ...r, border: '1px dashed var(--accent)', background: 'rgba(90,120,255,0.07)', zIndex: 50, pointerEvents: 'none' }}
                  title={`Output ${screen.kind?.pixels?.[0]}x${screen.kind?.pixels?.[1]}`} />
              )
            })}

          {placements.map(({ tm, screen, clip }) => {
            const tNow = useEditorStore.getState().time
            const dragged = dragClip?.targets?.[tm.id]
            const base = rectOf({ tm, screen })
            const world = dragged?.currentX !== undefined
              ? { ...base, cx: (screen?.transform?.position?.x ?? 0) + dragged.currentX, cy: (screen?.transform?.position?.y ?? 0) + dragged.currentY }
              : base
            const isBeingResized = resize?.id === tm.id
            const box = rectToStage(isBeingResized ? resize.rect : world, ratio, center)
            const isSel = selectedSet.has(tm.id)
            const uri = String(clip?.uri || '')
            const isVideo = mediaTypeFromExt(extFromUri(uri) || extFromUri(clip?.name || '')) === 'video'

            return (
              <div
                key={tm.id}
                ref={getClipRef(tm.id)}
                className="v2d-clip"
                onPointerDown={(e) => {
                  if (tool === 'hand') return
                  if (e.button !== 0) return
                  e.stopPropagation()
                  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
                  const st = useEditorStore.getState()
                  const ids = st.selectedClipIds.includes(tm.id) && !e.ctrlKey && !e.metaKey
                    ? st.selectedClipIds
                    : [tm.id]
                  const targets = {}
                  for (const id of ids) {
                    const item = allTimelineItems.find((m) => m.id === id)
                    if (item) targets[id] = { origX: item.position?.x || 0, origY: item.position?.y || 0 }
                  }
                  const d = {
                    startX: e.clientX, startY: e.clientY, targets, isDragging: false,
                    primaryId: tm.id, modifiers: { ctrl: e.ctrlKey || e.metaKey },
                  }
                  setDragClip(d)
                  dragClipRef.current = d
                  clipDraggedRef.current = false
                }}
                onPointerMove={(e) => {
                  const d = dragClipRef.current
                  if (!d) return
                  if ((e.buttons & 1) === 0) { setDragClip(null); dragClipRef.current = null; return }
                  const dx = e.clientX - d.startX
                  const dy = e.clientY - d.startY
                  if (!d.isDragging && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return
                  d.isDragging = true

                  let wdx = dx / ratio
                  let wdy = -dy / ratio
                  let guides = null
                  if (!e.altKey) {
                    const ids = Object.keys(d.targets)
                    const targets = stageSnapTargets(ids)
                    const threshold = SNAP_PX / ratio
                    const primary = rectOf({ tm, screen })
                    const px = primary.cx + wdx
                    const py = primary.cy + wdy
                    const sx = snapOffsets([px - primary.w / 2, px, px + primary.w / 2], targets.x, threshold)
                    const sy = snapOffsets([py - primary.h / 2, py, py + primary.h / 2], targets.y, threshold)
                    if (sx.snapped) wdx += sx.delta
                    if (sy.snapped) wdy += sy.delta
                    if (sx.snapped || sy.snapped) guides = { x: sx.snapped ? sx.target : null, y: sy.snapped ? sy.target : null }
                  }

                  const nextTargets = {}
                  for (const [id, init] of Object.entries(d.targets)) {
                    nextTargets[id] = { ...init, currentX: init.origX + wdx, currentY: init.origY + wdy }
                  }
                  const next = { ...d, targets: nextTargets }
                  dragClipRef.current = next
                  setDragClip(next)
                  setSnapGuides(guides)
                }}
                onPointerUp={(e) => {
                  const d = dragClipRef.current
                  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
                  if (!d) return
                  if (!d.isDragging) {
                    // A click: select, with Ctrl toggling.
                    const st = useEditorStore.getState()
                    if (d.modifiers.ctrl) {
                      const cur = st.selectedClipIds
                      st.setSelectedClips(cur.includes(tm.id) ? cur.filter((x) => x !== tm.id) : [...cur, tm.id])
                    } else {
                      st.setSelectedClips([tm.id])
                    }
                    dragClipRef.current = null
                    setDragClip(null)
                    return
                  }
                  commitClipDrag()
                }}
                onDragStart={(e) => e.preventDefault()}
                title={`${clip?.name || tm.clip_id} (${clipStart(tm).toFixed(2)}s · ${clipDuration(tm).toFixed(2)}s)`}
                style={{
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  background: 'var(--bg-deep)',
                  border: `1px solid ${isSel ? 'var(--accent-yellow)' : 'var(--border-subtle)'}`,
                  boxShadow: isSel ? '0 0 0 1px var(--selected-glow)' : 'none',
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'hidden',
                  display: isClipActive(tm, tNow) ? 'flex' : 'none',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text)',
                  fontSize: 11,
                  pointerEvents: shiftHeld ? 'none' : 'auto',
                  zIndex: 5,
                  userSelect: 'none',
                  touchAction: 'none',
                  opacity: shiftHeld ? 0.4 : computeFadeOpacity(tm, tNow),
                  filter: shiftHeld ? 'grayscale(1)' : buildFilterString(tm),
                }}
              >
                {isVideo
                  ? <VideoFrame clip={clip} style={{ width: '100%', height: '100%' }} />
                  : imageMeta[tm.clip_id]?.src
                    ? <img src={imageMeta[tm.clip_id].src} alt={clip?.name || tm.clip_id} draggable={false}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', userSelect: 'none' }} />
                    : <span style={{ padding: '0 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{clip?.name || tm.clip_id}</span>}
              </div>
            )
          })}

          {/* Resize handles for exactly one selected clip. */}
          {singleSelected && !dragClip && (
            <ResizeHandles rect={resizeRectStage} onStart={onResizeStart} />
          )}

          {snapGuides?.x != null && (
            <div className="v2d-snap-guide" style={{ left: worldToStage(snapGuides.x, 0, ratio, center).x, top: 0, width: 1, height: STAGE_H }} />
          )}
          {snapGuides?.y != null && (
            <div className="v2d-snap-guide" style={{ top: worldToStage(0, snapGuides.y, ratio, center).y, left: 0, height: 1, width: STAGE_W }} />
          )}
        </div>
      </div>

      <SelectionOverlay />

      <ViewportToolbar
        tool={tool}
        setTool={setTool}
        zoom={zoom}
        onZoomIn={() => applyZoom(zoom * 1.25)}
        onZoomOut={() => applyZoom(zoom / 1.25)}
        onZoom100={zoomTo100}
        onFrameAll={frameAll}
        onFrameSelected={frameSelected}
        hasSelection={!!selectedId || selectedClipIds.length > 0}
      />

      <ContextMenu
        open={!!menu}
        x={menu?.x || 0}
        y={menu?.y || 0}
        items={menu ? stageMenuItems() : []}
        onClose={() => setMenu(null)}
      />
    </div>
  )
}

// Memoized: App re-renders when a panel is resized; the 2D stage must not.
export default React.memo(Viewport2D)
