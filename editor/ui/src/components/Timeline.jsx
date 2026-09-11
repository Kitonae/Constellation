import React, { useMemo, useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { useEditorStore, getMediaSession } from '../store.js'
import { computeOverlaps } from '../utils/mediaUtils.js'
import { clipStart, clipDuration, clipEnd, trackMedia, trackClipIds, timelineExtent, MIN_CLIP_DURATION } from '../utils/clipTime.js'
import { formatTimecode, formatRulerLabel } from '../utils/timeFormat.js'
import { snapValue, snapOffsets, collectTimelineSnapTargets } from '../utils/snap.js'
import { getDragClipId } from '../utils/dragPayload.js'
import IconButton from './IconButton.jsx'
import ContextMenu from './ContextMenu.jsx'
import TimelineClip from './TimelineClip.jsx'
import TrackHeader from './TrackHeader.jsx'

// Track row geometry. Exported so the drop hit-test and the row style can
// never drift apart again — they used to disagree (28 px rows, 40 px maths),
// which put every drop past the first row on the wrong track.
export const ROW_H = 28
export const PAD_TOP = 8

// Layout constants shared by the ruler, the labels and hit-testing.
const LABEL_W = 120
const MIN_PPS = 1
const MAX_PPS = 400
const ZOOM_FACTOR = 1.25
const SNAP_PX = 6
const DRAG_THRESHOLD_PX = 3

export default React.memo(function Timeline() {
  const project = useEditorStore((s) => s.project)
  const playing = useEditorStore((s) => s.playing)
  const tracks = project?.timeline?.tracks ?? []
  const media = project?.media ?? []
  const mediaById = useMemo(() => Object.fromEntries(media.map((m) => [m.id, m])), [media])
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)
  const addTrack = useEditorStore((s) => s.addTrack)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips)
  const selectedTrackIndex = useEditorStore((s) => s.selectedTrackIndex)
  const setSelectedTrackIndex = useEditorStore((s) => s.setSelectedTrackIndex)

  const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds])

  const contentEnd = useMemo(() => timelineExtent(project), [project])
  // Infinite timeline: at least 60s, or the content plus a 5-minute runway.
  const duration = Math.max((project?.timeline?.duration_seconds ?? 60), contentEnd + 300)

  const tracksViewportRef = useRef(null)
  const tracksInnerRef = useRef(null)
  const rulerViewportRef = useRef(null)
  const tracksLabelsRef = useRef(null)
  const rulerPlayheadRef = useRef(null)
  const tracksPlayheadRef = useRef(null)

  const [dropGhost, setDropGhost] = useState(null) // { trackIndex, start, dur }
  const [drag, setDrag] = useState(null)           // clip move gesture
  const dragRef = useRef(null)
  const [trim, setTrim] = useState(null)           // clip trim gesture
  const trimRef = useRef(null)
  const scrubRef = useRef(null)                    // empty-area scrub gesture
  const [menu, setMenu] = useState(null)           // { x, y, kind, clipId, trackIndex }

  const [vpSize, setVpSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ left: 0, width: 0 })
  const viewRef = useRef({ left: 0, width: 0 })
  const viewFlushRef = useRef(0)
  const [pxPerSecond, setPxPerSecond] = useState(20)
  const [timeDisplay, setTimeDisplay] = useState(() => getMediaSession().getTime() || 0)
  const lastDisplayRef = useRef(0)

  // Derived, not stored: an effect-set width lagged one render behind the
  // zoom, and the anchored-scroll write below would then be clamped by a
  // stale inner width.
  const timelineWidth = Math.max(vpSize.w, Math.round(duration * pxPerSecond))
  const snapThreshold = SNAP_PX / pxPerSecond

  /** Client x within the tracks viewport to a time, accounting for scroll. */
  const timeFromClientX = useCallback((clientX) => {
    const vp = tracksViewportRef.current
    if (!vp) return 0
    const rect = vp.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + vp.scrollLeft) / pxPerSecond)
  }, [pxPerSecond])

  /** Where a time currently sits on screen, for anchoring a zoom. */
  const clientXFromTime = useCallback((t) => {
    const vp = tracksViewportRef.current
    if (!vp) return 0
    const rect = vp.getBoundingClientRect()
    return rect.left + t * pxPerSecond - vp.scrollLeft
  }, [pxPerSecond])

  // --- Zoom ---------------------------------------------------------------

  // Zoom used to only change the content width, so the timeline slid out
  // from under the cursor. Remember what should stay put, then restore it
  // once the new width has been laid out.
  const anchorRef = useRef(null)
  const applyZoom = useCallback((nextPps, anchorTime, anchorClientX) => {
    const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, nextPps))
    setPxPerSecond((prev) => {
      if (clamped === prev) return prev
      const vp = tracksViewportRef.current
      const rect = vp?.getBoundingClientRect()
      anchorRef.current = {
        time: anchorTime,
        offset: rect ? (anchorClientX - rect.left) : 0,
      }
      return clamped
    })
  }, [])

  useLayoutEffect(() => {
    const a = anchorRef.current
    anchorRef.current = null
    const vp = tracksViewportRef.current
    if (!a || !vp) return
    vp.scrollLeft = Math.max(0, a.time * pxPerSecond - a.offset)
    if (rulerViewportRef.current) rulerViewportRef.current.scrollLeft = vp.scrollLeft
  }, [pxPerSecond])

  const zoomBy = useCallback((factor) => {
    const t = getMediaSession().getTime() || 0
    const vp = tracksViewportRef.current
    const rect = vp?.getBoundingClientRect()
    // Anchor on the playhead when it is on screen, otherwise the middle.
    const px = clientXFromTime(t)
    const onScreen = rect && px >= rect.left && px <= rect.right
    const anchorX = onScreen ? px : (rect ? rect.left + rect.width / 2 : 0)
    const anchorT = onScreen ? t : timeFromClientX(anchorX)
    applyZoom(pxPerSecond * factor, anchorT, anchorX)
  }, [applyZoom, clientXFromTime, pxPerSecond, timeFromClientX])

  const zoomToFit = useCallback(() => {
    const w = Math.max(0, vpSize.w - 16)
    if (!w) return
    const span = Math.max(contentEnd, 10)
    applyZoom(w / span, 0, tracksViewportRef.current?.getBoundingClientRect().left ?? 0)
    requestAnimationFrame(() => {
      if (tracksViewportRef.current) tracksViewportRef.current.scrollLeft = 0
    })
  }, [applyZoom, contentEnd, vpSize.w])

  // Ctrl/Cmd+wheel zooms about the cursor; a plain wheel still scrolls.
  useEffect(() => {
    const vp = tracksViewportRef.current
    if (!vp) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const t = timeFromClientX(e.clientX)
      applyZoom(pxPerSecond * Math.exp(-e.deltaY * 0.0015), t, e.clientX)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [applyZoom, pxPerSecond, timeFromClientX])

  // --- Measurement and scroll sync ----------------------------------------

  useEffect(() => {
    const vp = tracksViewportRef.current
    if (!vp) return
    const recalc = () => {
      setVpSize({ w: vp.clientWidth || 0, h: vp.clientHeight || 0 })
      setView({ left: vp.scrollLeft, width: vp.clientWidth })
    }
    recalc()
    const ro = new ResizeObserver(recalc)
    ro.observe(vp)
    return () => ro.disconnect()
  }, [])

  // Horizontal: ruler mirrors the tracks. The visible range is published on a
  // trailing 50 ms flush so a scroll gesture does not rebuild every tick.
  useEffect(() => {
    const rvp = rulerViewportRef.current
    const tvp = tracksViewportRef.current
    if (!rvp || !tvp) return
    let lock = false
    let timer = 0
    const publish = () => {
      const next = { left: tvp.scrollLeft, width: tvp.clientWidth }
      viewRef.current = next
      const now = performance.now()
      if (now - viewFlushRef.current > 50) {
        viewFlushRef.current = now
        setView(next)
      } else if (!timer) {
        timer = setTimeout(() => { timer = 0; viewFlushRef.current = performance.now(); setView(viewRef.current) }, 50)
      }
    }
    function syncFromR() { if (!lock) { lock = true; tvp.scrollLeft = rvp.scrollLeft; lock = false } publish() }
    function syncFromT() { if (!lock) { lock = true; rvp.scrollLeft = tvp.scrollLeft; lock = false } publish() }
    rvp.addEventListener('scroll', syncFromR)
    tvp.addEventListener('scroll', syncFromT)
    publish()
    return () => {
      if (timer) clearTimeout(timer)
      rvp.removeEventListener('scroll', syncFromR)
      tvp.removeEventListener('scroll', syncFromT)
    }
  }, [])

  // Vertical: the label column and the tracks are separate scroll containers
  // (so the ruler can stay pinned), so their offsets are mirrored explicitly.
  useEffect(() => {
    const lbl = tracksLabelsRef.current
    const tvp = tracksViewportRef.current
    if (!lbl || !tvp) return
    let lock = false
    function fromLabels() { if (lock) return; lock = true; tvp.scrollTop = lbl.scrollTop; lock = false }
    function fromTracks() { if (lock) return; lock = true; lbl.scrollTop = tvp.scrollTop; lock = false }
    lbl.addEventListener('scroll', fromLabels)
    tvp.addEventListener('scroll', fromTracks)
    return () => { lbl.removeEventListener('scroll', fromLabels); tvp.removeEventListener('scroll', fromTracks) }
  }, [])

  // --- Playhead -----------------------------------------------------------

  // Driven straight from the PresentationClock: through the store it moved at
  // the store's 10 Hz mirror rate.
  useEffect(() => {
    const place = (t) => {
      const clamped = Math.max(0, Math.min(duration, t || 0))
      const x = clamped * pxPerSecond
      if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = x + 'px'
      if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = x + 'px'
      const now = performance.now()
      if (now - lastDisplayRef.current > 125) { // ~8fps UI update for timecode
        lastDisplayRef.current = now
        setTimeDisplay(t)
      }
    }
    const clock = getMediaSession().getClock()
    const unsub = clock.subscribe({ onTick: place, onSeek: place, onStop: () => place(0) })
    place(clock.getTime())
    return () => { try { unsub() } catch { } }
  }, [duration, pxPerSecond])

  // --- Ruler ticks --------------------------------------------------------

  const tickStep = useMemo(() => {
    const target = 100 / pxPerSecond // aim for a major tick every ~100px
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
    for (const st of steps) if (st >= target) return st
    return steps[steps.length - 1]
  }, [pxPerSecond])

  // Only build ticks for the visible slice: spanning the whole buffer meant
  // hundreds of divs rebuilt on every render.
  const { ticks, secondDots } = useMemo(() => {
    const from = Math.max(0, view.left / pxPerSecond - tickStep)
    const to = Math.min(duration, (view.left + view.width) / pxPerSecond + tickStep)
    const ticksOut = []
    const first = Math.floor(from / tickStep) * tickStep
    for (let t = first; t <= to + 1e-6; t += tickStep) {
      if (t >= -1e-6) ticksOut.push(Number(t.toFixed(6)))
    }
    const dotsOut = []
    if (pxPerSecond > 10) {
      for (let sec = Math.max(0, Math.floor(from)); sec <= Math.floor(to + 1e-6); sec++) dotsOut.push(sec)
    }
    return { ticks: ticksOut, secondDots: dotsOut }
  }, [view.left, view.width, pxPerSecond, tickStep, duration])

  // --- Selection ----------------------------------------------------------

  const lastClickedRef = useRef(null)

  const selectClip = useCallback((id, trackIndex, e) => {
    const st = useEditorStore.getState()
    const current = st.selectedClipIds
    if (e?.ctrlKey || e?.metaKey) {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
      st.setSelectedClips(next)
    } else if (e?.shiftKey && lastClickedRef.current?.trackIndex === trackIndex) {
      // Range within the track, ordered by start time rather than array order.
      const list = trackMedia(st.project?.timeline?.tracks?.[trackIndex] || {})
        .slice()
        .sort((a, b) => clipStart(a) - clipStart(b))
      const a = list.findIndex((m) => m.id === lastClickedRef.current.id)
      const b = list.findIndex((m) => m.id === id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const range = list.slice(lo, hi + 1).map((m) => m.id)
        st.setSelectedClips([...new Set([...current, ...range])])
      }
    } else {
      st.setSelectedClips([id])
    }
    lastClickedRef.current = { id, trackIndex }
  }, [])

  // --- Clip move ----------------------------------------------------------

  const onClipPointerDown = (m, trackIndex) => (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    const st = useEditorStore.getState()
    // Dragging something already selected moves the whole selection;
    // otherwise the gesture starts by selecting just this clip.
    const ids = st.selectedClipIds.includes(m.id) && !e.ctrlKey && !e.metaKey
      ? st.selectedClipIds
      : [m.id]
    const items = []
    for (let i = 0; i < tracks.length; i++) {
      for (const c of trackMedia(tracks[i])) {
        if (ids.includes(c?.id)) items.push({ id: c.id, start: clipStart(c), duration: clipDuration(c), trackIndex: i })
      }
    }
    const d = {
      ids,
      primaryId: m.id,
      grabOffset: timeFromClientX(e.clientX) - clipStart(m),
      startX: e.clientX,
      startY: e.clientY,
      items,
      deltaTime: 0,
      rowDelta: 0,
      moved: false,
      snapGuide: null,
      modifiers: { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey },
      trackIndex,
    }
    dragRef.current = d
    setDrag(d)
  }

  const onClipPointerMove = (m) => (e) => {
    const d = dragRef.current
    if (!d || d.primaryId !== m.id) return
    if (!d.moved && Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX) return
    d.moved = true

    const primary = d.items.find((it) => it.id === d.primaryId)
    let delta = timeFromClientX(e.clientX) - d.grabOffset - primary.start
    // Never push the earliest clip of the group before zero.
    delta = Math.max(delta, -Math.min(...d.items.map((it) => it.start)))

    const minIdx = Math.min(...d.items.map((it) => it.trackIndex))
    const maxIdx = Math.max(...d.items.map((it) => it.trackIndex))
    const rowDelta = Math.max(-minIdx, Math.min(tracks.length - 1 - maxIdx, Math.round((e.clientY - d.startY) / ROW_H)))

    let snapGuide = null
    if (!e.altKey) {
      const indices = new Set()
      for (const it of d.items) { indices.add(it.trackIndex); indices.add(it.trackIndex + rowDelta) }
      const targets = collectTimelineSnapTargets({
        tracks,
        excludeIds: d.ids,
        playhead: getMediaSession().getTime(),
        trackIndices: [...indices],
      })
      const res = snapOffsets([primary.start + delta, primary.start + primary.duration + delta], targets, snapThreshold)
      if (res.snapped) { delta += res.delta; snapGuide = res.target }
    }

    const next = { ...d, deltaTime: delta, rowDelta, snapGuide }
    dragRef.current = next
    setDrag(next)
  }

  const onClipPointerUp = (m, trackIndex) => (e) => {
    const d = dragRef.current
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
    if (!d || d.primaryId !== m.id) return
    dragRef.current = null
    setDrag(null)
    if (!d.moved) {
      // A click, not a drag.
      selectClip(m.id, trackIndex, { ctrlKey: d.modifiers.ctrl, metaKey: d.modifiers.ctrl, shiftKey: d.modifiers.shift })
      return
    }
    if (d.deltaTime === 0 && d.rowDelta === 0) return
    useEditorStore.getState().moveClips(
      d.items.map((it) => ({
        id: it.id,
        start: Math.max(0, it.start + d.deltaTime),
        trackIndex: it.trackIndex + d.rowDelta,
      })),
      d.items.length > 1 ? 'Move Clips' : undefined,
    )
  }

  // --- Clip trim ----------------------------------------------------------

  const onTrimStart = useCallback((clipId, side, e) => {
    let found = null
    for (let i = 0; i < tracks.length; i++) {
      const m = trackMedia(tracks[i]).find((c) => c?.id === clipId)
      if (m) { found = { m, trackIndex: i }; break }
    }
    if (!found) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    const t = {
      id: clipId,
      side,
      trackIndex: found.trackIndex,
      origStart: clipStart(found.m),
      origDur: clipDuration(found.m),
      start: clipStart(found.m),
      duration: clipDuration(found.m),
      snapGuide: null,
    }
    trimRef.current = t
    setTrim(t)
  }, [tracks])

  // Trim tracks the pointer on the window: the handle is only a few pixels
  // wide and the pointer routinely leaves it mid-gesture.
  useEffect(() => {
    if (!trim) return
    const onMove = (e) => {
      const t = trimRef.current
      if (!t) return
      const raw = timeFromClientX(e.clientX)
      const origEnd = t.origStart + t.origDur
      let edge = raw
      let snapGuide = null
      if (!e.altKey) {
        const targets = collectTimelineSnapTargets({
          tracks,
          excludeIds: [t.id],
          playhead: getMediaSession().getTime(),
          trackIndices: [t.trackIndex],
        })
        const res = snapValue(raw, targets, snapThreshold)
        if (res.snapped) { edge = res.value; snapGuide = res.target }
      }
      let next
      if (t.side === 'start') {
        const start = Math.max(0, Math.min(edge, origEnd - MIN_CLIP_DURATION))
        next = { ...t, start, duration: origEnd - start, snapGuide }
      } else {
        next = { ...t, duration: Math.max(MIN_CLIP_DURATION, edge - t.origStart), snapGuide }
      }
      trimRef.current = next
      setTrim(next)
    }
    const onUp = () => {
      const t = trimRef.current
      trimRef.current = null
      setTrim(null)
      if (!t) return
      if (t.start === t.origStart && t.duration === t.origDur) return
      useEditorStore.getState().trimClip(t.id, { start: t.start, duration: t.duration })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [trim, tracks, snapThreshold, timeFromClientX])

  // --- Empty-area scrub ---------------------------------------------------

  const onTracksPointerDown = (e) => {
    if (e.button !== 0) return
    if (e.target.closest('[data-clip]')) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    scrubRef.current = { x: e.clientX, t: timeFromClientX(e.clientX), moved: false }
  }

  const onTracksPointerMove = (e) => {
    const s = scrubRef.current
    if (!s) return
    if (!s.moved && Math.abs(e.clientX - s.x) < DRAG_THRESHOLD_PX) return
    s.moved = true
    useEditorStore.getState().seek(timeFromClientX(e.clientX))
  }

  const onTracksPointerUp = (e) => {
    const s = scrubRef.current
    scrubRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
    if (!s || s.moved) return
    // A plain click on empty track area both deselects and moves the playhead.
    useEditorStore.getState().setSelectedClips([])
    useEditorStore.getState().seek(s.t)
  }

  // --- Drag and drop from the media bin -----------------------------------

  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes('application/x-constellation-clip-id') && !e.dataTransfer.types.includes('text/plain')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const vp = tracksViewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    const relY = e.clientY - rect.top + vp.scrollTop
    const trackIndex = Math.max(0, Math.floor((relY - PAD_TOP) / ROW_H))
    // dataTransfer is unreadable during dragover, so the source parks the id.
    const clipId = getDragClipId()
    const dur = Math.max(MIN_CLIP_DURATION, mediaById[clipId]?.duration_seconds ?? 10)
    let start = timeFromClientX(e.clientX)
    if (!e.altKey) {
      const targets = collectTimelineSnapTargets({
        tracks,
        playhead: getMediaSession().getTime(),
        trackIndices: [trackIndex],
      })
      const res = snapOffsets([start, start + dur], targets, snapThreshold)
      if (res.snapped) start = Math.max(0, start + res.delta)
    }
    setDropGhost({ trackIndex, start, dur })
  }

  const onDragLeave = () => setDropGhost(null)

  const onDrop = (e) => {
    e.preventDefault()
    const clipId = e.dataTransfer.getData('application/x-constellation-clip-id') || e.dataTransfer.getData('text/plain')
    const ghost = dropGhost
    setDropGhost(null)
    if (!clipId) return
    const startAt = ghost ? ghost.start : timeFromClientX(e.clientX)
    const trackIndex = ghost ? ghost.trackIndex : -1
    const newId = addClipToTimeline({ clipId, startAt, trackIndex })
    if (newId) useEditorStore.getState().setSelectedClips([newId])
  }

  // --- Context menus ------------------------------------------------------

  const clipMenuItems = useCallback((clipId, trackIndex) => {
    const st = useEditorStore.getState()
    const ids = st.selectedClipIds.includes(clipId) ? st.selectedClipIds : [clipId]
    const t = getMediaSession().getTime()
    const item = trackMedia(tracks[trackIndex] || {}).find((m) => m?.id === clipId)
    const canSplit = !!item && t > clipStart(item) + MIN_CLIP_DURATION && t < clipEnd(item) - MIN_CLIP_DURATION
    return [
      { label: ids.length > 1 ? `Delete ${ids.length} Clips` : 'Delete Clip', icon: 'delete', danger: true, onClick: () => st.removeClips(ids) },
      { label: ids.length > 1 ? `Duplicate ${ids.length} Clips` : 'Duplicate Clip', icon: 'content_copy', onClick: () => st.duplicateClips(ids) },
      { label: 'Split at Playhead', icon: 'call_split', disabled: !canSplit, onClick: () => st.splitClipAtTime(clipId, t) },
      { separator: true },
      { label: 'Select All in Track', icon: 'select_all', onClick: () => st.selectClipsInTrack(trackIndex) },
    ]
  }, [tracks])

  const trackMenuItems = useCallback((trackIndex) => {
    const st = useEditorStore.getState()
    const count = trackClipIds(tracks[trackIndex] || {}).length
    return [
      { label: 'Add Track', icon: 'playlist_add', onClick: () => st.addTrack() },
      { label: 'Select All in Track', icon: 'select_all', disabled: !count, onClick: () => st.selectClipsInTrack(trackIndex) },
      { separator: true },
      {
        label: 'Remove Track',
        icon: 'playlist_remove',
        danger: true,
        onClick: async () => {
          if (count) {
            const ok = await st.askConfirm({
              title: 'Remove Track',
              message: `Remove this track and the ${count} clip${count === 1 ? '' : 's'} on it?`,
              confirmLabel: 'Remove',
              danger: true,
            })
            if (!ok) return
          }
          useEditorStore.getState().removeTrack(trackIndex)
        },
      },
    ]
  }, [tracks])

  // --- Render -------------------------------------------------------------

  const trimmedId = trim?.id
  const snapGuideTime = drag?.snapGuide ?? trim?.snapGuide ?? null

  return (
    <div style={{ padding: 8, color: 'var(--text)', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Toolbar */}
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, userSelect: 'none' }}>
          <div data-testid="timeline-title">Timeline</div>
          {/* Selectable, so the current time can actually be copied. */}
          <div className="tl-timecode">{formatTimecode(timeDisplay)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <IconButton icon="remove" label="Zoom Out" onClick={() => zoomBy(1 / ZOOM_FACTOR)} />
            <IconButton icon="add" label="Zoom In" onClick={() => zoomBy(ZOOM_FACTOR)} />
            <IconButton icon="fit_screen" label="Zoom to Fit" onClick={zoomToFit} />
            <div style={{ fontSize: 10, opacity: 0.7, minWidth: 54, textAlign: 'center' }}>{Math.round(pxPerSecond)} px/s</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <IconButton icon="skip_previous" label="Go to Start" onClick={() => useEditorStore.getState().seek(0)} />
          {/* One button that reflects transport state, rather than a Play and
              a Pause that both always looked available. */}
          <IconButton
            icon={playing ? 'pause' : 'play_arrow'}
            label={playing ? 'Pause' : 'Play'}
            onClick={() => { const st = useEditorStore.getState(); if (st.playing) st.pause(); else st.play() }}
          />
          <IconButton icon="stop" label="Stop" onClick={() => {
            useEditorStore.getState().stop()
            // The clock's onStop moves the playheads; this only brings the
            // view back to the start.
            if (tracksViewportRef.current) tracksViewportRef.current.scrollLeft = 0
          }} />
          <IconButton icon="skip_next" label="Go to End" onClick={() => useEditorStore.getState().seek(contentEnd)} />
        </div>
      </div>

      {/* Ruler */}
      <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, gap: 0 }}>
        <div />
        <div
          ref={rulerViewportRef}
          className="no-scrollbar"
          style={{ position: 'relative', overflowX: 'auto', overflowY: 'hidden', height: 24, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)', cursor: 'text' }}
          onPointerDown={(e) => {
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
            scrubRef.current = { x: e.clientX, t: 0, moved: true }
            useEditorStore.getState().seek(timeFromClientX(e.clientX))
          }}
          onPointerMove={(e) => { if (scrubRef.current?.moved) useEditorStore.getState().seek(timeFromClientX(e.clientX)) }}
          onPointerUp={(e) => { scrubRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { } }}
        >
          <div style={{ position: 'relative', width: timelineWidth, height: '100%' }}>
            {ticks.map((tVal, idx) => (
              <div key={idx} style={{ position: 'absolute', left: tVal * pxPerSecond, top: 0, bottom: 0, width: 0 }}>
                <div style={{ position: 'absolute', bottom: 0, left: -0.5, width: 1, height: '100%', background: 'var(--border-subtle)' }} />
                <div style={{ position: 'absolute', bottom: 2, transform: 'translateX(-50%)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', fontSize: 10 }}>
                  {formatRulerLabel(tVal, tickStep)}
                </div>
              </div>
            ))}
            {secondDots.map((s) => (
              <div key={`sd-${s}`} style={{ position: 'absolute', left: s * pxPerSecond, bottom: 3, width: 3, height: 3, marginLeft: -1.5, background: 'var(--stage-tick)', borderRadius: 2 }} />
            ))}
            {snapGuideTime != null && (
              <div className="tl-snap-guide" style={{ left: snapGuideTime * pxPerSecond }} />
            )}
            <div ref={rulerPlayheadRef} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 2, background: 'var(--playhead)', pointerEvents: 'none', transform: 'translateZ(0)' }} />
          </div>
        </div>
      </div>

      {/* Tracks */}
      <div style={{ display: 'flex', marginTop: 8, flex: 1, minHeight: 0 }}>
        <div ref={tracksLabelsRef} className="no-scrollbar" style={{ width: LABEL_W, flex: '0 0 auto', padding: `${PAD_TOP}px 0`, height: '100%', overflowY: 'auto' }}>
          {tracks.map((t, i) => (
            <TrackHeader
              key={i}
              index={i}
              name={t.name}
              clipCount={trackMedia(t).length}
              selected={selectedTrackIndex === i}
              height={ROW_H}
              onSelect={() => setSelectedTrackIndex(selectedTrackIndex === i ? null : i)}
              onRename={(name) => useEditorStore.getState().renameTrack(i, name)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, kind: 'track', trackIndex: i }) }}
            />
          ))}
          <div style={{ height: 36, display: 'flex', padding: 5, boxSizing: 'border-box' }}>
            <button
              onClick={addTrack}
              title="Add Track"
              aria-label="Add Track"
              style={{
                flex: 1, background: 'var(--bg-control-subtle)', border: '1px dashed var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
              }}
            >
              <span className="ms" style={{ fontSize: 14 }} aria-hidden="true">add</span>
            </button>
          </div>
        </div>

        <div
          ref={tracksViewportRef}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onPointerDown={onTracksPointerDown}
          onPointerMove={onTracksPointerMove}
          onPointerUp={onTracksPointerUp}
          style={{
            position: 'relative',
            background: 'var(--bg-primary)',
            overflow: 'auto',
            outline: dropGhost ? '1px dashed var(--accent)' : 'none',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            flex: 1,
            minHeight: 0,
            height: '100%',
          }}
        >
          <div ref={tracksInnerRef} style={{ position: 'relative', width: timelineWidth, padding: `${PAD_TOP}px 0` }}>
            {tracks.map((t, i) => {
              const list = trackMedia(t)
              const overlaps = computeOverlaps(list)
              return (
                <div key={i} style={{ position: 'relative', height: ROW_H, background: selectedTrackIndex === i ? 'rgba(53, 64, 102, 0.2)' : 'transparent' }}>
                  {list.map((m) => {
                    const isDragging = drag?.ids.includes(m.id)
                    const isTrimming = trimmedId === m.id
                    const start = isTrimming ? trim.start : clipStart(m) + (isDragging ? drag.deltaTime : 0)
                    const dur = isTrimming ? trim.duration : clipDuration(m)
                    const clip = mediaById[m.clip_id]
                    const label = m.label || clip?.name || clip?.id || m.clip_id
                    return (
                      <TimelineClip
                        key={m.id}
                        id={m.id}
                        label={label}
                        left={start * pxPerSecond}
                        width={Math.max(1, dur * pxPerSecond)}
                        top={isDragging ? drag.rowDelta * ROW_H : 0}
                        height={ROW_H}
                        isSelected={selectedSet.has(m.id)}
                        isOverlapping={overlaps.has(m.id)}
                        isDragging={isDragging}
                        fadeInWidth={(m.fade_in || 0) * pxPerSecond}
                        fadeOutWidth={(m.fade_out || 0) * pxPerSecond}
                        title={`${label} @ ${start.toFixed(2)}s · ${dur.toFixed(2)}s${overlaps.has(m.id) ? ' (overlapping)' : ''}`}
                        onPointerDown={onClipPointerDown(m, i)}
                        onPointerMove={onClipPointerMove(m)}
                        onPointerUp={onClipPointerUp(m, i)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          const st = useEditorStore.getState()
                          if (!st.selectedClipIds.includes(m.id)) st.setSelectedClips([m.id])
                          setMenu({ x: e.clientX, y: e.clientY, kind: 'clip', clipId: m.id, trackIndex: i })
                        }}
                        onTrimStart={onTrimStart}
                      />
                    )
                  })}
                  <div style={{ position: 'absolute', inset: 0, borderBottom: '1px dashed var(--border)', pointerEvents: 'none', zIndex: 0 }} />
                </div>
              )
            })}

            {/* The drop indicator shows the clip's whole extent, so you can
                see where it will end, not just where it will start. */}
            {dropGhost && (
              <div
                className="tl-drop-ghost"
                style={{
                  left: dropGhost.start * pxPerSecond,
                  width: Math.max(2, dropGhost.dur * pxPerSecond),
                  top: PAD_TOP + dropGhost.trackIndex * ROW_H,
                  height: ROW_H,
                }}
              />
            )}

            {snapGuideTime != null && (
              <div className="tl-snap-guide" style={{ left: snapGuideTime * pxPerSecond }} />
            )}

            {trim && (
              <div className="tl-tooltip" style={{
                left: (trim.side === 'start' ? trim.start : trim.start + trim.duration) * pxPerSecond,
                top: PAD_TOP + trim.trackIndex * ROW_H,
              }}>
                {formatTimecode(trim.side === 'start' ? trim.start : trim.start + trim.duration)} · {trim.duration.toFixed(2)}s
              </div>
            )}

            <div ref={tracksPlayheadRef} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 2, background: 'var(--playhead)', pointerEvents: 'none', transform: 'translateZ(0)', zIndex: 200 }} />
          </div>
        </div>
      </div>

      <ContextMenu
        open={!!menu}
        x={menu?.x || 0}
        y={menu?.y || 0}
        items={menu ? (menu.kind === 'clip' ? clipMenuItems(menu.clipId, menu.trackIndex) : trackMenuItems(menu.trackIndex)) : []}
        onClose={() => setMenu(null)}
      />
    </div>
  )
})
