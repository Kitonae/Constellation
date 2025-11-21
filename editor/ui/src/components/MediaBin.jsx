import React from 'react'
import { useEditorStore } from '../store.js'
import { openMediaDialog, openMediaFile } from '../utils/fileDialogs.js'
import MediaThumb from './MediaThumb.jsx'

export default function MediaBin() {
  const media = useEditorStore((s) => s.project?.media || [])
  const time = useEditorStore((s) => s.time)
  const addMediaClip = useEditorStore((s) => s.addMediaClip)
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)
  const beginImport = useEditorStore((s) => s.beginImport)
  const endImport = useEditorStore((s) => s.endImport)
  const removeMediaClip = useEditorStore((s) => s.removeMediaClip)
  const [menu, setMenu] = React.useState({ open: false, x: 0, y: 0, clipId: null })
  // Remove local button spinner; we'll show spinner in thumbnail instead

  const onImportImage = async () => {
    let fileEntry = null
    try {
      beginImport()
      // Prefer richer file descriptor
      fileEntry = await openMediaFile()
      if (!fileEntry) return
      const { file, path } = fileEntry
      const name = String(path || file?.name || 'media').split(/[\\\/]/).pop()
      const id = `clip-${Math.random().toString(36).slice(2, 8)}`

      // If running outside Tauri (Wails/web), we cannot rely on absolute file:// paths.
      // Convert to data URL immediately.
      let initialUri = null
      if (file) {
        try {
          initialUri = await fileToDataUrl(file)
        } catch (err) {
          console.warn('data URL conversion failed', err)
        }
      }
      if (!initialUri) {
        initialUri = toFileUri(String(path || file?.name))
      }
      addMediaClip({ id, name, uri: initialUri, duration_seconds: 10 })

    } catch (e) {
      console.error(e)
      alert('Import failed: ' + e)
    } finally {
      endImport()
    }
  }

  return (
    <div
      style={{ padding: 8, color: '#c7cfdb', borderTop: '1px solid #232636' }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ open: true, x: e.clientX, y: e.clientY, clipId: null })
      }}
      onClick={() => { if (menu.open) setMenu({ open: false, x: 0, y: 0, clipId: null }) }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>Media Bin</div>
        <button onClick={onImportImage} title="Add New" aria-label="Add New" style={{ position: 'relative' }}>Add New</button>
      </div>
      {!media.length && <div style={{ opacity: 0.7 }}>No media yet.</div>}
      <div style={{ display: 'grid', gap: 6 }}>
        {media.map((m) => (
          <div
            key={m.id}
            draggable
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ open: true, x: e.clientX, y: e.clientY, clipId: m.id }) }}
            onDragStart={(e) => {
              // Transfer the clip id for timeline drop
              e.dataTransfer.setData('application/x-constellation-clip-id', m.id)
              e.dataTransfer.setData('text/plain', m.id)
              e.dataTransfer.effectAllowed = 'copyMove'
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: '#0f1115', border: '1px solid #232636', borderRadius: 4, cursor: 'grab' }}>
            <MediaThumb uri={m.uri} alt={m.name || m.id} size={48} />
            <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.uri}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m.name || m.id}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{m.duration_seconds?.toFixed?.(2) ?? m.duration_seconds}s</div>
            </div>
            <button
              onClick={() => addClipToTimeline({ clipId: m.id, startAt: time })}
              title={`Insert at ${time.toFixed(2)}s`}
              aria-label={`Insert at ${time.toFixed(2)} seconds`}
              style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}
            >
              +
            </button>
          </div>
        ))}
      </div>
      {menu.open && (
        <div style={{ position: 'fixed', left: menu.x, top: menu.y, background: '#0f1115', border: '1px solid #232636', borderRadius: 4, zIndex: 2000, minWidth: 160, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} onClick={(e) => e.stopPropagation()}>
          <MenuItem label="Add Image…" onClick={() => { setMenu({ open: false, x: 0, y: 0, clipId: null }); onImportImage() }} />
          {menu.clipId && <MenuItem label="Remove" onClick={() => { removeMediaClip(menu.clipId); setMenu({ open: false, x: 0, y: 0, clipId: null }) }} />}
        </div>
      )}
    </div>
  )
}

function toFileUri(p) {
  let norm = p.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(norm)) return `file:///${norm}`
  if (norm.startsWith('/')) return `file://${norm}`
  return `file://${norm}`
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = (e) => reject(e)
      reader.readAsDataURL(file)
    } catch (e) { reject(e) }
  })
}

function MenuItem({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#c7cfdb', border: 'none', padding: '8px 12px', cursor: 'pointer' }} onMouseDown={(e) => e.preventDefault()}>
      {label}
    </button>
  )
}
