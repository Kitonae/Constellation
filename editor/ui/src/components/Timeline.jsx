import React, { useMemo, useRef, useState, useCallback } from 'react'
import { useEditorStore } from '../store.js'

export default function Timeline() {
  const { time, seek, project } = useEditorStore()
  const duration = project?.timeline?.duration_seconds ?? 60
  const tracks = project?.timeline?.tracks ?? []
  const media = project?.media ?? []
  const mediaById = useMemo(() => Object.fromEntries(media.map(m => [m.id, m])), [media])
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)
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
    }
    setDragOver(false); setHoverTime(null)
  }

  const onChange = (e) => {
    const v = parseFloat(e.target.value)
    if (!Number.isNaN(v)) seek(v)
  }

  return (
    <div style={{ padding: 8, color: '#e6e6e6' }}>
      <div style={{ marginBottom: 6 }}>Timeline (MVP)</div>
      <input type="range" min={0} max={duration} step={0.01} value={time} onChange={onChange} style={{ width: '100%' }} />
      <div
        ref={containerRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{ position:'relative', background:'#0f1115', border:'1px solid #232636', borderRadius:4, marginTop:8, padding:'8px 0', outline: isDragOver ? '1px dashed #5a78ff' : 'none' }}>
        {tracks.filter(t => t.media).map((t, i) => {
          const m = t.media
          const left = (100 * (m.start_at_seconds || 0) / Math.max(0.0001, duration))
          const width = (100 * Math.max(0, (m.out_seconds - m.in_seconds)) / Math.max(0.0001, duration))
          const clip = mediaById[m.clip_id]
          const label = clip?.name || clip?.id || m.clip_id
          return (
            <div key={i} style={{ position:'relative', height: 28, margin:'6px 8px' }}>
              <div style={{ position:'absolute', left:`${left}%`, width:`${width}%`, height:'100%', background:'#2a2f45', border:'1px solid #3a4060', borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'hidden' }} title={`${label} @ ${m.start_at_seconds?.toFixed?.(2)}s`}>
                <span style={{ whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden', fontSize:12 }}>{label}</span>
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
