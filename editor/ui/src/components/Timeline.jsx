import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { useEditorStore, getMediaSession } from '../store.js'
import { computeOverlaps } from '../utils/mediaUtils.js'

// Track row geometry. Exported so the drop hit-test and the row style can
// never drift apart again — they used to disagree (28 px rows, 40 px maths),
// which put every drop past the first row on the wrong track.
export const ROW_H = 28
export const PAD_TOP = 8

export default React.memo(function Timeline() {
  const project = useEditorStore((s) => s.project)
  const playing = useEditorStore((s) => s.playing)
  const addLog = useEditorStore((s) => s.addLog)
  const tracks = project?.timeline?.tracks ?? []
  const media = project?.media ?? []
  const mediaById = useMemo(() => Object.fromEntries(media.map(m => [m.id, m])), [media])
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)
  const addTrack = useEditorStore((s) => s.addTrack)
  const selectedClipId = useEditorStore((s) => s.selectedClipId)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const setSelectedClip = useEditorStore((s) => s.setSelectedClip)
  const selectedTrackIndex = useEditorStore((s) => s.selectedTrackIndex)
  const setSelectedTrackIndex = useEditorStore((s) => s.setSelectedTrackIndex)
  const maxClipEnd = useMemo(() => {
    let max = 0
    for (const t of tracks) {
      const mediaList = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
      for (const m of mediaList) {
        const end = (m.start ?? m.start_at_seconds ?? 0) + (m.duration ?? ((m.out_seconds - m.in_seconds) || 0))
        if (end > max) max = end
      }
    }
    return max
  }, [tracks])

  // Infinite timeline: at least 60s, or max clip + 5 mins buffer
  const duration = Math.max((project?.timeline?.duration_seconds ?? 60), maxClipEnd + 300)

  const tracksViewportRef = useRef(null) // scroll container for tracks
  const tracksInnerRef = useRef(null) // inner width element
  const rulerViewportRef = useRef(null) // scroll container for ruler
  const rulerInnerRef = useRef(null)
  const containerRef = tracksViewportRef // backwards compatibility for existing logic
  const [isDragOver, setDragOver] = useState(false)
  const [hoverTime, setHoverTime] = useState(null)
  const [drag, setDrag] = useState(null) // { clipId, startAtOffset }
  const dragRef = useRef(null)
  const [timelineWidth, setTimelineWidth] = useState(0)
  // Visible slice of the ruler, mirrored from scrollLeft at most every 50 ms
  // so tick rendering can be limited to what is on screen.
  const [view, setView] = useState({ left: 0, width: 0 })
  const viewRef = useRef({ left: 0, width: 0 })
  const viewFlushRef = useRef(0)
  const [tracksViewportHeight, setTracksViewportHeight] = useState(0)
  const [pxPerSecond, setPxPerSecond] = useState(20) // Default 20 px/s
  // Local throttled time display (avoids re-rendering heavy timeline each frame)
  const [timeDisplay, setTimeDisplay] = useState(useEditorStore.getState().time || 0)
  const lastDisplayRef = useRef(0)
  const rulerPlayheadRef = useRef(null)
  const tracksPlayheadRef = useRef(null)
  // labels are integrated into the tracks viewport now (single scrollbar)
  const tracksLabelsRef = useRef(null)
  const seekingRef = useRef(false)

  // Layout constants shared by slider, playhead and hit-testing
  const LABEL_W = 120
  const ROW_MARGIN_X = 8
  const GRID_GAP = 8

  // Translate a clientX within the tracks viewport to timeline time considering scroll
  const timeFromClientX = useCallback((clientX) => {
    const vp = tracksViewportRef.current
    const inner = tracksInnerRef.current
    if (!vp || !inner) return 0
    const rect = vp.getBoundingClientRect()
    const rel = Math.min(Math.max(clientX - rect.left + vp.scrollLeft, 0), inner.clientWidth)
    return rel / pxPerSecond
  }, [pxPerSecond])

  const onDragOver = (e) => {
    if (e.dataTransfer.types.includes('application/x-constellation-clip-id') || e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
      setHoverTime(timeFromClientX(e.clientX))
    }
  }
  const onDragLeave = () => { setDragOver(false); setHoverTime(null) }
  const onDrop = (e) => {
    e.preventDefault()
    const clipId = e.dataTransfer.getData('application/x-constellation-clip-id') || e.dataTransfer.getData('text/plain')
    if (clipId) {
      const tAt = timeFromClientX(e.clientX)

      // Calculate track index from Y using the real row geometry
      const vp = tracksViewportRef.current
      let trackIndex = -1
      if (vp) {
        const rect = vp.getBoundingClientRect()
        const relY = e.clientY - rect.top + vp.scrollTop
        trackIndex = Math.floor((relY - PAD_TOP) / ROW_H)
      }

      // Selection is by timeline item id, not media asset id.
      const newId = addClipToTimeline({ clipId, startAt: tAt, trackIndex })
      if (newId) setSelectedClip(newId)
    }
    setDragOver(false); setHoverTime(null)
  }

  // Measure timeline width whenever duration changes or container resizes
  useEffect(() => {
    function recalc() {
      const vp = tracksViewportRef.current
      if (!vp) return
      // Only the timeline area (to the right of labels) should determine width
      const visibleTrackWidth = Math.max(0, vp.clientWidth - LABEL_W)
      const width = Math.max(visibleTrackWidth, Math.round(duration * pxPerSecond))
      setTimelineWidth(width)
      setTracksViewportHeight(vp.clientHeight || 0)
      setView({ left: vp.scrollLeft, width: vp.clientWidth })
    }
    recalc()
    const ro = new ResizeObserver(() => recalc())
    if (tracksViewportRef.current) ro.observe(tracksViewportRef.current)
    return () => ro.disconnect()
  }, [duration, pxPerSecond])

  // Sync horizontal scroll between ruler and tracks, and publish the visible
  // range for the tick renderer. The range goes through a trailing 50 ms
  // flush so a scroll gesture does not re-render the ruler every frame.
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

  // Keep the labels column aligned with the tracks it labels. They are
  // separate scroll containers so the ruler can stay pinned above the tracks,
  // which means their vertical offsets have to be mirrored explicitly.
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

  const stop = useCallback(() => { const st = useEditorStore.getState(); st.stop() }, [])

  const formatTimecode = (t) => {
    const abs = Math.max(0, t || 0)
    const h = Math.floor(abs / 3600)
    const m = Math.floor((abs % 3600) / 60)
    const s = abs % 60
    const sStr = s.toFixed(2).padStart(5, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`
  }

  const pickTickStep = (pxPerSec) => {
    // Target ~100px per major tick
    const target = 100 / pxPerSec
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
    // Find closest step >= target
    for (const st of steps) { if (st >= target) return st }
    return steps[steps.length - 1]
  }
  const tickStep = pickTickStep(pxPerSecond)

  // Only build ticks for the visible slice of the ruler. Spanning the whole
  // 360 s buffer at 200 px/s meant ~700 tick divs plus ~360 dots rebuilt on
  // every render.
  const { ticks, secondDots } = useMemo(() => {
    const from = Math.max(0, view.left / pxPerSecond - tickStep)
    const to = Math.min(duration, (view.left + view.width) / pxPerSecond + tickStep)
    const ticksOut = []
    const first = Math.floor(from / tickStep) * tickStep
    for (let t = first; t <= to + 1e-6; t += tickStep) {
      if (t >= -1e-6) ticksOut.push(Number(t.toFixed(6)))
    }
    const dotsOut = []
    // Second dots only make sense once a second is more than a few pixels
    if (pxPerSecond > 10) {
      for (let sec = Math.max(0, Math.floor(from)); sec <= Math.floor(to + 1e-6); sec++) dotsOut.push(sec)
    }
    return { ticks: ticksOut, secondDots: dotsOut }
  }, [view.left, view.width, pxPerSecond, tickStep, duration])

  const IconButton = ({ label, onClick, children }) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseDown={(e) => { e.stopPropagation() }}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f1115',
        color: '#c7cfdb',
        border: '1px solid #232636',
        borderRadius: 4,
        padding: 0,
        cursor: 'pointer',
        position: 'relative',
        zIndex: 3,
      }}
      role="button"
      tabIndex={0}
    >
      <span style={{ lineHeight: 1, fontSize: 12 }}>{children}</span>
    </button>
  )

  // Drive the playhead straight from the PresentationClock. Going through the
  // store meant the playhead moved at the store's 10 Hz mirror rate, and the
  // clamp used `duration_seconds` (60 s) instead of the duration actually
  // rendered, so the playhead froze while time kept running.
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

  return (
    <div style={{ padding: 8, color: '#c7cfdb', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0, userSelect: 'none', WebkitUserSelect: 'none' }}>
      <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative', zIndex: 5, pointerEvents: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div>Timeline</div>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '2px 6px', border: '1px solid #232636', borderRadius: 4, background: '#0f1115', color: '#b9c3d6' }}>
            {formatTimecode(timeDisplay)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12 }}>
            <IconButton label="Zoom Out" onClick={() => setPxPerSecond(p => Math.max(1, p - 5))}>−</IconButton>
            <IconButton label="Zoom In" onClick={() => setPxPerSecond(p => Math.min(200, p + 5))}>＋</IconButton>
            <div style={{ fontSize: 10, opacity: 0.7, minWidth: 60, textAlign: 'center' }}>{pxPerSecond} px/s</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, pointerEvents: 'auto' }}>
          <IconButton label="Play" onClick={() => { const st = useEditorStore.getState(); st.play(); st.addLog({ level: 'info', message: 'Local Play' }) }}>▶</IconButton>
          <IconButton label="Pause" onClick={() => { const st = useEditorStore.getState(); st.pause(); st.addLog({ level: 'info', message: 'Local Pause' }) }}>⏸</IconButton>
          <IconButton label="Stop" onClick={() => {
            stop();
            const st = useEditorStore.getState();
            try { st.seek(0) } catch { }
            try { if (rulerViewportRef.current) rulerViewportRef.current.scrollLeft = 0 } catch { }
            try { if (tracksViewportRef.current) tracksViewportRef.current.scrollLeft = 0 } catch { }
            try { if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = '0px' } catch { }
            try { if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = '0px' } catch { }
            st.addLog({ level: 'info', message: 'Local Stop' })
          }}>■</IconButton>
        </div>
      </div>
      {/* Scrollable Ruler */}
      <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, gap: 0 }}>
        <div />
        <div ref={rulerViewportRef} className="no-scrollbar" style={{ position: 'relative', overflowX: 'auto', overflowY: 'hidden', height: 24, border: '1px solid #232636', borderRadius: 4, background: '#141821', cursor: 'pointer' }}
          onPointerDown={(e) => { seekingRef.current = true; const t = timeFromClientX(e.clientX); const st = useEditorStore.getState(); st.seek(t); try { e.currentTarget.setPointerCapture(e.pointerId) } catch { } }}
          onPointerMove={(e) => { if (!seekingRef.current) return; const t = timeFromClientX(e.clientX); const st = useEditorStore.getState(); st.seek(t) }}
          onPointerUp={(e) => { seekingRef.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { } }}
          onClick={(e) => { if (seekingRef.current) return; useEditorStore.getState().seek(timeFromClientX(e.clientX)) }}
        >
          <div ref={rulerInnerRef} style={{ position: 'relative', width: timelineWidth, height: '100%' }}>
            {ticks.map((tVal, idx) => {
              const x = tVal * pxPerSecond
              const major = (Math.abs((tVal / tickStep) - Math.round(tVal / tickStep)) < 1e-6)
              return (
                <div key={idx} style={{ position: 'absolute', left: x, top: 0, bottom: 0, width: 0 }}>
                  <div style={{ position: 'absolute', bottom: 0, left: -0.5, width: 1, height: major ? '100%' : '50%', background: '#3a4060' }} />
                  {major && (
                    <div style={{ position: 'absolute', bottom: 2, transform: 'translateX(-50%)', color: '#9aa6b9', whiteSpace: 'nowrap', fontSize: 10 }}>
                      {tVal < 60 ? tVal.toFixed(tickStep < 1 ? 1 : 0) + 's' : formatTimecode(tVal)}
                    </div>
                  )}
                </div>
              )
            })}
            {secondDots.map((s) => {
              const x = s * pxPerSecond
              return <div key={`sd-${s}`} style={{ position: 'absolute', left: x, bottom: 3, width: 3, height: 3, marginLeft: -1.5, background: '#4a5674', borderRadius: 2 }} />
            })}
            <div ref={rulerPlayheadRef} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 2, background: '#ff6', pointerEvents: 'none', transform: 'translateZ(0)' }} />
          </div>
        </div>
      </div>
      {/* Tracks (labels separated for alignment with ruler) */}
      <div style={{ display: 'flex', marginTop: 8, flex: 1, minHeight: 0 }}>
        <div ref={tracksLabelsRef} className="no-scrollbar" style={{ width: LABEL_W, flex: '0 0 auto', padding: `${PAD_TOP}px 0`, height: '100%', overflowY: 'auto' }}>
          {tracks.map((t, i) => {
            const isSelected = selectedTrackIndex === i
            return (
              <div
                key={i}
                onClick={() => setSelectedTrackIndex(i)}
                style={{
                  height: ROW_H,
                  boxSizing: 'border-box',
                  margin: 0,
                  marginRight: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingRight: 8,
                  background: isSelected ? '#354066' : 'transparent',
                  cursor: 'pointer',
                  borderRadius: '4px 0 0 4px',
                  borderRight: isSelected ? '2px solid #6aa0ff' : 'none',
                  borderBottom: '1px dashed #232636'
                }}
              >
                <div style={{ fontSize: 12, opacity: isSelected ? 1 : 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 8 }}>{`Track ${i + 1}`}</div>
              </div>
            )
          })}
          <div style={{ height: 36, boxSizing: 'border-box', margin: 0, display: 'flex', padding: 5, borderBottom: '1px solid transparent' }}>
            <button
              onClick={addTrack}
              title="Add Track"
              aria-label="Add Track"
              style={{
                flex: 1,
                background: '#161820',
                color: '#c7cfdb',
                border: '1px dashed rgb(35, 38, 54)',
                borderRadius: 4,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                fontSize: 12,
                lineHeight: 1
              }}
            >
              ＋
            </button>
          </div>
        </div>
        <div
          ref={tracksViewportRef}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={(e) => { if (e.target === tracksViewportRef.current) setSelectedClip(null) }}
          style={{
            position: 'relative',
            background: '#0f1115',
            overflowX: 'auto',
            overflowY: 'auto',
            outline: isDragOver ? '1px dashed #5a78ff' : 'none',
            border: '1px solid #232636',
            borderRadius: 4,
            flex: 1,
            minHeight: 0,
            height: '100%',
          }}
        >
          <div ref={tracksInnerRef} style={{ position: 'relative', width: timelineWidth, padding: `${PAD_TOP}px 0` }}>
            {tracks.map((t, i) => {
              const mediaList = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])

              const overlaps = computeOverlaps(mediaList)

              return (
                <div key={i} style={{ position: 'relative', height: ROW_H, margin: 0, zIndex: 1, background: selectedTrackIndex === i ? 'rgba(53, 64, 102, 0.2)' : 'transparent', borderRadius: '0 4px 4px 0' }}>
                  {mediaList.map((m) => {
                    const startVal = (m.start ?? m.start_at_seconds) || 0
                    const durVal = m.duration ?? ((m.out_seconds - m.in_seconds) || 0)
                    const isDragging = drag?.timelineId === m.id && drag.currentStart !== undefined
                    const effectiveStart = isDragging ? drag.currentStart : startVal
                    const left = effectiveStart * pxPerSecond
                    const width = Math.max(0, durVal) * pxPerSecond
                    const clip = mediaById[m.clip_id]
                    const label = clip?.name || clip?.id || m.clip_id
                    const isSelected = selectedClipId === m.id
                    const isOverlapping = overlaps.has(m.id)

                    // Vertical drag calculation
                    const verticalOffset = (drag?.timelineId === m.id && drag.currentY !== undefined) ? drag.currentY : 0
                    const zIndex = (drag?.timelineId === m.id) ? 100 : 1

                    const fadeIn = m.fade_in || 0
                    const fadeOut = m.fade_out || 0
                    const fadeInWidth = fadeIn * pxPerSecond
                    const fadeOutWidth = fadeOut * pxPerSecond

                    return (
                      <div
                        key={m.id}
                        onClick={(e) => { e.stopPropagation(); setSelectedClip(m.id) }}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          e.stopPropagation()
                          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
                          const tAt = timeFromClientX(e.clientX)
                          const offset = tAt - (m.start ?? m.start_at_seconds ?? 0)
                          const d = { timelineId: m.id, startAtOffset: offset, startY: e.clientY, currentY: 0, originalIndex: i }
                          setDrag(d)
                          dragRef.current = d
                        }}
                        onPointerMove={(e) => {
                          if (!dragRef.current || dragRef.current.timelineId !== m.id) return
                          const tAt = timeFromClientX(e.clientX)
                          const newStart = tAt - dragRef.current.startAtOffset
                          const dy = e.clientY - dragRef.current.startY
                          dragRef.current = { ...dragRef.current, currentStart: newStart, currentY: dy }
                          setDrag({ ...dragRef.current })
                        }}
                        onPointerUp={(e) => {
                          if (dragRef.current?.timelineId === m.id) {
                            const d = dragRef.current
                            // One gesture, one commit, one undo entry.
                            const rowDelta = d.currentY !== undefined ? Math.round(d.currentY / ROW_H) : 0
                            const patch = {}
                            if (d.currentStart !== undefined) patch.start = d.currentStart
                            if (rowDelta !== 0) patch.trackIndex = d.originalIndex + rowDelta
                            if (patch.start !== undefined || patch.trackIndex !== undefined) {
                              useEditorStore.getState().moveClip(m.id, patch)
                            }
                            setDrag(null)
                            dragRef.current = null
                          }
                          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
                        }}
                        style={{
                          position: 'absolute',
                          left,
                          top: verticalOffset,
                          width,
                          height: ROW_H,
                          boxSizing: 'border-box',
                          background: isOverlapping ? '#4a2a2a' : (isSelected ? '#354066' : '#2a2f45'),
                          border: `1px solid ${isOverlapping ? '#ff4444' : (isSelected ? '#6aa0ff' : '#3a4060')}`,
                          boxShadow: isSelected ? '0 0 0 1px #6aa0ff66' : 'none',
                          borderRadius: 4,
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0 8px',
                          overflow: 'hidden',
                          cursor: 'grab',
                          transition: drag?.timelineId === m.id ? 'none' : 'top 0.2s ease',
                          zIndex
                        }}
                        title={`${label} @ ${(m.start ?? m.start_at_seconds ?? 0).toFixed?.(2)}s${isOverlapping ? ' (Overlapping)' : ''}`}
                      >
                        {fadeIn > 0 && (
                          <div style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: fadeInWidth,
                            background: 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.1), rgba(255,255,255,0.1) 5px, transparent 5px, transparent 10px)',
                            pointerEvents: 'none',
                            zIndex: 2
                          }} />
                        )}
                        {fadeOut > 0 && (
                          <div style={{
                            position: 'absolute',
                            right: 0,
                            top: 0,
                            bottom: 0,
                            width: fadeOutWidth,
                            background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.1), rgba(255,255,255,0.1) 5px, transparent 5px, transparent 10px)',
                            pointerEvents: 'none',
                            zIndex: 2
                          }} />
                        )}
                        <span style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontSize: 12, position: 'relative', zIndex: 3 }}>{label}</span>
                        {isOverlapping && <div style={{ position: 'absolute', right: 4, top: 0, bottom: 0, display: 'flex', alignItems: 'center', color: '#ff4444', fontWeight: 'bold' }}>!</div>}
                      </div>
                    )
                  })}
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderBottom: '1px dashed #232636', pointerEvents: 'none', zIndex: 0 }} />
                </div>
              )
            })}
            <div ref={tracksPlayheadRef} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 2, background: '#ff6', pointerEvents: 'none', transform: 'translateZ(0)', zIndex: 200 }} />
            {isDragOver && hoverTime != null && (
              <div title={`${hoverTime.toFixed(2)}s`} style={{ position: 'absolute', top: 0, bottom: 0, left: hoverTime * pxPerSecond, width: 2, background: '#5a78ff' }} />
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7, marginTop: 4 }}>
        <span>0.0</span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
})
