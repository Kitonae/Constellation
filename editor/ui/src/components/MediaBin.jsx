import React from 'react'
import { useEditorStore } from '../store.js'
import { openMediaFiles, openMediaFolder } from '../utils/fileDialogs.js'
import { getVideoMetadata } from '../utils/videoUtils.js'
import { toFileUri, fileToDataUrl } from '../utils/mediaUtils.js'
import MediaThumb from './MediaThumb.jsx'
import { isMediaFile } from '../media/index.js'
import { extFromUri, mediaTypeFromExt } from '../media/asset.js'
import { getMediaDurationSeconds } from '../project/projectCodec.js'

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
  const [viewMode, setViewMode] = React.useState('grid') // 'grid' | 'list'

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
        if (!isMediaFile(name) && !/\.(gltf|glb|obj)$/i.test(name)) {
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
             // Fallback for web: use object URL (lightweight reference, not a full copy)
             initialUri = URL.createObjectURL(file)
        }
        
        if (!initialUri) {
          initialUri = toFileUri(String(path || file?.name || 'media'))
        }

        let duration = 10
        if (/\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)$/i.test(name)) {
          try {
            const meta = await getVideoMetadata(file || initialUri)
            if (meta?.duration) duration = meta.duration
          } catch (e) {
            console.warn('Failed to get video metadata', e)
          }
        }

        addMediaClip({ id, name, uri: initialUri, durationSeconds: duration })
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ fontWeight: 600 }}>Media Bin</div>
          <ViewToggle mode={viewMode} onChange={setViewMode} />
        </div>
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
      <div style={{ display: 'grid', gap: viewMode === 'list' ? 1 : 6 }}>
        {media.map((m) => (
          <MediaItem key={m.id} clip={m} viewMode={viewMode} setMenu={setMenu} />
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


function MediaItem({ clip, viewMode, setMenu }) {
  const m = clip
  const dragProps = {
    draggable: true,
    onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); setMenu({ open: true, x: e.clientX, y: e.clientY, clipId: m.id }) },
    onDragStart: (e) => {
      e.dataTransfer.setData('application/x-constellation-clip-id', m.id)
      e.dataTransfer.setData('text/plain', m.id)
      e.dataTransfer.effectAllowed = 'copyMove'
    },
  }

  const mediaType = getMediaType(m)

  if (viewMode === 'list') {
    return (
      <div
        {...dragProps}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', background: '#0f1115', borderBottom: '1px solid #1a1e2c', cursor: 'grab', minWidth: 0, fontSize: 12 }}
      >
        <MediaTypeIcon type={mediaType} size={14} />
        <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.uri}>
          {m.name || m.id}
        </div>
        <div style={{ opacity: 0.5, flexShrink: 0 }}>{getMediaDurationSeconds(m).toFixed(1)}s</div>
        <AddClipButton clipId={m.id} />
      </div>
    )
  }

  return (
    <div
      {...dragProps}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: '#0f1115', border: '1px solid #232636', borderRadius: 4, cursor: 'grab', minWidth: 0 }}
    >
      <MediaThumb uri={m.uri} alt={m.name || m.id} size={48} />
      <MediaTypeIcon type={mediaType} size={14} style={{ marginLeft: -6, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }} title={m.uri}>
        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || m.id}</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>{getMediaDurationSeconds(m).toFixed(2)}s</div>
      </div>
      <AddClipButton clipId={m.id} />
    </div>
  )
}

function ViewToggle({ mode, onChange }) {
  return (
    <div style={{ display: 'flex', background: '#0f1115', border: '1px solid #232636', borderRadius: 3, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => onChange('grid')}
        title="Grid view"
        style={{ width: 22, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: mode === 'grid' ? '#232636' : 'transparent', color: mode === 'grid' ? '#c7cfdb' : '#6a7894', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="0" y="0" width="5" height="5" rx="1" /><rect x="7" y="0" width="5" height="5" rx="1" /><rect x="0" y="7" width="5" height="5" rx="1" /><rect x="7" y="7" width="5" height="5" rx="1" /></svg>
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        title="List view"
        style={{ width: 22, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: mode === 'list' ? '#232636' : 'transparent', color: mode === 'list' ? '#c7cfdb' : '#6a7894', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="0" y="0" width="12" height="2.5" rx="1" /><rect x="0" y="4.75" width="12" height="2.5" rx="1" /><rect x="0" y="9.5" width="12" height="2.5" rx="1" /></svg>
      </button>
    </div>
  )
}

function getMediaType(clip) {
  const ext = extFromUri(clip?.uri || '') || extFromUri(clip?.name || '')
  if (/\.(gltf|glb|obj)$/i.test(clip?.name || clip?.uri || '')) return 'model'
  return mediaTypeFromExt(ext)
}

function MediaTypeIcon({ type, size = 14, style }) {
  const s = size
  const color = {
    image: '#6aa0ff',
    video: '#a78bfa',
    audio: '#4ade80',
    model: '#f59e0b',
    unknown: '#6a7894',
  }[type] || '#6a7894'

  const icon = {
    image: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="12" height="12" rx="1.5" />
        <circle cx="5.5" cy="5.5" r="1.25" />
        <path d="M14 11l-3-3-5 5" />
      </svg>
    ),
    video: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="3" width="10" height="10" rx="1.5" />
        <path d="M11 6l4-2v8l-4-2" />
      </svg>
    ),
    audio: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3v10" /><path d="M10 5v6" /><path d="M2 6v4" /><path d="M14 6v4" />
      </svg>
    ),
    model: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1l6 3.5v7L8 15l-6-3.5v-7z" />
        <path d="M8 1v6.5" /><path d="M8 7.5l6-3.5" /><path d="M8 7.5L2 4" />
      </svg>
    ),
    unknown: (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="12" height="12" rx="1.5" />
        <path d="M6 6.5a2 2 0 1 1 2.5 1.94V10" /><circle cx="8" cy="12" r="0.5" fill={color} />
      </svg>
    ),
  }

  return <span style={{ display: 'inline-flex', flexShrink: 0, ...style }}>{icon[type] || icon.unknown}</span>
}

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
