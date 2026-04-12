import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore, getMediaSession } from './store.js'
import Viewport3D from './components/Viewport.jsx'
import DisplaysPanel from './components/DisplaysPanel.jsx'
import Viewport2D from './components/Viewport2D.jsx'
import Timeline from './components/Timeline.jsx'
import MediaBin from './components/MediaBin.jsx'
import Inspector from './components/Inspector.jsx'
import TopConsoleDrawer from './components/TopConsoleDrawer.jsx'
import GlobalTicker from './components/GlobalTicker.jsx'
import MenuBar from './components/MenuBar.jsx'
import { openDisplayWindow } from './display/displayManager.js'
import LoadingOverlay from './components/LoadingOverlay.jsx'
import SaveShowDialog from './components/SaveShowDialog.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { createProjectDocument } from './project/projectCodec.js'
import { useHotkeys } from './hooks/useHotkeys.js'
import { useScreenLifecycle } from './hooks/useScreenLifecycle.js'
import { useSnapshotSync } from './hooks/useSnapshotSync.js'
import { useGlobalMediaDrop } from './hooks/useGlobalMediaDrop.js'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, project, scene, addLog, viewMode, newProject } = useEditorStore()
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState('')
  // Resizable left pane (Media Bin)
  const [mediaWidth, setMediaWidth] = useState(() => Math.floor(window.innerWidth * 0.25))
  const leftPaneDragRef = useRef(null)
  // Resizable right pane (Inspector)
  const [inspectorWidth, setInspectorWidth] = useState(() => Math.floor(window.innerWidth * 0.25))
  const rightPaneDragRef = useRef(null)
  const rightPaneRef = useRef(null)
  // Resizable footer (timeline) height
  const [timelineHeight, setTimelineHeight] = useState(350)
  const footerDragRef = useRef(null)
  const [showSaveDialog, setShowSaveDialog] = useState(false)

  // Shell orchestration hooks
  useHotkeys()
  useScreenLifecycle()
  useSnapshotSync()
  useGlobalMediaDrop()

  // Initialize default project on startup
  useEffect(() => {
    if (!useEditorStore.getState().project) {
      newProject()
    }
  }, [])

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
            try { getMediaSession().broadcastSnapshot() } catch { }
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
