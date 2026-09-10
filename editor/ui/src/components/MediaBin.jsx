import React from 'react'
import { useEditorStore } from '../store.js'
import { openMediaFiles, openMediaFolder } from '../utils/fileDialogs.js'
import { importEntries } from '../utils/importMedia.js'
import MediaThumb from './MediaThumb.jsx'
import { isModelName } from '../media/index.js'

// Reads the playhead only when clicked. Subscribing to `time` here made every
// row in the bin re-render at the clock rate just to keep a tooltip current.
function AddClipButton({ clipId }) {
  return (
    <button
      onClick={() => {
        const st = useEditorStore.getState()
        const id = st.addClipToTimeline({ clipId, startAt: st.time })
        if (id) st.setSelectedClip(id)
      }}
      title="Insert at playhead"
      aria-label="Insert at playhead"
      style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}
    >
      +
    </button>
  )
}

export default React.memo(function MediaBin() {
  const media = useEditorStore((s) => s.project?.media || [])
  const removeMediaClip = useEditorStore((s) => s.removeMediaClip)
  const addModelNode = useEditorStore((s) => s.addModelNode)
  const [menu, setMenu] = React.useState({ open: false, x: 0, y: 0, clipId: null })

  const onImportFiles = async () => {
    await importEntries(await openMediaFiles())
  }

  const onImportFolder = async () => {
    await importEntries(await openMediaFolder())
  }

  React.useEffect(() => {
    if (!menu.open) return
    const close = () => setMenu(m => ({ ...m, open: false }))
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu.open])

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
        <button
          onClick={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ open: true, x: rect.left, y: rect.bottom + 4, clipId: null })
          }}
          title="Add New"
          aria-label="Add New"
          style={{ position: 'relative' }}
        >
          Add New
        </button>
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
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: '#0f1115', border: '1px solid #232636', borderRadius: 4, cursor: 'grab', minWidth: 0 }}>
            <MediaThumb uri={m.uri} alt={m.name || m.id} size={48} />
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} title={m.uri}>
              <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || m.id}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{m.duration_seconds?.toFixed?.(2) ?? m.duration_seconds}s</div>
            </div>
            <AddClipButton clipId={m.id} />
          </div>
        ))}
      </div>
      {menu.open && (
        <div style={{ position: 'fixed', left: menu.x, top: menu.y, background: '#0f1115', border: '1px solid #232636', borderRadius: 4, zIndex: 2000, minWidth: 160, boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <MenuItem label="Add Files…" onClick={() => { setMenu({ open: false, x: 0, y: 0, clipId: null }); onImportFiles() }} />
          <MenuItem label="Add Folder…" onClick={() => { setMenu({ open: false, x: 0, y: 0, clipId: null }); onImportFolder() }} />
          {menu.clipId && isModelClip(menu.clipId, media) && (
            <MenuItem label="Add to Scene" onClick={() => {
              const clip = media.find(m => m.id === menu.clipId)
              if (clip) addModelNode({ name: clip.name, uri: clip.uri })
              setMenu({ open: false, x: 0, y: 0, clipId: null })
            }} />
          )}
          {menu.clipId && <MenuItem label="Remove" onClick={() => { removeMediaClip(menu.clipId); setMenu({ open: false, x: 0, y: 0, clipId: null }) }} />}
        </div>
      )}
    </div>
  )
})


function isModelClip(clipId, media) {
  const clip = media.find(m => m.id === clipId)
  if (!clip) return false
  return isModelName(clip.name || clip.uri || '')
}

function MenuItem({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#c7cfdb', border: 'none', padding: '8px 12px', cursor: 'pointer' }} onMouseDown={(e) => e.preventDefault()}>
      {label}
    </button>
  )
}
