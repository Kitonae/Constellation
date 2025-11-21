import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from './store.js'
import Viewport3D from './components/Viewport.jsx'
import DisplaysPanel from './components/DisplaysPanel.jsx'
import Viewport2D from './components/Viewport2D.jsx'
import Timeline from './components/Timeline.jsx'
import MediaBin from './components/MediaBin.jsx'
import Inspector from './components/Inspector.jsx'
import { openImageDialog } from './utils/tauriCompat.js'
import { cacheMediaFromPath, relinkProjectMediaToCache } from './utils/cacheMedia.js'
import TopConsoleDrawer from './components/TopConsoleDrawer.jsx'
import GlobalTicker from './components/GlobalTicker.jsx'
import MenuBar from './components/MenuBar.jsx'
import { openDisplayWindow, closeDisplayWindow, broadcastToDisplays } from './display/displayManager.js'
// Tauri emit is not available under Wails; keep guarded uses only.
import LoadingOverlay from './components/LoadingOverlay.jsx'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, playing, play, pause, time, selectedId, setSelected, gizmoMode, setGizmoMode, project, scene, addImageToShow, toggleConsole, addLog, viewMode, setViewMode, showOutputOverlay, toggleOutputOverlay, addScreenNode } = useEditorStore()
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
  const [timelineHeight, setTimelineHeight] = useState(200)
  const footerDragRef = useRef(null) // { startY, startH }

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

  // Open/close display windows based on enabled screens
  useEffect(() => {
    const roots = scene?.roots || []
    for (const n of roots) {
      if (n.kind?.type === 'screen') {
        const enabled = (n.kind?.enabled ?? true)
        const px = n.kind?.pixels?.[0] || 0
        const py = n.kind?.pixels?.[1] || 0
        if (enabled && px > 0 && py > 0) {
          openDisplayWindow(n.id, px, py)
        } else {
          closeDisplayWindow(n.id)
        }
      }
    }
    // Emit a snapshot once on scene change to update paused display windows
    try { broadcastToDisplays('display:snapshot', { project, scene, time }) } catch {}
  }, [scene])

  // Emit snapshot once when project changes
  useEffect(() => {
    try { broadcastToDisplays('display:snapshot', { project, scene, time }) } catch {}
  }, [project])

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const text = await f.text()
    try {
      const data = JSON.parse(text)
      // If running in Tauri, import any external media into local cache and relink
      if (window.__TAURI__ && data?.project?.media?.length) {
        try {
          const updated = await relinkProjectMediaToCache(data.project)
          if (updated !== data.project) data.project = updated
        } catch {}
      }
      loadProject(data)
    } catch (err) {
      alert('Invalid JSON: ' + err)
    }
  }

  return (
    <div className="layout">
      <header>
        <MenuBar
          onOpenProject={() => fileRef.current?.click()}
          onAddImage={onAddImage}
          onAddScreen={() => {
            // Create a default screen without prompting
            addScreenNode({ pixels: [1920, 1080] })
          }}
          onSaveShow={async () => {
            try {
              const wrapper = buildProjectWrapper(project, scene)
              if (!window.__TAURI__) { alert('Saving requires Tauri environment'); return }
              const { save } = await import('@tauri-apps/api/dialog')
              const { writeTextFile } = await import('@tauri-apps/api/fs')
              const path = await save({
                title: 'Save Show',
                defaultPath: 'show.json',
                filters: [{ name: 'JSON', extensions: ['json'] }]
              })
              if (!path) return
              await writeTextFile(path, JSON.stringify(wrapper, null, 2))
              setStatus('Saved: ' + path)
              addLog({ level: 'info', message: 'Saved show to ' + path })
            } catch (e) {
              setStatus('Save failed: ' + e)
              addLog({ level: 'error', message: 'Save failed: ' + e })
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
          onApply={async ()=>{
            try {
              const { applyProject: wApply, wailsAvailable } = await import('./utils/wailsApi.js')
              const wrapper = buildProjectWrapper(project, scene)
              const message = await wApply(addr, JSON.stringify(wrapper))
              setStatus('Applied: ' + message)
              addLog({ level:'info', message:`Applied project to ${addr}: ${message}` })
            } catch (e) {
              setStatus('Apply failed: ' + e)
              addLog({ level:'error', message:`Apply failed: ${e}` })
            }
          }}
          onRemotePlay={async ()=>{ try { const { play } = await import('./utils/wailsApi.js'); const msg = await play(addr); setStatus('Play: '+msg) } catch(e){ setStatus('Play failed: '+e) } }}
          onRemotePause={async ()=>{ try { const { pause } = await import('./utils/wailsApi.js'); const msg = await pause(addr); setStatus('Pause: '+msg) } catch(e){ setStatus('Pause failed: '+e) } }}
          onRemoteStop={async ()=>{ try { const { stop } = await import('./utils/wailsApi.js'); const msg = await stop(addr); setStatus('Stop: '+msg) } catch(e){ setStatus('Stop failed: '+e) } }}
          onReopenDisplays={async ()=>{
            const roots = scene?.roots || []
            for (const n of roots) {
              if (n.kind?.type === 'screen') {
                const enabled = (n.kind?.enabled ?? true)
                const px = n.kind?.pixels?.[0] || 0
                const py = n.kind?.pixels?.[1] || 0
                if (enabled && px > 0 && py > 0) {
                  try { await openDisplayWindow(n.id, px, py) } catch {}
                }
              }
            }
            try { broadcastToDisplays('display:snapshot', { project, scene, time }) } catch {}
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
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
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
            onPointerUp={(e) => { leftPaneDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {} }}
            style={{ position: 'absolute', top: 0, bottom: 0, right: -3, width: 6, cursor: 'col-resize', zIndex: 10 }}
            title="Drag to resize media bin"
          />
        </div>
        <div className="panel" style={{ flex: 1, minWidth: 0 }}>{viewMode === '2d' ? <Viewport2D /> : (viewMode === '3d' ? <Viewport3D /> : <DisplaysPanel />)}</div>
        <div
          ref={rightPaneRef}
          className="panel"
          style={{ width: inspectorWidth, flex: '0 0 auto', display:'flex', flexDirection:'column', minHeight:0, position:'relative', borderLeft: '1px solid #232636' }}
        >
          <div
            onPointerDown={(e) => {
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
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
            onPointerUp={(e) => { rightPaneDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {} }}
            style={{ position: 'absolute', top: 0, bottom: 0, left: -3, width: 6, cursor: 'col-resize', zIndex: 10 }}
            title="Drag to resize inspector"
          />
          <div style={{ flex:'1 1 auto', minHeight: 100, overflow:'auto' }}>
            <Inspector />
          </div>
        </div>
      </main>
      <footer className="panel" style={{ height: timelineHeight, minHeight: 80, position: 'relative', overflow: 'hidden' }}>
        {/* Drag handle at top of footer to resize timeline height */}
        <div
          onPointerDown={(e) => { try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}; footerDragRef.current = { startY: e.clientY, startH: timelineHeight } }}
          onPointerMove={(e) => {
            if (!footerDragRef.current) return
            const dy = e.clientY - footerDragRef.current.startY
            const minH = 80
            const maxH = 600
            const next = Math.max(minH, Math.min(maxH, footerDragRef.current.startH - dy))
            setTimelineHeight(next)
          }}
          onPointerUp={(e) => { footerDragRef.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {} }}
          style={{ position:'absolute', top:0, left:0, right:0, height:6, cursor:'row-resize', background:'linear-gradient(180deg, #1a1e2c, #121520)', borderBottom:'1px solid #232636', zIndex: 2 }}
          title="Drag to resize timeline"
        />
        <div style={{ position:'absolute', inset:'6px 0 0 0', overflow:'hidden' }}>
          <Timeline />
        </div>
      </footer>
      <TopConsoleDrawer />
      <LoadingOverlay />
      <GlobalTicker />
    </div>
  )
}

function buildProjectWrapper(project, scene){
  if(!project || !scene){ throw new Error('No project loaded') }
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
  try {
    // Use Tauri dialog to get a file path for the image
    const filePath = await openImageDialog()
    if (!filePath) return
    // Infer name from path
    const name = String(filePath).split(/[\\\/]/).pop()
    // Fast path under Wails/browser: skip Tauri caching entirely
    if (!window.__TAURI__) {
      useEditorStore.getState().addImageToShow({ filePath, name, duration: 10 })
      useEditorStore.getState().addLog({ level:'info', message:`Added image: ${name}` })
      return
    }
    // Tauri path: perform caching
    useEditorStore.getState().beginImport()
    let uri = null
    try { uri = await cacheMediaFromPath(String(filePath)) } catch (err) { console.warn('cache failed', err) }
    if (uri) useEditorStore.getState().addImageToShow({ uri, name, duration: 10 })
    else useEditorStore.getState().addImageToShow({ filePath, name, duration: 10 })
    useEditorStore.getState().addLog({ level:'info', message:`Added image: ${name}` })
  } catch (e) {
    console.error(e)
    useEditorStore.getState().addLog({ level:'error', message:`Failed to add image: ${e}` })
    alert('Failed to add image: ' + e)
  } finally {
    if (window.__TAURI__) {
      // Only decrement if we incremented
      try { useEditorStore.getState().endImport() } catch {}
    }
  }
}
