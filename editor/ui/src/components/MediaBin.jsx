import React from 'react'
import { useEditorStore } from '../store.js'
import { openMediaFiles, openMediaFolder } from '../utils/fileDialogs.js'
import { getVideoMetadata } from '../utils/videoUtils.js'
import { toFileUri, fileToDataUrl } from '../utils/mediaUtils.js'
import MediaThumb from './MediaThumb.jsx'

function AddClipButton({ clipId }) {
  const time = useEditorStore((s) => s.time)
  const addClipToTimeline = useEditorStore((s) => s.addClipToTimeline)

  return (
    <button
      onClick={() => addClipToTimeline({ clipId, startAt: time })}
      title={`Insert at ${time.toFixed(2)}s`}
      aria-label={`Insert at ${time.toFixed(2)} seconds`}
      style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}
    >
      +
    </button>
  )
}

export default React.memo(function MediaBin() {
  const media = useEditorStore((s) => s.project?.media || [])
  const addMediaClip = useEditorStore((s) => s.addMediaClip)
  const startImport = useEditorStore((s) => s.startImport)
  const updateImportProgress = useEditorStore((s) => s.updateImportProgress)
  const finishImport = useEditorStore((s) => s.finishImport)
  const removeMediaClip = useEditorStore((s) => s.removeMediaClip)
  const addModelNode = useEditorStore((s) => s.addModelNode)
  const [menu, setMenu] = React.useState({ open: false, x: 0, y: 0, clipId: null })

  const processEntries = async (entries) => {
    if (!entries || !entries.length) return
    startImport(entries.length)
    try {
      let i = 0
      for (const { file, path } of entries) {
        if (useEditorStore.getState().importProgress?.cancelled) break

        const name = String(path || file?.name || 'media').split(/[\\\/]/).pop()
        updateImportProgress(i, name)

        // Yield to allow UI updates
        await new Promise(r => setTimeout(r, 0))

        // Filter out non-media files if folder import picked up junk
        if (!/\.(png|jpg|jpeg|gif|bmp|webp|mp4|mov|webm|mkv|avi|m4v|mpg|mpeg|gltf|glb|obj)$/i.test(name)) {
          i++
          continue
        }

        const id = `clip-${Math.random().toString(36).slice(2, 8)}`
        let initialUri = null
        
        // Prefer path if available and absolute (Wails/Electron)
        // Check for POSIX root '/' or Windows drive 'C:\' or 'C:/'
        const isAbsolute = path && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path));

        if (isAbsolute) {
            initialUri = toFileUri(path)
        } else if (file) {
             // Fallback for web: use data URL for images, object URL for videos (not persistent)
             const isVideo = /\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)$/i.test(name)
             if (isVideo) {
                 initialUri = URL.createObjectURL(file)
             } else {
                 try {
                    initialUri = await fileToDataUrl(file)
                 } catch (err) {
                    console.warn('data URL conversion failed', err)
                    initialUri = URL.createObjectURL(file)
                 }
             }
        }
        
        if (!initialUri) {
          initialUri = toFileUri(String(path || file?.name || 'media'))
        }

        let duration = /\.(gltf|glb|obj)$/i.test(name) ? 0 : 10
        if (/\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)$/i.test(name)) {
          try {
            const meta = await getVideoMetadata(file || initialUri)
            if (meta?.duration) duration = meta.duration
          } catch (e) {
            console.warn('Failed to get video metadata', e)
          }
        }

        addMediaClip({ id, name, uri: initialUri, duration_seconds: duration })
        i++
      }
    } catch (e) {
      console.error(e)
      alert('Import failed: ' + e)
    } finally {
      finishImport()
    }
  }

  const onImportFiles = async () => {
    const entries = await openMediaFiles()
    await processEntries(entries)
  }

  const onImportFolder = async () => {
    const entries = await openMediaFolder()
    await processEntries(entries)
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
  const name = String(clip.name || clip.uri || '')
  return /\.(gltf|glb|obj)$/i.test(name)
}

function MenuItem({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#c7cfdb', border: 'none', padding: '8px 12px', cursor: 'pointer' }} onMouseDown={(e) => e.preventDefault()}>
      {label}
    </button>
  )
}
