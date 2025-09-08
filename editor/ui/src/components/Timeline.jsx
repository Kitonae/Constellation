import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { useEditorStore } from '../store.js'
import { broadcastToDisplays } from '../display/displayManager.js'

export default function Timeline() {
  const project = useEditorStore((s) => s.project)
  const playing = useEditorStore((s) => s.playing)
  const addLog = useEditorStore((s) => s.addLog)
  const duration = project?.timeline?.duration_seconds ?? 60
  const tracks = project?.timeline?.tracks ?? []
  const media = project?.media ?? []
  const mediaById = useMemo(() => Object.fromEntries(media.map(m => [m.id, m])), [media])
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)
  const selectedClipId = useEditorStore((s) => s.selectedClipId)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const setSelectedClip = useEditorStore((s) => s.setSelectedClip)
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips)
  const tracksViewportRef = useRef(null) // scroll container for tracks
  const tracksInnerRef = useRef(null) // inner width element
  const rulerViewportRef = useRef(null) // scroll container for ruler
  const rulerInnerRef = useRef(null)
  const containerRef = tracksViewportRef // backwards compatibility for existing logic
  const [isDragOver, setDragOver] = useState(false)
  const [hoverTime, setHoverTime] = useState(null)
  const [drag, setDrag] = useState(null) // { clipId, startAtOffset }
  const [timelineWidth, setTimelineWidth] = useState(0)
  const [tracksViewportHeight, setTracksViewportHeight] = useState(0)
  const [pxPerSecond, setPxPerSecond] = useState(100) // zoom level
  // Local throttled time display (avoids re-rendering heavy timeline each frame)
  const [timeDisplay, setTimeDisplay] = useState(useEditorStore.getState().time || 0)
  const lastDisplayRef = useRef(0)
  const rulerPlayheadRef = useRef(null)
  const tracksPlayheadRef = useRef(null)
  // labels are integrated into the tracks viewport now (single scrollbar)
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
    // Convert clientX to a position within the timeline area (to the right of the labels)
    const innerTimelineWidth = Math.max(0, timelineWidth)
    const rel = Math.min(
      Math.max(clientX - rect.left + vp.scrollLeft - LABEL_W, 0),
      innerTimelineWidth
    )
    return (rel / Math.max(1, innerTimelineWidth)) * duration
  }, [duration, timelineWidth])

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
      addClipToTimeline({ clipId, startAt: tAt })
      setSelectedClip(clipId)
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
    }
    recalc()
    const ro = new ResizeObserver(() => recalc())
    if (tracksViewportRef.current) ro.observe(tracksViewportRef.current)
    return () => ro.disconnect()
  }, [duration, pxPerSecond])

  // Sync horizontal scroll between ruler and tracks
  useEffect(() => {
    const rvp = rulerViewportRef.current
    const tvp = tracksViewportRef.current
    if (!rvp || !tvp) return
    let lock = false
    function syncFromR() { if (lock) return; lock = true; tvp.scrollLeft = rvp.scrollLeft; lock = false }
    function syncFromT() { if (lock) return; lock = true; rvp.scrollLeft = tvp.scrollLeft; lock = false }
    rvp.addEventListener('scroll', syncFromR)
    tvp.addEventListener('scroll', syncFromT)
    return () => { rvp.removeEventListener('scroll', syncFromR); tvp.removeEventListener('scroll', syncFromT) }
  }, [])

  // Vertical scroll sync no longer needed; labels are inside the same viewport

  const stop = useCallback(() => { const st = useEditorStore.getState(); st.stop() }, [])

  const formatTimecode = (t) => {
    const abs = Math.max(0, t || 0)
    const h = Math.floor(abs / 3600)
    const m = Math.floor((abs % 3600) / 60)
    const s = abs % 60
    const sStr = s.toFixed(2).padStart(5, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`
  }

  const pickTickStep = (dur) => {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
    for (const st of steps) { if (dur / st <= 12) return st }
    return steps[steps.length - 1]
  }
  const tickStep = pickTickStep(duration)
  const ticks = []
  for (let t = 0; t <= duration + 1e-6; t += tickStep) ticks.push(Number(t.toFixed(6)))
  const secondDots = []
  for (let s = 0; s <= Math.floor(duration + 1e-6); s++) secondDots.push(s)

  const IconButton = ({ label, onClick, children }) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(e)=>{ e.preventDefault(); e.stopPropagation(); onClick?.(e) }}
      onMouseDown={(e)=>{ e.stopPropagation(); }}
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

  // Subscribe to store changes and update playhead/timecode without re-rendering heavy UI
  useEffect(() => {
    const unsub = useEditorStore.subscribe((state) => {
      const t = state.time || 0
      const dur = project?.timeline?.duration_seconds ?? duration
      const width = timelineWidth
      const clamped = Math.max(0, Math.min(dur, t))
      const x = (clamped / Math.max(0.0001, dur)) * width
      if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = x + 'px'
      if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = (LABEL_W + x) + 'px'
      const now = performance.now()
      if (now - lastDisplayRef.current > 125) { // ~8fps UI update for timecode
        lastDisplayRef.current = now
        setTimeDisplay(t)
      }
    })
    // Initial position
    try {
      const t = useEditorStore.getState().time
      const dur = project?.timeline?.duration_seconds ?? duration
      const width = timelineWidth
      const clamped = Math.max(0, Math.min(dur, t))
      const x = (clamped / Math.max(0.0001, dur)) * width
      if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = x + 'px'
      if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = (LABEL_W + x) + 'px'
    } catch {}
    return () => { try { unsub() } catch {} }
  }, [timelineWidth, duration, project])

  return (
    <div style={{ padding: 8, color: '#c7cfdb', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ marginBottom: 6, display:'flex', alignItems:'center', justifyContent:'space-between', position:'relative', zIndex: 5, pointerEvents:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div>Timeline</div>
          <div style={{ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, padding:'2px 6px', border:'1px solid #232636', borderRadius:4, background:'#0f1115', color:'#b9c3d6' }}>
            {formatTimecode(timeDisplay)}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:4, marginLeft:12 }}>
            <IconButton label="Zoom Out" onClick={()=>setPxPerSecond(p=>Math.max(10, Math.round(p/1.25)))}>−</IconButton>
            <IconButton label="Zoom In" onClick={()=>setPxPerSecond(p=>Math.min(800, Math.round(p*1.25)))}>＋</IconButton>
            <div style={{ fontSize:10, opacity:0.7, minWidth:60, textAlign:'center' }}>{pxPerSecond} px/s</div>
          </div>
        </div>
        <div style={{ display:'flex', gap:6, pointerEvents:'auto' }}>
          <IconButton label="Play" onClick={() => { const st = useEditorStore.getState(); st.play(); st.addLog({ level:'info', message:'Local Play' }) }}>▶</IconButton>
          <IconButton label="Pause" onClick={() => { const st = useEditorStore.getState(); st.pause(); st.addLog({ level:'info', message:'Local Pause' }) }}>⏸</IconButton>
          <IconButton label="Stop" onClick={() => {
            stop();
            const st = useEditorStore.getState();
            try { st.seek(0) } catch {}
            try { if (rulerViewportRef.current) rulerViewportRef.current.scrollLeft = 0 } catch {}
            try { if (tracksViewportRef.current) tracksViewportRef.current.scrollLeft = 0 } catch {}
            try { if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = '0px' } catch {}
            try { if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = '0px' } catch {}
            try { broadcastToDisplays('display:snapshot', { project: st.project, scene: st.scene, time: 0 }) } catch {}
            st.addLog({ level:'info', message:'Local Stop' })
          }}>■</IconButton>
        </div>
      </div>
      {/* Scrollable Ruler */}
      <div style={{ marginTop:4, display:'grid', gridTemplateColumns:`${LABEL_W}px 1fr`, gap:0 }}>
        <div />
        <div ref={rulerViewportRef} className="no-scrollbar" style={{ position:'relative', overflowX:'auto', overflowY:'hidden', height:24, border:'1px solid #232636', borderRadius:4, background:'#141821', cursor:'pointer' }}
          onPointerDown={(e)=>{ seekingRef.current = true; const t = timeFromClientX(e.clientX); const st = useEditorStore.getState(); st.seek(t); try { e.currentTarget.setPointerCapture(e.pointerId) } catch {} }}
          onPointerMove={(e)=>{ if (!seekingRef.current) return; const t = timeFromClientX(e.clientX); const st = useEditorStore.getState(); st.seek(t) }}
          onPointerUp={(e)=>{ seekingRef.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {} try { const st = useEditorStore.getState(); if (!st.playing) broadcastToDisplays('display:snapshot', { project: st.project, scene: st.scene, time: st.time }) } catch {} }}
          onClick={(e)=>{ const t = timeFromClientX(e.clientX); const st = useEditorStore.getState(); st.seek(t); if (!st.playing) { try { broadcastToDisplays('display:snapshot', { project: st.project, scene: st.scene, time: t }) } catch {} } }}
        >
          <div ref={rulerInnerRef} style={{ position:'relative', width: timelineWidth, height:'100%' }}>
            {ticks.map((tVal, idx) => {
              const x = (tVal / duration) * timelineWidth
              const major = (Math.abs((tVal / tickStep) - Math.round(tVal / tickStep)) < 1e-6)
              return (
                <div key={idx} style={{ position:'absolute', left:x, top:0, bottom:0, width:0 }}>
                  <div style={{ position:'absolute', bottom:0, left:-0.5, width:1, height: major ? '100%' : '50%', background:'#3a4060' }} />
                  {major && (
                    <div style={{ position:'absolute', bottom:2, transform:'translateX(-50%)', color:'#9aa6b9', whiteSpace:'nowrap', fontSize:10 }}>
                      {tVal < 60 ? tVal.toFixed(tickStep < 1 ? 1 : 0) + 's' : formatTimecode(tVal)}
                    </div>
                  )}
                </div>
              )
            })}
            {secondDots.map((s)=>{
              const x = (s / duration) * timelineWidth
              return <div key={`sd-${s}`} style={{ position:'absolute', left:x, bottom:3, width:3, height:3, marginLeft:-1.5, background:'#4a5674', borderRadius:2 }} />
            })}
            <div ref={rulerPlayheadRef} style={{ position:'absolute', top:0, bottom:0, left:0, width:2, background:'#ff6', pointerEvents:'none', transform:'translateZ(0)' }} />
          </div>
        </div>
      </div>
      {/* Tracks and labels integrated (single scrollbar) */}
      <div
        ref={tracksViewportRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={(e)=>{ if (!e.ctrlKey && !e.metaKey) setSelectedClips([]) }}
        style={{
          position:'relative',
          background:'#0f1115',
          overflowX:'auto',
          overflowY:'auto',
          outline: isDragOver ? '1px dashed #5a78ff' : 'none',
          border:'1px solid #232636',
          borderRadius:4,
          flex:1,
          minHeight: 0,
          height: '100%',
          marginTop: 8,
        }}
      >
        <div
          ref={tracksInnerRef}
          style={{
            position:'relative',
            width: LABEL_W + timelineWidth,
            padding:'8px 0',
            boxSizing:'content-box',
          }}
        >
          {/* Vertical divider between labels and track timeline */}
          <div style={{ position:'absolute', top:0, bottom:0, left: LABEL_W, width:1, background:'#232636', pointerEvents:'none' }} />

          {tracks.filter(t=>t.media).map((t,i)=>{
            const m = t.media
            const startVal = (m.start ?? m.start_at_seconds) || 0
            const durVal = m.duration ?? ((m.out_seconds - m.in_seconds) || 0)
            const left = (startVal / Math.max(0.0001, duration)) * timelineWidth
            const width = (Math.max(0, durVal) / Math.max(0.0001, duration)) * timelineWidth
            const clip = mediaById[m.clip_id]
            const label = clip?.name || clip?.id || m.clip_id
            const isSelected = Array.isArray(selectedClipIds) ? selectedClipIds.includes(m.id) : (selectedClipId === m.id)
            return (
              <div key={i} style={{ display:'grid', gridTemplateColumns: `${LABEL_W}px ${timelineWidth}px`, height:28, margin:'6px 0', alignItems:'center' }}>
                {/* Label cell */}
                <div style={{ padding:'0 8px', boxSizing:'border-box', color:'#c7cfdb', background:'#111522' }}>
                  <div style={{ fontSize:12, opacity:0.85, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{`Track ${i+1}`}</div>
                </div>
                {/* Track cell */}
                <div style={{ position:'relative', height:'100%' }} onClick={(e)=>{ if (!e.ctrlKey && !e.metaKey) setSelectedClips([]) }}>
                  <div
                    onClick={(e)=>{ 
                      e.stopPropagation(); 
                      const multi = e.ctrlKey || e.metaKey
                      if (multi) {
                        const st = useEditorStore.getState()
                        const curr = new Set(st.selectedClipIds || [])
                        if (curr.has(m.id)) curr.delete(m.id); else curr.add(m.id)
                        st.setSelectedClips(Array.from(curr))
                      } else {
                        setSelectedClip(m.id)
                      }
                    }}
                    onPointerDown={(e)=>{
                      if (e.button !== 0) return
                      e.stopPropagation()
                      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                      const tAt = timeFromClientX(e.clientX)
                      const st = useEditorStore.getState()
                      const ids = (st.selectedClipIds || []).includes(m.id) && (st.selectedClipIds || []).length > 0
                        ? [...new Set(st.selectedClipIds)]
                        : [m.id]
                      const offsetsById = {}
                      const tracks = st.project?.timeline?.tracks || []
                      const index = new Map()
                      for (const t of tracks) { if (t.media) index.set(t.media.id, t.media) }
                      ids.forEach((id) => {
                        const tm = index.get(id)
                        const start = (tm?.start ?? tm?.start_at_seconds) || 0
                        offsetsById[id] = tAt - start
                      })
                      setDrag({ ids, offsetsById })
                    }}
                    onPointerMove={(e)=>{
                      if (!drag) return
                      const tAt = timeFromClientX(e.clientX)
                      const st = useEditorStore.getState()
                      const ids = drag.ids || []
                      for (const id of ids) {
                        const off = drag.offsetsById?.[id] ?? 0
                        const newStart = tAt - off
                        st.updateClipStart({ timelineId: id, startAt: newStart })
                      }
                    }}
                    onPointerUp={(e)=>{
                      if (drag) setDrag(null)
                      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                    }}
                    style={{ position:'absolute', left, width, height:'100%', background: isSelected ? '#354066' : '#2a2f45', border:`1px solid ${isSelected ? '#6aa0ff' : '#3a4060'}`, boxShadow: isSelected ? '0 0 0 1px #6aa0ff66' : 'none', borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'hidden', cursor:'grab' }} title={`${label} @ ${(m.start ?? m.start_at_seconds ?? 0).toFixed?.(2)}s`}>
                    <span style={{ whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden', fontSize:12 }}>{label}</span>
                  </div>
                </div>
              </div>
            )
          })}

          <div ref={tracksPlayheadRef} style={{ position:'absolute', top:0, bottom:0, left: LABEL_W, width:2, background:'#ff6', pointerEvents:'none', transform:'translateZ(0)' }} />
          {isDragOver && hoverTime != null && (
            <div title={`${hoverTime.toFixed(2)}s`} style={{ position:'absolute', top:0, bottom:0, left: LABEL_W + (hoverTime / Math.max(0.0001, duration)) * timelineWidth, width:2, background:'#5a78ff' }} />
          )}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7, marginTop:4 }}>
        <span>0.0</span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
