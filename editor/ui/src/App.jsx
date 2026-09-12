import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore, getMediaSession, getDocumentSync } from './store.js'
import Viewport3D from './components/Viewport.jsx'
import OutputPanel from './components/OutputPanel.jsx'
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
import SettingsDialog from './components/SettingsDialog.jsx'
import { openDisplayWindow, closeDisplayWindow, closeAllDisplayWindows } from './display/displayManager.js'
import { createDisplaySink } from './media/sink.js'
import LoadingOverlay from './components/LoadingOverlay.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { useShortcuts } from './hooks/useShortcuts.js'
import useRendererStatusPoll from './hooks/useRendererStatusPoll.js'
import useWindowTitle from './hooks/useWindowTitle.js'
import { viewportActions } from './viewportActions.js'
import { importPaths, importFiles } from './utils/importMedia.js'
import { buildBindings } from './shortcuts.js'
import { selectSelectionSummary, selectDirty, clipInstancesOf, findAsset } from './selectors.js'
import { timelineExtent } from './utils/clipTime.js'
import { loadLayout, clampLayout, startLayoutPersistence, layoutBounds } from './layout/persistLayout.js'
import { Application, Events } from '@wailsio/runtime'
import { CloseAllRendererScreens, CloseRendererScreen, OpenRendererScreen, OpenRendererScreenAt, QuitConfirmed } from '@bindings/app.js'
import { outputKeyPart } from './output/placement.js'
import { isWails } from './wails/env.js'

// Must match FilesDroppedEvent and CloseRequestedEvent in editor/wails/main.go.
const FILES_DROPPED_EVENT = 'media:filesDropped'
const CLOSE_REQUESTED_EVENT = 'app:closeRequested'

/** Sink id for a web display window, so open/close can address it. */
const sinkIdFor = (screenId) => `screen-${screenId}`

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
  return `${k.screenType || 'web'}|${k.enabled ?? true}|${k.pixels?.[0] | 0}|${k.pixels?.[1] | 0}|${outputKeyPart(k)}`
}

export default function App() {
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
  // Bumped by "Reopen Displays" to force the screen effect to rebuild every
  // output even though the scene itself has not changed.
  const [reopenNonce, setReopenNonce] = useState(0)

  useWindowTitle()
  useRendererStatusPoll()

  // Adopt whatever the shell already holds: the open document, the transport
  // and the recent-files list. A reloaded editor rejoins a show that is
  // already running instead of presenting an empty project at zero.
  useEffect(() => {
    const sync = getDocumentSync()
    if (!sync.native) {
      if (!useEditorStore.getState().project) useEditorStore.getState().newProject()
      return
    }
    let cancelled = false
    Promise.all([sync.contents(), sync.state(), sync.recent()])
      .then(([contents, state, recent]) => {
        if (cancelled) return
        const st = useEditorStore.getState()
        let loaded = false
        if (contents) {
          try {
            st.loadProject(JSON.parse(contents))
            loaded = true
          } catch (err) {
            st.addLog({ level: 'error', message: `Could not read the open show: ${err}` })
          }
        }
        // Never leave the editor with no document: every panel reads one, and
        // a blank shell gives the operator nothing to act on.
        if (!loaded) useEditorStore.getState().newProject()
        // Adopting what the shell already had is not an edit, so the next
        // scheduled update must not re-send it as one.
        sync.invalidate()
        useEditorStore.getState().setDocumentState(state)
        useEditorStore.getState().setRecentShows(recent)
        getMediaSession().sync()
      })
      .catch((err) => {
        useEditorStore.getState().addLog({ level: 'error', message: `Could not reach the shell: ${err}` })
        if (!useEditorStore.getState().project) useEditorStore.getState().newProject()
      })
    return () => { cancelled = true }
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
  // produced a blob: URI the native renderer refuses to open. The native drag
  // and drop path hands us absolute paths instead, and the HTML handler below
  // is kept only for plain-browser development.
  //
  // v3 delivers the drop to Go rather than to JavaScript, so Go relays it back
  // under FILES_DROPPED_EVENT. The drop only fires on an element marked with
  // `data-file-drop-target` — that is the wrapper below.
  useEffect(() => {
    if (!isWails()) return
    return Events.On(FILES_DROPPED_EVENT, (e) => {
      const paths = Array.isArray(e?.data) ? e.data.flat() : []
      if (paths.length) importPaths(paths)
    })
  }, [])

  useEffect(() => {
    if (isWails()) return  // native drop is active
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

  /**
   * Ask before discarding unsaved work, if there is any.
   *
   * The pending document is flushed to the shell first. The editor sends its
   * edits on a debounce, so a Quit pressed straight after a change would
   * otherwise be answered from a state recorded before that change.
   */
  const confirmDiscard = useCallback(async (title, message, confirmLabel) => {
    const state = await getDocumentSync().flush()
    const st = useEditorStore.getState()
    const dirty = state ? !!state.dirty : selectDirty(st)
    if (!dirty) return true
    return st.askConfirm({ title, message, confirmLabel, danger: true })
  }, [])

  const refreshRecent = useCallback(() => {
    const sync = getDocumentSync()
    if (!sync.native) return
    sync.recent()
      .then((list) => useEditorStore.getState().setRecentShows(list))
      .catch(() => { })
  }, [])

  /** Install a document the shell just created or opened. */
  const adoptOpened = useCallback((res, message) => {
    if (!res || res.cancelled) return false
    const st = useEditorStore.getState()
    try {
      st.loadProject(JSON.parse(res.contents))
    } catch (err) {
      st.addLog({ level: 'error', message: `Could not read that show: ${err}` })
      return false
    }
    // The shell already holds exactly this document, so the update the load
    // is about to schedule is not an edit.
    getDocumentSync().invalidate()
    useEditorStore.getState().setDocumentState(res.state)
    useEditorStore.getState().setStatus(message)
    refreshRecent()
    return true
  }, [refreshRecent])

  const requestNewShow = useCallback(async () => {
    if (!await confirmDiscard('New Show', 'Discard unsaved changes and start a new show?', 'Discard')) return
    const sync = getDocumentSync()
    if (!sync.native) {
      useEditorStore.getState().newProject()
      useEditorStore.getState().setDocumentName('')
      useEditorStore.getState().setStatus('New show created')
      return
    }
    try {
      adoptOpened(await sync.newShow(), 'New show created')
    } catch (err) {
      useEditorStore.getState().addLog({ level: 'error', message: `Could not start a new show: ${err}` })
    }
  }, [confirmDiscard, adoptOpened])

  const requestQuit = useCallback(async () => {
    if (!await confirmDiscard('Quit', 'You have unsaved changes. Quit anyway?', 'Quit')) return
    // Go cancels every native close until this has been called, so the
    // window's own close button gets the same dirty check as the menu.
    try { if (isWails()) { await QuitConfirmed(); return } } catch { }
    try { Application.Quit() } catch { }
    try { window.close() } catch { }
  }, [])

  // The title-bar close arrives from Go as an event; answer it the way the
  // Quit menu item is answered.
  useEffect(() => {
    if (!isWails()) return
    return Events.On(CLOSE_REQUESTED_EVENT, () => { requestQuit() })
  }, [requestQuit])

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

  // Open goes through the same guard as New and Quit. It used to replace the
  // document and clear its history straight from the file picker, so an
  // unsaved show was gone with no confirmation and nothing to undo into.
  const requestOpenShow = useCallback(async (path) => {
    if (!await confirmDiscard('Open Show', 'Discard unsaved changes and open another show?', 'Discard')) return
    const sync = getDocumentSync()
    if (!sync.native) {
      useEditorStore.getState().addLog({ level: 'warn', message: 'Opening a show needs the desktop shell.' })
      return
    }
    try {
      const res = await (path ? sync.openPath(path) : sync.open())
      if (res?.cancelled) return
      adoptOpened(res, `Opened ${res?.state?.fileName || 'show'}`)
    } catch (err) {
      useEditorStore.getState().addLog({ level: 'error', message: `Could not open that show: ${err}` })
      useEditorStore.getState().setStatus('Open failed', 'error')
      // A file that has gone missing should stop being offered.
      refreshRecent()
    }
  }, [confirmDiscard, adoptOpened, refreshRecent])

  /**
   * Write the show back to its own file, asking for one the first time.
   *
   * Save used to be a browser blob download, so it could never overwrite:
   * every save produced another "show (3).json" in the downloads folder and
   * the application never learned where the show actually lived.
   */
  const requestSaveShow = useCallback(async (forceDialog = false) => {
    const sync = getDocumentSync()
    if (!sync.native) {
      useEditorStore.getState().addLog({ level: 'warn', message: 'Saving a show needs the desktop shell.' })
      return
    }
    // The debounced document has to reach the shell before it writes it, or
    // Ctrl+S straight after an edit would save the version before it.
    await sync.flush()
    try {
      const res = forceDialog ? await sync.saveAs() : await sync.save()
      if (!res || res.cancelled) return
      useEditorStore.getState().setDocumentState(res.state)
      useEditorStore.getState().setStatus(`Saved ${res.state.fileName}`)
      useEditorStore.getState().addLog({ level: 'info', message: `Show saved to ${res.state.path}` })
      refreshRecent()
    } catch (err) {
      useEditorStore.getState().addLog({ level: 'error', message: `Save failed: ${err}` })
      useEditorStore.getState().setStatus('Save failed', 'error')
    }
  }, [refreshRecent])

  // --- Keyboard -----------------------------------------------------------

  // One shortcut layer for the whole app, built from the shared table in
  // shortcuts.js so the menus, the Help overlay and the status-bar hints all
  // describe exactly what is bound here. Every binding is skipped while a
  // text field has focus.
  const shortcuts = useMemo(() => buildBindings({
    newShow: requestNewShow,
    openShow: () => requestOpenShow(),
    saveShow: () => requestSaveShow(false),
    saveShowAs: () => requestSaveShow(true),

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
  }), [requestNewShow, requestOpenShow, requestSaveShow, deleteSelection])
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
        if (isWails()) CloseRendererScreen(id)?.catch((e) => console.warn('CloseRendererScreen:', e))
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
          if (isWails()) {
            const o = k.output
            if (o) await OpenRendererScreenAt(n.id, px, py, o.x | 0, o.y | 0, !!o.borderless)
            else await OpenRendererScreen(n.id, px, py)
          }
        } catch (e) {
          console.error('Failed to open renderer screen:', e)
          useEditorStore.getState().setOutputStatus(n.id, { state: 'error', error: String(e) })
          useEditorStore.getState().addLog({ level: 'error', message: `Renderer launch failed for "${n.name || n.id}": ${e}` })
          return
        }
        // No sink: the shell sends each renderer the document and the
        // transport over the event stream, and replays both to one that
        // connects mid-show. Pushing them from here as well would be a
        // second, slower source of the same truth.
        rendererScreens.current.add(n.id)
      } else {
        const win = await openDisplayWindow(n.id, px, py, k.output ? { x: k.output.x | 0, y: k.output.y | 0 } : null)
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

  // "Close All Displays". Turning outputs off makes the effect above close
  // what it knows about; the sweep after it is for what it does not: display
  // windows and renderer processes left behind by a reload, a crash or a
  // previous editor instance, which the effect's bookkeeping never saw.
  const closeAllDisplays = useCallback(async () => {
    const st = useEditorStore.getState()
    st.setOutputsEnabled(false)
    st.addLog({ level: 'info', message: 'Closing display outputs' })
    const webOrphans = closeAllDisplayWindows()
    if (webOrphans > 0) useEditorStore.getState().addLog({ level: 'info', message: `Closed ${webOrphans} display window(s)` })
    if (!isWails()) return
    try {
      const killed = await CloseAllRendererScreens()
      if (killed > 0) useEditorStore.getState().addLog({ level: 'warn', message: `Killed ${killed} orphaned renderer process(es)` })
    } catch (e) {
      useEditorStore.getState().addLog({ level: 'error', message: `Closing renderer screens failed: ${e}` })
    }
  }, [])

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

  // The single trigger for "the document changed": send it to the shell,
  // which records it, decides whether the show now differs from its file, and
  // forwards it to every native renderer; and hand it to the web output
  // windows, which are reached by postMessage rather than through the shell.
  //
  // Both are debounced, so a burst of Inspector keystrokes costs one
  // serialization rather than one per character.
  useEffect(() => {
    if (!project || !scene) return
    getDocumentSync().schedule()
    const id = setTimeout(() => { getMediaSession().notifySnapshot() }, 50)
    return () => clearTimeout(id)
  }, [project, scene])

  const viewport = viewMode === '2d' ? <Viewport2D /> : (viewMode === '3d' ? <Viewport3D /> : <OutputPanel />)

  return (
    <div className="layout" data-file-drop-target>
      <header>
        <MenuBar
          onNewShow={requestNewShow}
          onOpenProject={() => requestOpenShow()}
          onOpenRecent={(path) => requestOpenShow(path)}
          onSaveShow={() => requestSaveShow(false)}
          onSaveShowAs={() => requestSaveShow(true)}
          onQuit={requestQuit}
          onCloseDisplays={closeAllDisplays}
          onReopenDisplays={() => {
            // Forget what we think is open; the screen effect then treats
            // every screen as new and re-opens it with a fresh sink.
            prevScreensRef.current = new Map()
            setReopenNonce((n) => n + 1)
          }}
        />
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
      <SettingsDialog />
      <ConfirmHost />
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
