import React, { useMemo } from 'react'
import { useEditorStore } from '../store.js'

export default function Timeline() {
  const { time, seek, project } = useEditorStore()
  const duration = project?.timeline?.duration_seconds ?? 60
  const tracks = project?.timeline?.tracks ?? []
  const media = project?.media ?? []
  const mediaById = useMemo(() => Object.fromEntries(media.map(m => [m.id, m])), [media])

  const onChange = (e) => {
    const v = parseFloat(e.target.value)
    if (!Number.isNaN(v)) seek(v)
  }

  return (
    <div style={{ padding: 8, color: '#e6e6e6' }}>
      <div style={{ marginBottom: 6 }}>Timeline (MVP)</div>
      <input type="range" min={0} max={duration} step={0.01} value={time} onChange={onChange} style={{ width: '100%' }} />
      <div style={{ position:'relative', background:'#0f1115', border:'1px solid #232636', borderRadius:4, marginTop:8, padding:'8px 0' }}>
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
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7 }}>
        <span>0.0</span>
        <span>{duration.toFixed(2)}s</span>
      </div>
    </div>
  )
}
