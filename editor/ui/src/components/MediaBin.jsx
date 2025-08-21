import React from 'react'
import { useEditorStore } from '../store.js'

export default function MediaBin() {
  const media = useEditorStore((s) => s.project?.media || [])
  const time = useEditorStore((s) => s.time)
  const addMediaClip = useEditorStore((s) => s.addMediaClip)
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)

  const onImportImage = async () => {
    try {
      const dialog = window.__TAURI__?.dialog
      if (!dialog) { alert('Tauri dialog not available'); return }
      const filePath = await dialog.open({ multiple: false, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] })
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
    <div style={{ padding: 8, color: '#e6e6e6', borderTop: '1px solid #232636' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>Media Bin</div>
        <button onClick={onImportImage}>Import Image</button>
      </div>
      {!media.length && <div style={{ opacity: 0.7 }}>No media yet.</div>}
      <div style={{ display:'grid', gap: 6 }}>
        {media.map((m) => (
          <div key={m.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 8px', background:'#0f1115', border:'1px solid #232636', borderRadius:4 }}>
            <div style={{ flex: 1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={m.uri}>
              <div style={{ fontWeight:600 }}>{m.name || m.id}</div>
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

