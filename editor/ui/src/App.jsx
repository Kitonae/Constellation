import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from './store.js'
import Viewport3D from './components/Viewport.jsx'
import DisplaysPanel from './components/DisplaysPanel.jsx'
import Viewport2D from './components/Viewport2D.jsx'
import Timeline from './components/Timeline.jsx'
import MediaBin from './components/MediaBin.jsx'
import Inspector from './components/Inspector.jsx'
import { openImageDialog } from './utils/fileDialogs.js'
import TopConsoleDrawer from './components/TopConsoleDrawer.jsx'
import GlobalTicker from './components/GlobalTicker.jsx'
import MenuBar from './components/MenuBar.jsx'
import { openDisplayWindow, closeDisplayWindow, broadcastToDisplays } from './display/displayManager.js'
import LoadingOverlay from './components/LoadingOverlay.jsx'
import SaveShowDialog from './components/SaveShowDialog.jsx'
import { setFileServerBaseUrl, getVideoMetadata } from './utils/videoUtils.js'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, playing, play, pause, time, selectedId, setSelected, gizmoMode, setGizmoMode, project, scene, addImageToShow, toggleConsole, addLog, viewMode, setViewMode, showOutputOverlay, toggleOutputOverlay, addScreenNode, newProject, addMediaClip } = useEditorStore()
  const [fileName, setFileName] = useState('')
  const [addr, setAddr] = useState('http://127.0.0.1:50051')
  const [status, setStatus] = useState('')
  // Resizable left pane (Media Bin)
  const [mediaWidth, setMediaWidth] = useState(() => Math.floor(window.innerWidth * 0.25))
  const leftPaneDragRef = useRef(null) // { startX, startW }
  // Resizable right pane (Inspector)
  const [inspectorWidth, setInspectorWidth] = useState(() => Math.floor(window.innerWidth * 0.25))
  const rightPaneDragRef = useRef(null) // { startX, startW }
  const rightPaneRef = useRef(null)
  // Resizable footer (timeline) height
  const [timelineHeight, setTimelineHeight] = useState(350)
  const footerDragRef = useRef(null) // { startY, startH }
  const [showSaveDialog, setShowSaveDialog] = useState(false)

  // Initialize default project on startup
  useEffect(() => {
    if (!useEditorStore.getState().project) {
      newProject()
    }
  }, [])

  // Global drag and drop handler for importing media
  useEffect(() => {
    const onDragOver = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onDrop = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer.files || [])
      if (!files.length) return

      for (const file of files) {
        const name = file.name
        // Filter for media types
        if (!/\.(png|jpg|jpeg|gif|bmp|webp|mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)$/i.test(name)) continue

        const id = `clip-${Math.random().toString(36).slice(2, 8)}`
        let initialUri = null
        
        // Check for path property (Electron/WebView2)
        const path = file.path
        const isAbsolute = path && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))

        if (isAbsolute) {
            initialUri = toFileUri(path)
        } else {
             // Fallback for web: use data URL for images, object URL for videos
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
        
        let duration = 10
        if (/\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)$/i.test(name)) {
          try {
            const meta = await getVideoMetadata(file || initialUri)
            if (meta?.duration) duration = meta.duration
          } catch (e) {
            console.warn('Failed to get video metadata', e)
          }
        }

        addMediaClip({ id, name, uri: initialUri, duration_seconds: duration })
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [addMediaClip])

  // Initialize sidecar file server for video support in dev mode
  useEffect(() => {
    if (window.go?.main?.App?.GetFileServerPort) {
      window.go.main.App.GetFileServerPort().then(port => {
        if (port > 0) {
          console.log('Using sidecar file server at port', port)
          setFileServerBaseUrl(`http://localhost:${port}`)
          useEditorStore.getState().addLog({ level: 'info', message: `Video sidecar active on port ${port}` })
        }
      }).catch(err => {
        console.warn('Failed to get file server port', err)
        useEditorStore.getState().addLog({ level: 'error', message: `Sidecar error: ${err}` })
      })
    } else {
      useEditorStore.getState().addLog({ level: 'warn', message: 'Wails API not available' })
    }
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      // Toggle console on backquote/tilde key
      if (e.code === 'Backquote') {
        const t = e.target
        // ignore when typing in inputs/textareas/contenteditable
        const tag = (t?.tagName || '').toLowerCase()
        const isEditable = t?.isContentEditable || tag === 'input' || tag === 'textarea'
        if (isEditable) return
        e.preventDefault()
        toggleConsole()
      }
      // Delete selected timeline clip with Delete key
      if (e.key === 'Delete') {
        const t = e.target
        const tag = (t?.tagName || '').toLowerCase()
        const isEditable = t?.isContentEditable || tag === 'input' || tag === 'textarea'
        if (isEditable) return
        const { selectedClipId, removeClip } = useEditorStore.getState()
        if (selectedClipId) {
          e.preventDefault()
          removeClip(selectedClipId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleConsole])

  // Open/close display windows based on enabled web screens
  useEffect(() => {
    const roots = scene?.roots || []
    for (const n of roots) {
      if (n.kind?.type === 'screen') {
        const enabled = (n.kind?.enabled ?? true)
        const isWeb = (n.kind?.screenType || 'web') === 'web'
        const px = n.kind?.pixels?.[0] || 0
        const py = n.kind?.pixels?.[1] || 0
        if (enabled && isWeb && px > 0 && py > 0) {
          openDisplayWindow(n.id, px, py)
        } else {
          closeDisplayWindow(n.id)
        }
      }
    }
    // Emit a snapshot once on scene change to update paused display windows
    try { broadcastToDisplays('display:snapshot', { project, scene, time }) } catch { }
  }, [scene])

  // Emit snapshot once when project changes
  const prevMediaRef = useRef(null)
  useEffect(() => {
    try {
      let projToSend = project
      // Optimization: if media array reference hasn't changed, don't resend it.
      // This prevents serializing/sending large data URIs on every timeline update (e.g. dragging).
      if (project && project.media === prevMediaRef.current) {
        projToSend = { ...project, media: undefined }
      }
      prevMediaRef.current = project?.media
      broadcastToDisplays('display:snapshot', { project: projToSend, scene, time })
    } catch { }
  }, [project])

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const text = await f.text()
    try {
      const data = JSON.parse(text)
      // If running in Tauri, import any external media into local cache and relink
      // (Tauri support removed)
      loadProject(data)
    } catch (err) {
      alert('Invalid JSON: ' + err)
    }
  }

  return (
    <div className="layout">
      <header>
        <MenuBar
          onNewShow={() => {
            if (confirm('Create new show? Unsaved changes will be lost.')) {
              newProject()
            }
          }}
          onOpenProject={() => fileRef.current?.click()}
          onSaveShow={() => setShowSaveDialog(true)}
          onPackageShow={() => alert('Package Show not implemented')}
          onQuit={() => {
            if (confirm('Quit?')) {
              window.close()
            }
          }}
          viewMode={viewMode}
          setViewMode={setViewMode}
          gizmoMode={gizmoMode}
          setGizmoMode={setGizmoMode}
          onDeselect={() => setSelected(null)}
          addr={addr}
          setAddr={setAddr}
          showOutputOverlay={showOutputOverlay}
          toggleOutputOverlay={toggleOutputOverlay}
          onApply={async () => {
            try {
              const { applyProject: wApply, wailsAvailable } = await import('./utils/wailsApi.js')
              const wrapper = buildProjectWrapper(project, scene)
              const message = await wApply(addr, JSON.stringify(wrapper))
              setStatus('Applied: ' + message)
              addLog({ level: 'info', message: `Applied project to ${addr}: ${message}` })
            } catch (e) {
              setStatus('Apply failed: ' + e)
              addLog({ level: 'error', message: `Apply failed: ${e}` })
            }
          }}
          onRemotePlay={async () => { try { const { play } = await import('./utils/wailsApi.js'); const msg = await play(addr); setStatus('Play: ' + msg) } catch (e) { setStatus('Play failed: ' + e) } }}
          onRemotePause={async () => { try { const { pause } = await import('./utils/wailsApi.js'); const msg = await pause(addr); setStatus('Pause: ' + msg) } catch (e) { setStatus('Pause failed: ' + e) } }}
          onRemoteStop={async () => { try { const { stop } = await import('./utils/wailsApi.js'); const msg = await stop(addr); setStatus('Stop: ' + msg) } catch (e) { setStatus('Stop failed: ' + e) } }}
          onReopenDisplays={async () => {
            const roots = scene?.roots || []
            for (const n of roots) {
              if (n.kind?.type === 'screen') {
                const enabled = (n.kind?.enabled ?? true)
                const isWeb = (n.kind?.screenType || 'web') === 'web'
                const px = n.kind?.pixels?.[0] || 0
                const py = n.kind?.pixels?.[1] || 0
                if (enabled && isWeb && px > 0 && py > 0) {
                  try { await openDisplayWindow(n.id, px, py) } catch { }
                }
              }
            }
            try { broadcastToDisplays('display:snapshot', { project, scene, time }) } catch { }
          }}
        />
        <input type="file" accept="application/json" onChange={onFile} ref={fileRef} style={{ display: 'none' }} />
      </header>
      <main>
        <div className="panel" style={{ width: mediaWidth, flex: '0 0 auto', display: 'flex', flexDirection: 'column', position: 'relative', borderRight: '1px solid #232636' }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <MediaBin />
          </div>
          <div
            onPointerDown={(e) => {
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
              leftPaneDragRef.current = { startX: e.clientX, startW: mediaWidth }
              e.preventDefault()
            }}
            onPointerMove={(e) => {
              if (!leftPaneDragRef.current) return
              const dx = e.clientX - leftPaneDragRef.current.startX
              const minW = 150
              const maxW = window.innerWidth * 0.45
              const next = Math.max(minW, Math.min(maxW, leftPaneDragRef.current.startW + dx))
              setMediaWidth(next)
              e.preventDefault()
            }}
            onPointerUp={(e) => { leftPaneDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { } }}
            style={{ position: 'absolute', top: 0, bottom: 0, right: -3, width: 6, cursor: 'col-resize', zIndex: 10 }}
            title="Drag to resize media bin"
          />
        </div>
        <div className="panel" style={{ flex: 1, minWidth: 0 }}>{viewMode === '2d' ? <Viewport2D /> : (viewMode === '3d' ? <Viewport3D /> : <DisplaysPanel />)}</div>
        <div
          ref={rightPaneRef}
          className="panel"
          style={{ width: inspectorWidth, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', borderLeft: '1px solid #232636' }}
        >
          <div
            onPointerDown={(e) => {
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
              rightPaneDragRef.current = { startX: e.clientX, startW: inspectorWidth }
              e.preventDefault()
            }}
            onPointerMove={(e) => {
              if (!rightPaneDragRef.current) return
              const dx = e.clientX - rightPaneDragRef.current.startX
              const minW = 200
              const maxW = window.innerWidth * 0.45
              // Dragging left increases width
              const next = Math.max(minW, Math.min(maxW, rightPaneDragRef.current.startW - dx))
              setInspectorWidth(next)
              e.preventDefault()
            }}
            onPointerUp={(e) => { rightPaneDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { } }}
            style={{ position: 'absolute', top: 0, bottom: 0, left: -3, width: 6, cursor: 'col-resize', zIndex: 10 }}
            title="Drag to resize inspector"
          />
          <div style={{ flex: '1 1 auto', minHeight: 100, overflow: 'auto' }}>
            <Inspector />
          </div>
        </div>
      </main>
      <footer className="panel" style={{ height: timelineHeight, minHeight: 80, position: 'relative', overflow: 'hidden' }}>
        {/* Drag handle at top of footer to resize timeline height */}
        <div
          onPointerDown={(e) => { try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }; footerDragRef.current = { startY: e.clientY, startH: timelineHeight } }}
          onPointerMove={(e) => {
            if (!footerDragRef.current) return
            const dy = e.clientY - footerDragRef.current.startY
            const minH = 80
            const maxH = 600
            const next = Math.max(minH, Math.min(maxH, footerDragRef.current.startH - dy))
            setTimelineHeight(next)
          }}
          onPointerUp={(e) => { footerDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { } }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 6, cursor: 'row-resize', background: 'linear-gradient(180deg, #1a1e2c, #121520)', borderBottom: '1px solid #232636', zIndex: 2 }}
          title="Drag to resize timeline"
        />
        <div style={{ position: 'absolute', inset: '6px 0 0 0', overflow: 'hidden' }}>
          <Timeline />
        </div>
      </footer>
      <TopConsoleDrawer />
      <LoadingOverlay />
      <GlobalTicker />
      <SaveShowDialog
        open={showSaveDialog}
        onClose={() => setShowSaveDialog(false)}
        defaultName={project?.name || 'show'}
        onSave={(name) => {
          try {
            const wrapper = buildProjectWrapper(project, scene)
            // Update project name in wrapper if needed, or just use filename
            if (wrapper.project) wrapper.project.name = name

            const blob = new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = name + '.json'
            a.click()
            URL.revokeObjectURL(url)
            setStatus('Show saved as ' + name)
            addLog({ level: 'info', message: 'Show saved as ' + name })
          } catch (e) {
            setStatus('Save failed: ' + e)
            addLog({ level: 'error', message: 'Save failed: ' + e })
          }
        }}
      />
    </div>
  )
}

function buildProjectWrapper(project, scene) {
  if (!project || !scene) { throw new Error('No project loaded') }
  // Reconstruct a JSON payload similar to examples/scene.example.json
  return {
    project: {
      id: project.id,
      name: project.name,
      scene: scene,
      media: project.media ?? [],
      timeline: project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: 60 }
    }
  }
}

async function onAddImage() {
  // Use Tauri dialog to get a file path for the image
  const filePath = await openImageDialog()
  if (!filePath) return
  // Infer name from path
  const name = String(filePath).split(/[\\\/]/).pop()
  // Fast path: skip caching
  useEditorStore.getState().addImageToShow({ filePath, name, duration: 10 })
  useEditorStore.getState().addLog({ level: 'info', message: `Added image: ${name}` })
  return
}

function toFileUri(p) {
  let norm = p.replace(/\\/g, '/')
  // Encode path parts to handle spaces and special characters
  const parts = norm.split('/')
  const encodedParts = parts.map(part => encodeURIComponent(part))
  norm = encodedParts.join('/')
  
  // Restore drive letter colon if it was encoded
  norm = norm.replace(/^([a-zA-Z])%3A/, '$1:')

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
