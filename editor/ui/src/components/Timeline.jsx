import React, { useMemo, useRef, useState, useCallback } from 'react'
import { useEditorStore } from '../store.js'

export default function Timeline() {
  const time = useEditorStore((s) => s.time)
  const project = useEditorStore((s) => s.project)
  const playing = useEditorStore((s) => s.playing)
  const addLog = useEditorStore((s) => s.addLog)
  const duration = project?.timeline?.duration_seconds ?? 60
  const tracks = project?.timeline?.tracks ?? []
  const media = project?.media ?? []
  const mediaById = useMemo(() => Object.fromEntries(media.map(m => [m.id, m])), [media])
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)
  const scene = useEditorStore((s) => s.scene)
  const nodeIndex = useMemo(() => {
    const map = new Map()
    const roots = scene?.roots || []
    const stack = [...roots]
    while (stack.length) {
      const n = stack.pop()
      if (!n) continue
      map.set(n.id, n)
      if (n.children?.length) stack.push(...n.children)
    }
    return map
  }, [scene])
  const selectedClipId = useEditorStore((s) => s.selectedClipId)
  const setSelectedClip = useEditorStore((s) => s.setSelectedClip)
  const containerRef = useRef(null)
  const [isDragOver, setDragOver] = useState(false)
  const [hoverTime, setHoverTime] = useState(null)

  const timeFromClientX = useCallback((clientX) => {
    const el = containerRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width)
    const t = (x / Math.max(1, rect.width)) * duration
    return t
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

  const onChange = (e) => {
    const v = parseFloat(e.target.value)
    if (!Number.isNaN(v)) useEditorStore.getState().seek(v)
  }

  const stop = useCallback(() => { const st = useEditorStore.getState(); st.stop() }, [])

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

  const formatTimecode = (t) => {
    const abs = Math.max(0, t || 0)
    const h = Math.floor(abs / 3600)
    const m = Math.floor((abs % 3600) / 60)
    const s = abs % 60
    const sStr = s.toFixed(2).padStart(5, '0') // 0-padded seconds with hundredths
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sStr}` : `${m}:${sStr}`
  }

  return (
    <div style={{ padding: 8, color: '#c7cfdb' }}>
      <div style={{ marginBottom: 6, display:'flex', alignItems:'center', justifyContent:'space-between', position:'relative', zIndex: 5, pointerEvents:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div>Timeline</div>
          <div style={{ fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, padding:'2px 6px', border:'1px solid #232636', borderRadius:4, background:'#0f1115', color:'#b9c3d6' }}>
            {formatTimecode(time)}
          </div>
        </div>
        <div style={{ display:'flex', gap:6, pointerEvents:'auto' }}>
          <IconButton label="Play" onClick={() => { const st = useEditorStore.getState(); st.play(); st.addLog({ level:'info', message:'Local Play' }) }}>▶</IconButton>
          <IconButton label="Pause" onClick={() => { const st = useEditorStore.getState(); st.pause(); st.addLog({ level:'info', message:'Local Pause' }) }}>⏸</IconButton>
          <IconButton label="Stop" onClick={() => { stop(); const st = useEditorStore.getState(); st.addLog({ level:'info', message:'Local Stop' }) }}>■</IconButton>
        </div>
      </div>
      <input type="range" min={0} max={duration} step={0.01} value={time} onChange={onChange} style={{ width: '100%' }} />
      <div
        ref={containerRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={(e)=>{ if (e.target === containerRef.current) setSelectedClip(null) }}
        style={{
          position:'relative',
          backgroundColor:'#0f1115',
          backgroundImage:
            'repeating-linear-gradient(-45deg, rgba(120,140,180,0.07) 0, rgba(120,140,180,0.07) 1px, transparent 1px, transparent 12px)',
          border:'1px solid #232636',
          borderRadius:4,
          marginTop:8,
          padding:'8px 0',
          outline: isDragOver ? '1px dashed #5a78ff' : 'none'
        }}>
        {tracks.filter(t => t.media).map((t, i) => {
          const m = t.media
          const left = (100 * (m.start_at_seconds || 0) / Math.max(0.0001, duration))
          const width = (100 * Math.max(0, (m.out_seconds - m.in_seconds)) / Math.max(0.0001, duration))
          const clip = mediaById[m.clip_id]
          const label = clip?.name || clip?.id || m.clip_id
          const screen = nodeIndex.get(m.target_node_id)
          const trackLabel = screen?.name || screen?.id || `Track ${i + 1}`
          const isSelected = selectedClipId === m.clip_id
          return (
            <div key={i} style={{ display:'grid', gridTemplateColumns:'120px 1fr', alignItems:'center', height: 28, margin:'6px 8px', gap: 8 }}>
              <div style={{ padding:'0 8px', fontSize:12, opacity:0.8, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{trackLabel}</div>
              <div style={{ position:'relative', height:'100%' }}>
                <div onClick={(e)=>{ e.stopPropagation(); setSelectedClip(m.clip_id) }} style={{ position:'absolute', left:`${left}%`, width:`${width}%`, height:'100%', background: isSelected ? '#354066' : '#2a2f45', border:`1px solid ${isSelected ? '#6aa0ff' : '#3a4060'}`, boxShadow: isSelected ? '0 0 0 1px #6aa0ff66' : 'none', borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'hidden', cursor:'pointer' }} title={`${label} @ ${m.start_at_seconds?.toFixed?.(2)}s`}>
                  <span style={{ whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden', fontSize:12 }}>{label}</span>
                </div>
              </div>
            </div>
          )
        })}
        {/* Playhead */}
        <div style={{ position:'absolute', top:0, bottom:0, left: `${(100 * time / Math.max(0.0001, duration))}%`, width:2, background:'#ff6' }} />
        {/* Drop indicator */}
        {isDragOver && hoverTime != null && (
          <div title={`${hoverTime.toFixed(2)}s`} style={{ position:'absolute', top:0, bottom:0, left: `${(100 * hoverTime / Math.max(0.0001, duration))}%`, width:2, background:'#5a78ff' }} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7 }}>
        <span>0.0</span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
