import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from './store.js'
import { toFileUri, fileToDataUrl } from './utils/mediaUtils.js'
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
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { createProjectDocument } from './project/projectCodec.js'
import { setFileServerBaseUrl, getVideoMetadata } from './utils/videoUtils.js'
import { setFileServerBase, isMediaFile } from './media/index.js'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, playing, play, pause, time, selectedId, setSelected, gizmoMode, setGizmoMode, project, scene, addImageToShow, toggleConsole, addLog, viewMode, setViewMode, showOutputOverlay, toggleOutputOverlay, addScreenNode, newProject, addMediaClip } = useEditorStore()
  const [fileName, setFileName] = useState('')
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
        if (!isMediaFile(name) && !/\.(gltf|glb|obj)$/i.test(name)) continue

        const id = `clip-${Math.random().toString(36).slice(2, 8)}`
        let initialUri = null

        // Check for path property (Electron/WebView2)
        const path = file.path
        const isAbsolute = path && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))

        if (isAbsolute) {
            initialUri = toFileUri(path)
        } else if (file) {
             // Fallback for web: use object URL (lightweight reference, not a full copy)
             initialUri = URL.createObjectURL(file)
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

        addMediaClip({ id, name, uri: initialUri, durationSeconds: duration })
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
          useEditorStore.setState({ _fileServerPort: port })
          setFileServerBase(`http://localhost:${port}`)
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
      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useEditorStore.getState().undo()
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        useEditorStore.getState().redo()
      }
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

  // Open/close display windows based on enabled screens
  const prevScreensRef = useRef(new Map()) // id → { screenType }
  useEffect(() => {
    const roots = scene?.roots || []
    const currentScreens = new Map()

    for (const n of roots) {
      if (n.kind?.type === 'screen') {
        const enabled = (n.kind?.enabled ?? true)
        const screenType = n.kind?.screenType || 'web'
        const px = n.kind?.pixels?.[0] || 0
        const py = n.kind?.pixels?.[1] || 0
        currentScreens.set(n.id, { screenType })
        if (enabled && px > 0 && py > 0) {
          if (screenType === 'web') {
            openDisplayWindow(n.id, px, py)
          } else if (screenType === 'renderer') {
            window.go?.main?.App?.OpenRendererScreen(n.id, px, py)
              ?.catch(e => { console.error('Failed to open renderer screen:', e); addLog({ level: 'error', message: `Renderer launch failed: ${e}` }) })
          }
        } else {
          if (screenType === 'web') {
            closeDisplayWindow(n.id)
          } else if (screenType === 'renderer') {
            window.go?.main?.App?.CloseRendererScreen(n.id)?.catch(e => console.warn('CloseRendererScreen:', e))
          }
        }
      }
    }

    // Close screens that were removed from the scene
    for (const [id, prev] of prevScreensRef.current) {
      if (!currentScreens.has(id)) {
        if (prev.screenType === 'web') {
          closeDisplayWindow(id)
        } else if (prev.screenType === 'renderer') {
          window.go?.main?.App?.CloseRendererScreen(id)?.catch(e => console.warn('CloseRendererScreen:', e))
        }
      }
    }
    prevScreensRef.current = currentScreens
    // Emit a snapshot once on scene change to update paused display windows
    try { broadcastToDisplays('display:snapshot', { project, scene, time }) } catch { }
    // Update Go-side cached snapshot so newly connecting renderers get current state
    try { if (project) window.go?.main?.App?.PushSnapshot(JSON.stringify(createProjectDocument(project, scene))) } catch { }
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
    // Push full snapshot to native renderers via Go SSE
    try {
      if (project) {
        const wrapper = createProjectDocument(project, scene)
        window.go?.main?.App?.PushSnapshot(JSON.stringify(wrapper))
      }
    } catch { }
  }, [project])

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const text = await f.text()
    try {
      const data = JSON.parse(text)
      loadProject(data)
    } catch (err) {
      alert('Invalid JSON: ' + err)
    }
  }

  return (
    <div className="layout">
      <header>
        <MenuBar
          onNewShow={() => { if (confirm('Create new show? Unsaved changes will be lost.')) newProject() }}
          onOpenProject={() => fileRef.current?.click()}
          onSaveShow={() => setShowSaveDialog(true)}
          onReopenDisplays={async () => {
            const roots = scene?.roots || []
            for (const n of roots) {
              if (n.kind?.type === 'screen') {
                const enabled = (n.kind?.enabled ?? true)
                const screenType = n.kind?.screenType || 'web'
                const px = n.kind?.pixels?.[0] || 0
                const py = n.kind?.pixels?.[1] || 0
                if (enabled && px > 0 && py > 0) {
                  if (screenType === 'web') {
                    try { await openDisplayWindow(n.id, px, py) } catch { }
                  } else if (screenType === 'renderer') {
                    try { await window.go?.main?.App?.OpenRendererScreen(n.id, px, py) } catch (e) { console.error('Reopen renderer failed:', e) }
                  }
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
        <div className="panel" style={{ flex: 1, minWidth: 0 }}><ErrorBoundary>{viewMode === '2d' ? <Viewport2D /> : (viewMode === '3d' ? <Viewport3D /> : <DisplaysPanel />)}</ErrorBoundary></div>
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
            <ErrorBoundary><Inspector /></ErrorBoundary>
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
          <ErrorBoundary><Timeline /></ErrorBoundary>
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
            const wrapper = createProjectDocument(project, scene)
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

async function onAddImage() {
  // Use the active file dialog helper to get a path for the image.
  const filePath = await openImageDialog()
  if (!filePath) return
  // Infer name from path
  const name = String(filePath).split(/[\\\/]/).pop()
  // Fast path: skip caching
  useEditorStore.getState().addImageToShow({ filePath, name, duration: 10 })
  useEditorStore.getState().addLog({ level: 'info', message: `Added image: ${name}` })
  return
}

