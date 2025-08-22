import React from 'react'
import { useEditorStore } from '../store.js'
import { openImageDialog } from '../utils/tauriCompat.js'
import MediaThumb from './MediaThumb.jsx'

export default function MediaBin() {
  const media = useEditorStore((s) => s.project?.media || [])
  const time = useEditorStore((s) => s.time)
  const addMediaClip = useEditorStore((s) => s.addMediaClip)
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)

  const onImportImage = async () => {
    try {
      const filePath = await openImageDialog()
      if (!filePath) return
      const name = String(filePath).split(/[\\\/]/).pop()
      const uri = toFileUri(String(filePath))
      addMediaClip({ name, uri, duration_seconds: 10 })
    } catch (e) {
      console.error(e)
      alert('Import failed: ' + e)
    }
  }

  return (
    <div style={{ padding: 8, color: '#c7cfdb', borderTop: '1px solid #232636' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>Media Bin</div>
        <button onClick={onImportImage} title="Import Image" aria-label="Import Image">+</button>
      </div>
      {!media.length && <div style={{ opacity: 0.7 }}>No media yet.</div>}
      <div style={{ display:'grid', gap: 6 }}>
        {media.map((m) => (
          <div
            key={m.id}
            draggable
            onDragStart={(e)=>{
              // Transfer the clip id for timeline drop
              e.dataTransfer.setData('application/x-constellation-clip-id', m.id)
              e.dataTransfer.setData('text/plain', m.id)
              e.dataTransfer.effectAllowed = 'copyMove'
            }}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 8px', background:'#0f1115', border:'1px solid #232636', borderRadius:4, cursor:'grab' }}>
            <MediaThumb uri={m.uri} alt={m.name || m.id} size={48} />
            <div style={{ flex: 1, overflow:'hidden', textOverflow:'ellipsis' }} title={m.uri}>
              <div style={{ fontWeight:600, whiteSpace:'nowrap' }}>{m.name || m.id}</div>
              <div style={{ fontSize:12, opacity:0.7 }}>{m.duration_seconds?.toFixed?.(2) ?? m.duration_seconds}s</div>
            </div>
            <button onClick={() => addClipToTimeline({ clipId: m.id, startAt: time })}>Insert at {time.toFixed(2)}s</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function toFileUri(p) {
  let norm = p.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(norm)) return `file:///${norm}`
  if (norm.startsWith('/')) return `file://${norm}`
  return `file://${norm}`
}
