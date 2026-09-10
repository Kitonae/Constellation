import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore, getMediaSession, serializeForNative } from './store.js'
import Viewport3D from './components/Viewport.jsx'
import DisplaysPanel from './components/DisplaysPanel.jsx'
import Viewport2D from './components/Viewport2D.jsx'
import Timeline from './components/Timeline.jsx'
import MediaBin from './components/MediaBin.jsx'
import Inspector from './components/Inspector.jsx'
import TopConsoleDrawer from './components/TopConsoleDrawer.jsx'
import MenuBar from './components/MenuBar.jsx'
import { openDisplayWindow, closeDisplayWindow } from './display/displayManager.js'
import { createDisplaySink, createNativeSink } from './media/sink.js'
import LoadingOverlay from './components/LoadingOverlay.jsx'
import SaveShowDialog from './components/SaveShowDialog.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { buildProjectWrapper } from './utils/projectSerialize.js'
import { useShortcuts } from './hooks/useShortcuts.js'
import { viewportActions } from './viewportActions.js'
import { importPaths, importFiles } from './utils/importMedia.js'

/** Sink id for a web display window, so open/close can address it. */
const sinkIdFor = (screenId) => `screen-${screenId}`

/**
 * The Go bridge fans PushTime/PushSnapshot out to every connected renderer
 * itself, so all renderer screens share one sink. Registering one per screen
 * would push the same time and the same project JSON N times per tick.
 */
const NATIVE_SINK_ID = 'native-renderers'

/**
 * Everything about a screen that requires re-opening its output window.
 * Position and rotation are deliberately absent: moving a screen on the stage
 * must not tear down (and re-focus) its display window.
 */
function screenKey(n) {
  const k = n.kind || {}
  return `${k.screenType || 'web'}|${k.enabled ?? true}|${k.pixels?.[0] | 0}|${k.pixels?.[1] | 0}`
}

export default function App() {
  const fileRef = useRef(null)
  // Narrow selectors only. Subscribing to the whole store re-rendered the
  // entire tree on every clock tick and every log line.
  const project = useEditorStore((s) => s.project)
  const scene = useEditorStore((s) => s.scene)
  const viewMode = useEditorStore((s) => s.viewMode)
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
  // Bumped by "Reopen Displays" to force the screen effect to rebuild every
  // output even though the scene itself has not changed.
  const [reopenNonce, setReopenNonce] = useState(0)

  // Initialize default project on startup
  useEffect(() => {
    if (!useEditorStore.getState().project) {
      useEditorStore.getState().newProject()
    }
  }, [])

  // --- Media import -------------------------------------------------------

  // Under Wails the WebView2 File object carries no `.path`, so an HTML drop
  // produced a blob: URI the native renderer refuses to open. Use the Wails
  // drag-and-drop runtime, which hands us absolute paths, and keep the HTML
  // handler only for plain-browser development.
  useEffect(() => {
    if (!window.runtime?.OnFileDrop) return
    window.runtime.OnFileDrop((x, y, paths) => { importPaths(paths) }, true)
    return () => { try { window.runtime.OnFileDropOff?.() } catch { } }
  }, [])

  useEffect(() => {
    if (window.runtime?.OnFileDrop) return  // native drop is active
    const onDragOver = (e) => { e.preventDefault(); e.stopPropagation() }
    const onDrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      importFiles(e.dataTransfer?.files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // --- Keyboard -----------------------------------------------------------

  // One shortcut layer for the whole app. Every binding is skipped while a
  // text field has focus, so typing a space or pressing Delete in the
  // Inspector no longer reaches these handlers.
  const shortcuts = useMemo(() => [
    {
      match: (e) => (e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey,
      run: () => useEditorStore.getState().undo(),
      allowInEditable: false,
    },
    {
      match: (e) => (e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)),
      run: () => useEditorStore.getState().redo(),
    },
    {
      match: (e) => e.code === 'Backquote' && !e.ctrlKey && !e.metaKey,
      run: () => useEditorStore.getState().toggleConsole(),
    },
    {
      match: (e) => e.key === 'Delete' || e.key === 'Backspace',
      run: () => {
        const st = useEditorStore.getState()
        // A selected screen node wins over a selected clip, matching the
        // behaviour the 2D viewport used to implement on its own.
        if (st.selectedId && findNodeById(st.scene?.roots, st.selectedId)?.kind?.type === 'screen') {
          st.removeScreenNode(st.selectedId)
        } else if (st.selectedClipId) {
          st.removeClip(st.selectedClipId)
        }
      },
    },
    {
      match: (e) => (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey,
      run: () => viewportActions.frameAll?.(),
    },
  ], [])
  useShortcuts(shortcuts)

  // --- Output screens and sinks ------------------------------------------

  // Every output (web display window or native renderer screen) is a sink on
  // the MediaSession. Registering them here is what makes the session the one
  // owner of transport fan-out; nothing else in the app pushes time or
  // snapshots any more.
  const prevScreensRef = useRef(new Map()) // screenId → screenKey
  const rendererScreens = useRef(new Set()) // open native renderer screen ids
  useEffect(() => {
    const session = getMediaSession()
    const prev = prevScreensRef.current
    const next = new Map()
    const screens = (scene?.roots || []).filter((n) => n.kind?.type === 'screen')

    const closeScreen = (id, key) => {
      const type = String(key || '').split('|')[0]
      if (type === 'renderer') {
        rendererScreens.current.delete(id)
        if (rendererScreens.current.size === 0) session.removeSink(NATIVE_SINK_ID)
        window.go?.main?.App?.CloseRendererScreen(id)?.catch((e) => console.warn('CloseRendererScreen:', e))
      } else {
        session.removeSink(sinkIdFor(id))
        closeDisplayWindow(id)
      }
    }

    const openScreen = async (n) => {
      const k = n.kind || {}
      const px = k.pixels?.[0] | 0
      const py = k.pixels?.[1] | 0
      if (!(k.enabled ?? true) || px <= 0 || py <= 0) return
      if (k.screenType === 'renderer') {
        try {
          await window.go?.main?.App?.OpenRendererScreen(n.id, px, py)
        } catch (e) {
          console.error('Failed to open renderer screen:', e)
          useEditorStore.getState().addLog({ level: 'error', message: `Renderer launch failed: ${e}` })
          return
        }
        rendererScreens.current.add(n.id)
        if (!session.getSinks().some((sk) => sk.id === NATIVE_SINK_ID)) {
          session.addSink(createNativeSink({
            id: NATIVE_SINK_ID,
            serialize: serializeForNative,
          }))
        }
      } else {
        const win = await openDisplayWindow(n.id, px, py)
        if (!win) return
        // The window may still be loading; it announces itself with
        // `display:ready` and we answer with a snapshot (see below).
        session.addSink(createDisplaySink(win, { id: sinkIdFor(n.id), screenId: n.id }))
      }
    }

    for (const n of screens) {
      const k = screenKey(n)
      next.set(n.id, k)
      if (prev.get(n.id) === k) continue      // moving a screen touches nothing
      if (prev.has(n.id)) closeScreen(n.id, prev.get(n.id))
      openScreen(n)
    }
    for (const [id, k] of prev) {
      if (!next.has(id)) closeScreen(id, k)
    }
    prevScreensRef.current = next
  }, [scene, reopenNonce])

  // A freshly opened display window tells us when its message listener is up.
  useEffect(() => {
    const onMessage = (ev) => {
      if (ev.data?.event !== 'display:ready') return
      getMediaSession().notifySnapshot()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The single snapshot trigger: the document changed. Debounced so a burst of
  // Inspector keystrokes coalesces into one serialization instead of one per
  // character.
  useEffect(() => {
    if (!project || !scene) return
    const id = setTimeout(() => { getMediaSession().notifySnapshot() }, 50)
    return () => clearTimeout(id)
  }, [project, scene])

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const text = await f.text()
    try {
      useEditorStore.getState().loadProject(JSON.parse(text))
    } catch (err) {
      useEditorStore.getState().addLog({ level: 'error', message: `Invalid project JSON: ${err}` })
      setStatus('Invalid JSON: ' + err)
    }
  }

  return (
    <div className="layout">
      <header>
        <MenuBar
          onNewShow={() => { if (confirm('Create new show? Unsaved changes will be lost.')) useEditorStore.getState().newProject() }}
          onOpenProject={() => fileRef.current?.click()}
          onSaveShow={() => setShowSaveDialog(true)}
          onReopenDisplays={() => {
            // Forget what we think is open; the screen effect then treats
            // every screen as new and re-opens it with a fresh sink.
            prevScreensRef.current = new Map()
            setReopenNonce((n) => n + 1)
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
            useEditorStore.getState().addLog({ level: 'info', message: 'Show saved as ' + name })
          } catch (e) {
            setStatus('Save failed: ' + e)
            useEditorStore.getState().addLog({ level: 'error', message: 'Save failed: ' + e })
          }
        }}
      />
    </div>
  )
}

/** Depth-first lookup used by the Delete shortcut. */
function findNodeById(roots, id) {
  const stack = [...(roots || [])]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.id === id) return n
    if (n.children?.length) stack.push(...n.children)
  }
  return null
}
