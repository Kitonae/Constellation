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
import StatusBar from './components/StatusBar.jsx'
import Splitter from './components/Splitter.jsx'
import ShortcutsOverlay from './components/ShortcutsOverlay.jsx'
import ConfirmHost from './components/ConfirmDialog.jsx'
import { openDisplayWindow, closeDisplayWindow } from './display/displayManager.js'
import { createDisplaySink, createNativeSink } from './media/sink.js'
import LoadingOverlay from './components/LoadingOverlay.jsx'
import SaveShowDialog from './components/SaveShowDialog.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { buildProjectWrapper } from './utils/projectSerialize.js'
import { useShortcuts } from './hooks/useShortcuts.js'
import useRendererStatusPoll from './hooks/useRendererStatusPoll.js'
import useWindowTitle from './hooks/useWindowTitle.js'
import { viewportActions } from './viewportActions.js'
import { importPaths, importFiles } from './utils/importMedia.js'
import { buildBindings } from './shortcuts.js'
import { selectSelectionSummary, selectDirty, clipInstancesOf, findAsset } from './selectors.js'
import { timelineExtent } from './utils/clipTime.js'
import { loadLayout, clampLayout, startLayoutPersistence, layoutBounds } from './layout/persistLayout.js'

/** Sink id for a web display window, so open/close can address it. */
const sinkIdFor = (screenId) => `screen-${screenId}`

/**
 * The Go bridge fans PushTime/PushSnapshot out to every connected renderer
 * itself, so all renderer screens share one sink. Registering one per screen
 * would push the same time and the same project JSON N times per tick.
 */
const NATIVE_SINK_ID = 'native-renderers'

/** Playhead step for the `,` / `.` keys, and the Shift-modified version. */
const STEP_SMALL = 0.1
const STEP_LARGE = 1.0

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
  const layout = useEditorStore((s) => s.layout)
  const setLayout = useEditorStore((s) => s.setLayout)
  const toggleLayoutPanel = useEditorStore((s) => s.toggleLayoutPanel)
  const outputsEnabled = useEditorStore((s) => s.outputsEnabled)
  const screenReopenRequest = useEditorStore((s) => s.screenReopenRequest)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  // Bumped by "Reopen Displays" to force the screen effect to rebuild every
  // output even though the scene itself has not changed.
  const [reopenNonce, setReopenNonce] = useState(0)

  useWindowTitle()
  useRendererStatusPoll()

  // Initialize default project on startup
  useEffect(() => {
    if (!useEditorStore.getState().project) {
      useEditorStore.getState().newProject()
    }
  }, [])

  // --- Panel layout -------------------------------------------------------

  // Restore the saved sizes once, then keep mirroring changes back out.
  useEffect(() => {
    const restored = loadLayout(useEditorStore.getState().layout)
    useEditorStore.getState().setLayout(restored)
    return startLayoutPersistence()
  }, [])

  // A shrunk window must not leave a pane wider than the window itself.
  useEffect(() => {
    const onResize = () => {
      const st = useEditorStore.getState()
      const next = clampLayout(st.layout)
      if (next.mediaWidth !== st.layout.mediaWidth
        || next.inspectorWidth !== st.layout.inspectorWidth
        || next.timelineHeight !== st.layout.timelineHeight) {
        st.setLayout(next)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const bounds = layoutBounds()

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

  // --- Document actions ---------------------------------------------------

  const requestNewShow = useCallback(async () => {
    const st = useEditorStore.getState()
    if (selectDirty(st)) {
      const ok = await st.askConfirm({
        title: 'New Show',
        message: 'Discard unsaved changes and start a new show?',
        confirmLabel: 'Discard',
        danger: true,
      })
      if (!ok) return
    }
    useEditorStore.getState().newProject()
    useEditorStore.getState().setDocumentName('')
    useEditorStore.getState().setStatus('New show created')
  }, [])

  const requestQuit = useCallback(async () => {
    const st = useEditorStore.getState()
    if (selectDirty(st)) {
      const ok = await st.askConfirm({
        title: 'Quit',
        message: 'You have unsaved changes. Quit anyway?',
        confirmLabel: 'Quit',
        danger: true,
      })
      if (!ok) return
    }
    try { window.runtime?.Quit?.() } catch { }
    try { window.close() } catch { }
  }, [])

  /**
   * Delete whatever is selected.
   *
   * The old handler removed one screen node or one clip, so a five-clip
   * marquee deleted exactly one of them and a selected media asset could not
   * be deleted by keyboard at all.
   */
  const deleteSelection = useCallback(async () => {
    const st = useEditorStore.getState()
    const sel = selectSelectionSummary(st)
    if (sel.kind === 'node') {
      st.removeScreenNode(sel.ids[0])
      return
    }
    if (sel.kind === 'clips') {
      if (sel.count > 1) {
        const ok = await st.askConfirm({
          title: 'Delete Clips',
          message: `Remove ${sel.count} clips from the timeline?`,
          confirmLabel: 'Delete',
          danger: true,
        })
        if (!ok) return
      }
      useEditorStore.getState().removeClips(sel.ids)
      return
    }
    if (sel.kind === 'media') {
      const id = sel.ids[0]
      const uses = clipInstancesOf(st.project, id).length
      const asset = findAsset(st.project, id)
      const ok = await st.askConfirm({
        title: 'Remove Media',
        message: uses
          ? `Remove "${asset?.name || id}"?\n${uses} timeline clip${uses === 1 ? '' : 's'} using it will also be removed.`
          : `Remove "${asset?.name || id}" from the media bin?`,
        confirmLabel: 'Remove',
        danger: true,
      })
      if (!ok) return
      useEditorStore.getState().removeMediaClip(id)
    }
  }, [])

  // The Edit menu asks for a delete through an event so it does not need the
  // async handler threaded down into it.
  useEffect(() => {
    const onDelete = () => { deleteSelection() }
    window.addEventListener('editor:delete-selection', onDelete)
    return () => window.removeEventListener('editor:delete-selection', onDelete)
  }, [deleteSelection])

  // --- Keyboard -----------------------------------------------------------

  // One shortcut layer for the whole app, built from the shared table in
  // shortcuts.js so the menus, the Help overlay and the status-bar hints all
  // describe exactly what is bound here. Every binding is skipped while a
  // text field has focus.
  const shortcuts = useMemo(() => buildBindings({
    newShow: requestNewShow,
    openShow: () => fileRef.current?.click(),
    saveShow: () => setShowSaveDialog(true),

    undo: () => useEditorStore.getState().undo(),
    redo: () => useEditorStore.getState().redo(),
    delete: () => { deleteSelection() },
    selectAllClips: () => useEditorStore.getState().selectAllClips(),
    deselect: () => useEditorStore.getState().clearSelection(),
    duplicate: () => {
      const st = useEditorStore.getState()
      if (st.selectedClipIds.length) st.duplicateClips(st.selectedClipIds)
    },
    splitClip: () => {
      const st = useEditorStore.getState()
      const id = st.selectedClipId
      if (!id) return
      const t = getMediaSession().getTime()
      const newId = st.splitClipAtTime(id, t)
      if (!newId) st.setStatus('Playhead is not over the selected clip', 'warn')
    },

    playPause: () => {
      const st = useEditorStore.getState()
      if (st.playing) st.pause(); else st.play()
    },
    goToStart: () => useEditorStore.getState().seek(0),
    goToEnd: () => useEditorStore.getState().seek(timelineExtent(useEditorStore.getState().project)),
    stepBack: (e) => {
      const t = getMediaSession().getTime()
      useEditorStore.getState().seek(Math.max(0, t - (e.shiftKey ? STEP_LARGE : STEP_SMALL)))
    },
    stepForward: (e) => {
      const t = getMediaSession().getTime()
      useEditorStore.getState().seek(t + (e.shiftKey ? STEP_LARGE : STEP_SMALL))
    },

    nudgeLeft: (e) => nudgeSelectedClips(-(e.shiftKey ? STEP_LARGE : STEP_SMALL)),
    nudgeRight: (e) => nudgeSelectedClips(e.shiftKey ? STEP_LARGE : STEP_SMALL),

    frameAll: () => viewportActions.frameAll?.(),
    frameSelected: () => viewportActions.frameSelected?.(),
    zoom100: () => viewportActions.zoomTo100?.(),

    toggleConsole: () => useEditorStore.getState().toggleConsole(),
    shortcutsHelp: () => useEditorStore.getState().toggleShortcutsHelp(),
  }), [requestNewShow, deleteSelection])
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
    const store = useEditorStore.getState()
    const prev = prevScreensRef.current
    const next = new Map()
    // "Close All Displays" holds every output shut until it is turned back
    // on, including across later scene edits.
    const screens = outputsEnabled ? (scene?.roots || []).filter((n) => n.kind?.type === 'screen') : []

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
      useEditorStore.getState().clearOutputStatus(id)
    }

    const openScreen = async (n) => {
      const k = n.kind || {}
      const px = k.pixels?.[0] | 0
      const py = k.pixels?.[1] | 0
      if (!(k.enabled ?? true) || px <= 0 || py <= 0) return
      const isRenderer = k.screenType === 'renderer'
      store.setOutputStatus(n.id, {
        type: isRenderer ? 'renderer' : 'web',
        name: n.name || n.id,
        state: 'launching',
      })
      if (isRenderer) {
        try {
          await window.go?.main?.App?.OpenRendererScreen(n.id, px, py)
        } catch (e) {
          console.error('Failed to open renderer screen:', e)
          useEditorStore.getState().setOutputStatus(n.id, { state: 'error', error: String(e) })
          useEditorStore.getState().addLog({ level: 'error', message: `Renderer launch failed for "${n.name || n.id}": ${e}` })
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
        if (!win) {
          // A blocked popup used to be a silent `return`: the output simply
          // never appeared and nothing anywhere said why.
          useEditorStore.getState().setOutputStatus(n.id, { state: 'blocked' })
          useEditorStore.getState().addLog({
            level: 'error',
            message: `Display window for "${n.name || n.id}" was blocked. Allow pop-ups for this app, then use Displays > Re-open Displays.`,
          })
          return
        }
        useEditorStore.getState().setOutputStatus(n.id, { state: 'open' })
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
  }, [scene, reopenNonce, outputsEnabled])

  // The Inspector's Relaunch button asks for one screen to be rebuilt. The Go
  // backend owns the process lifecycle; forgetting the screen here makes the
  // effect above run its normal close-then-open path for it.
  useEffect(() => {
    if (!screenReopenRequest?.id) return
    prevScreensRef.current.delete(screenReopenRequest.id)
    setReopenNonce((n) => n + 1)
    useEditorStore.setState({ screenReopenRequest: null })
  }, [screenReopenRequest])

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
    const text = await f.text()
    try {
      useEditorStore.getState().loadProject(JSON.parse(text))
      useEditorStore.getState().setDocumentName(f.name)
      useEditorStore.getState().setStatus(`Opened ${f.name}`)
    } catch (err) {
      useEditorStore.getState().addLog({ level: 'error', message: `Invalid project JSON: ${err}` })
    }
    // Let the same file be picked again after a failed parse.
    e.target.value = ''
  }

  const viewport = viewMode === '2d' ? <Viewport2D /> : (viewMode === '3d' ? <Viewport3D /> : <DisplaysPanel />)

  return (
    <div className="layout">
      <header>
        <MenuBar
          onNewShow={requestNewShow}
          onOpenProject={() => fileRef.current?.click()}
          onSaveShow={() => setShowSaveDialog(true)}
          onQuit={requestQuit}
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
        {layout.mediaCollapsed ? (
          <CollapsedRail title="Media Bin" icon="right_panel_open" onExpand={() => toggleLayoutPanel('media')} />
        ) : (
          <>
            <div className="panel" style={{ width: layout.mediaWidth, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <ErrorBoundary><MediaBin /></ErrorBoundary>
            </div>
            <Splitter
              orientation="vertical"
              label="Resize media bin"
              value={layout.mediaWidth}
              min={bounds.mediaWidth.min}
              max={bounds.mediaWidth.max}
              onChange={(v) => setLayout({ mediaWidth: v })}
              onDoubleClick={() => toggleLayoutPanel('media')}
            />
          </>
        )}

        <div className="panel" style={{ flex: 1, minWidth: 0 }}>
          <ErrorBoundary>{viewport}</ErrorBoundary>
        </div>

        {layout.inspectorCollapsed ? (
          <CollapsedRail title="Inspector" icon="left_panel_open" onExpand={() => toggleLayoutPanel('inspector')} />
        ) : (
          <>
            <Splitter
              orientation="vertical"
              label="Resize inspector"
              value={layout.inspectorWidth}
              min={bounds.inspectorWidth.min}
              max={bounds.inspectorWidth.max}
              invert
              onChange={(v) => setLayout({ inspectorWidth: v })}
              onDoubleClick={() => toggleLayoutPanel('inspector')}
            />
            {/* One scroll container, owned by the Inspector itself, so its
                tab bar stays put instead of scrolling with the content. */}
            <div className="panel" style={{ width: layout.inspectorWidth, flex: '0 0 auto', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
              <ErrorBoundary><Inspector /></ErrorBoundary>
            </div>
          </>
        )}
      </main>

      {/* The footer's own height is the timeline's height: the global
          `footer { padding: 12px }` used to make the real strip 26px taller
          than the number the splitter was clamping. */}
      <footer style={{ height: layout.timelineCollapsed ? 26 : layout.timelineHeight, minHeight: 0 }}>
        {layout.timelineCollapsed ? (
          <button
            type="button"
            className="panel__rail panel__rail--horizontal"
            aria-label="Show Timeline"
            onClick={() => toggleLayoutPanel('timeline')}
          >
            <span className="ms" aria-hidden="true">expand_less</span>
            <span className="panel__rail-title">Timeline</span>
          </button>
        ) : (
          <>
            <Splitter
              orientation="horizontal"
              label="Resize timeline"
              value={layout.timelineHeight}
              min={bounds.timelineHeight.min}
              max={bounds.timelineHeight.max}
              invert
              onChange={(v) => setLayout({ timelineHeight: v })}
              onDoubleClick={() => toggleLayoutPanel('timeline')}
            />
            <div className="panel" style={{ flex: 1, minHeight: 0 }}>
              <ErrorBoundary><Timeline /></ErrorBoundary>
            </div>
          </>
        )}
      </footer>

      <StatusBar />

      <TopConsoleDrawer />
      <LoadingOverlay />
      <ShortcutsOverlay />
      <ConfirmHost />
      <SaveShowDialog
        open={showSaveDialog}
        onClose={() => setShowSaveDialog(false)}
        defaultName={project?.name || 'show'}
        onSave={(name) => {
          const st = useEditorStore.getState()
          try {
            const wrapper = buildProjectWrapper(st.project, st.scene)
            if (wrapper.project) wrapper.project.name = name

            const blob = new Blob([JSON.stringify(wrapper, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = name + '.json'
            a.click()
            URL.revokeObjectURL(url)
            st.setDocumentName(name + '.json')
            st.markClean()
            st.setStatus(`Saved ${name}.json`)
            st.addLog({ level: 'info', message: 'Show saved as ' + name })
          } catch (e) {
            st.addLog({ level: 'error', message: 'Save failed: ' + e })
          }
        }}
      />
    </div>
  )
}

/**
 * A collapsed side panel: a rail that clicks back open.
 *
 * The whole rail is one button. Nesting a second clickable control inside a
 * clickable wrapper fired both handlers, so expanding instantly collapsed
 * again.
 */
function CollapsedRail({ title, icon, onExpand }) {
  return (
    <button
      type="button"
      className="panel__rail"
      title={`Show ${title}`}
      aria-label={`Show ${title}`}
      onClick={onExpand}
    >
      <span className="ms" aria-hidden="true">{icon}</span>
      <span className="panel__rail-title">{title}</span>
    </button>
  )
}

/**
 * Shift every selected clip in time, as one undo entry.
 *
 * The whole selection is clamped by its earliest clip so a group nudged
 * against zero keeps its internal spacing instead of collapsing.
 */
function nudgeSelectedClips(delta) {
  const st = useEditorStore.getState()
  const ids = st.selectedClipIds
  if (!ids?.length) return
  const items = []
  for (const t of st.project?.timeline?.tracks || []) {
    const list = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
    for (const m of list) if (ids.includes(m?.id)) items.push(m)
  }
  if (!items.length) return
  const starts = items.map((m) => Number(m.start ?? m.start_at_seconds) || 0)
  const applied = Math.max(delta, -Math.min(...starts))
  if (applied === 0) return
  st.moveClips(
    items.map((m, i) => ({ id: m.id, start: starts[i] + applied })),
    ids.length > 1 ? 'Nudge Clips' : 'Nudge Clip',
  )
}
