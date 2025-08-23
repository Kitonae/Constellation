import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { useEditorStore } from '../store.js'

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
  const setSelectedClip = useEditorStore((s) => s.setSelectedClip)
  const tracksViewportRef = useRef(null) // scroll container for tracks
  const tracksInnerRef = useRef(null) // inner width element
  const rulerViewportRef = useRef(null) // scroll container for ruler
  const rulerInnerRef = useRef(null)
  const containerRef = tracksViewportRef // backwards compatibility for existing logic
  const [isDragOver, setDragOver] = useState(false)
  const [hoverTime, setHoverTime] = useState(null)
  const [drag, setDrag] = useState(null) // { clipId, startAtOffset }
  const [timelineWidth, setTimelineWidth] = useState(0)
  const [pxPerSecond, setPxPerSecond] = useState(100) // zoom level
  // Local throttled time display (avoids re-rendering heavy timeline each frame)
  const [timeDisplay, setTimeDisplay] = useState(useEditorStore.getState().time || 0)
  const lastDisplayRef = useRef(0)
  const rulerPlayheadRef = useRef(null)
  const tracksPlayheadRef = useRef(null)
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
    return (rel / Math.max(1, inner.clientWidth)) * duration
  }, [duration])

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
      const width = Math.max(vp.clientWidth, Math.round(duration * pxPerSecond))
      setTimelineWidth(width)
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

  // Subscribe to time changes and update lightweight DOM nodes instead of full re-render
  useEffect(() => {
    const unsub = useEditorStore.subscribe((s) => s.time, (t) => {
      const dur = project?.timeline?.duration_seconds ?? duration
      const width = timelineWidth
      const clamped = Math.max(0, Math.min(dur, t))
      const x = (clamped / Math.max(0.0001, dur)) * width
      if (rulerPlayheadRef.current) rulerPlayheadRef.current.style.left = x + 'px'
      if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = x + 'px'
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
      if (tracksPlayheadRef.current) tracksPlayheadRef.current.style.left = x + 'px'
    } catch {}
    return () => { try { unsub() } catch {} }
  }, [timelineWidth, duration, project])

  return (
    <div style={{ padding: 8, color: '#c7cfdb' }}>
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
          <IconButton label="Stop" onClick={() => { stop(); const st = useEditorStore.getState(); st.addLog({ level:'info', message:'Local Stop' }) }}>■</IconButton>
        </div>
      </div>
      {/* Scrollable Ruler */}
      <div style={{ marginTop:4, display:'grid', gridTemplateColumns:`${LABEL_W}px 1fr`, gap:GRID_GAP }}>
        <div style={{ fontSize:10, color:'#6b768a', display:'flex', alignItems:'flex-end', paddingBottom:2 }}>Time</div>
        <div ref={rulerViewportRef} style={{ position:'relative', overflowX:'auto', overflowY:'hidden', height:32, border:'1px solid #232636', borderRadius:4, background:'#141821', cursor:'pointer' }}
          onPointerDown={(e)=>{ seekingRef.current = true; const t = timeFromClientX(e.clientX); useEditorStore.getState().seek(t); try { e.currentTarget.setPointerCapture(e.pointerId) } catch {} }}
          onPointerMove={(e)=>{ if (!seekingRef.current) return; const t = timeFromClientX(e.clientX); useEditorStore.getState().seek(t) }}
          onPointerUp={(e)=>{ seekingRef.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {} }}
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
      {/* Tracks (labels separated for alignment with ruler) */}
      <div style={{ display:'flex', marginTop:8 }}>
        <div style={{ width: LABEL_W, flex:'0 0 auto', padding:'8px 0' }}>
          {tracks.filter(t=>t.media).map((t,i)=>
            <div key={i} style={{ height:28, margin:'6px 8px', marginRight:0, display:'flex', alignItems:'center', justifyContent:'flex-start' }}>
              <div style={{ fontSize:12, opacity:0.8, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{`Track ${i+1}`}</div>
            </div>
          )}
        </div>
        <div
          ref={tracksViewportRef}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={(e)=>{ if (e.target === tracksViewportRef.current) setSelectedClip(null) }}
          style={{
            position:'relative',
            background:'#0f1115',
            overflowX:'auto',
            overflowY:'hidden',
            outline: isDragOver ? '1px dashed #5a78ff' : 'none',
            border:'1px solid #232636',
            borderRadius:4,
            flex:1,
          }}
        >
          <div ref={tracksInnerRef} style={{ position:'relative', width: timelineWidth, padding:'8px 0' }}>
            {tracks.filter(t => t.media).map((t, i) => {
              const m = t.media
              const startVal = (m.start ?? m.start_at_seconds) || 0
              const durVal = m.duration ?? ((m.out_seconds - m.in_seconds) || 0)
              const left = (startVal / Math.max(0.0001, duration)) * timelineWidth
              const width = (Math.max(0, durVal) / Math.max(0.0001, duration)) * timelineWidth
              const clip = mediaById[m.clip_id]
              const label = clip?.name || clip?.id || m.clip_id
              const isSelected = selectedClipId === m.id
              return (
                <div key={i} style={{ position:'relative', height:28, margin:'6px 8px' }}>
                  <div
                    onClick={(e)=>{ e.stopPropagation(); setSelectedClip(m.id) }}
                    onPointerDown={(e)=>{
                      if (e.button !== 0) return
                      e.stopPropagation()
                      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                      const tAt = timeFromClientX(e.clientX)
                      const offset = tAt - (m.start ?? m.start_at_seconds ?? 0)
                      setDrag({ clipId: m.id, startAtOffset: offset })
                    }}
                    onPointerMove={(e)=>{
                      if (!drag || drag.clipId !== m.clip_id) return
                      const tAt = timeFromClientX(e.clientX)
                      const newStart = tAt - drag.startAtOffset
                      useEditorStore.getState().updateClipStart({ timelineId: m.id, startAt: newStart })
                    }}
                    onPointerUp={(e)=>{
                      if (drag?.clipId === m.clip_id) setDrag(null)
                      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
                    }}
                    style={{ position:'absolute', left, width, height:'100%', background: isSelected ? '#354066' : '#2a2f45', border:`1px solid ${isSelected ? '#6aa0ff' : '#3a4060'}`, boxShadow: isSelected ? '0 0 0 1px #6aa0ff66' : 'none', borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'hidden', cursor:'grab' }} title={`${label} @ ${(m.start ?? m.start_at_seconds ?? 0).toFixed?.(2)}s`}>
                    <span style={{ whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden', fontSize:12 }}>{label}</span>
                  </div>
                </div>
              )
            })}
            <div ref={tracksPlayheadRef} style={{ position:'absolute', top:0, bottom:0, left:0, width:2, background:'#ff6', pointerEvents:'none', transform:'translateZ(0)' }} />
            {isDragOver && hoverTime != null && (
              <div title={`${hoverTime.toFixed(2)}s`} style={{ position:'absolute', top:0, bottom:0, left: (hoverTime / Math.max(0.0001, duration)) * timelineWidth, width:2, background:'#5a78ff' }} />
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7, marginTop:4 }}>
        <span>0.0</span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
