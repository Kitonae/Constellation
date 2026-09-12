import React, { useRef, useState } from 'react'
import { useEditorStore } from '../store.js'
import { baseName } from '../media/asset.js'
import { selectSelectionSummary, selectDirty } from '../selectors.js'
import { accelFor } from '../shortcuts.js'
import { Menu, MenuItem, MenuSeparator, MenuSection, useMenuDismiss, useMenuBarArrows } from './menu/Menu.jsx'
import WindowControls, { toggleMaximiseFromDragRegion } from './WindowControls.jsx'
import constellationMark from '../assets/constellation-mark.png'

const MENU_ORDER = ['file', 'edit', 'view', 'displays', 'help']

/**
 * The application menu bar.
 *
 * Every action the app can do now has a home here with its accelerator
 * written next to it. Undo, Redo, Delete, Select All, the console and the
 * shortcut list used to exist only as keystrokes with nothing in the UI
 * pointing at them.
 */
export default function MenuBar({
  onNewShow,
  onOpenProject,
  onOpenRecent,
  onSaveShow,
  onSaveShowAs,
  onCloseDisplays,
  onReopenDisplays,
  onQuit,
}) {
  const viewMode = useEditorStore((s) => s.viewMode)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const gizmoMode = useEditorStore((s) => s.gizmoMode)
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode)
  const showOutputOverlay = useEditorStore((s) => s.showOutputOverlay)
  const toggleOutputOverlay = useEditorStore((s) => s.toggleOutputOverlay)
  const consoleOpen = useEditorStore((s) => s.consoleOpen)
  const toggleConsole = useEditorStore((s) => s.toggleConsole)
  const layout = useEditorStore((s) => s.layout)
  const toggleLayoutPanel = useEditorStore((s) => s.toggleLayoutPanel)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const selectAllClips = useEditorStore((s) => s.selectAllClips)
  const toggleShortcutsHelp = useEditorStore((s) => s.toggleShortcutsHelp)
  const toggleSettings = useEditorStore((s) => s.toggleSettings)
  const outputsEnabled = useEditorStore((s) => s.outputsEnabled)
  const setOutputsEnabled = useEditorStore((s) => s.setOutputsEnabled)
  const addLog = useEditorStore((s) => s.addLog)
  // The shell keeps this list; it survives restarts and drops files that have
  // since been moved or deleted.
  const recentShows = useEditorStore((s) => s.recentShows)

  // Undo/Redo need to grey out when there is nothing to undo, which means
  // subscribing to the stack depths (numbers, so no render churn).
  const undoDepth = useEditorStore((s) => s._undoStack.length)
  const redoDepth = useEditorStore((s) => s._redoStack.length)
  const undoLabel = useEditorStore((s) => s._currentLabel)
  const redoLabel = useEditorStore((s) => s._redoStack[s._redoStack.length - 1]?.label)
  const selectionKind = useEditorStore((s) => selectSelectionSummary(s).kind)

  // The app bar's breadcrumb and telemetry read the same state the status bar
  // does: there is no separate "show" model, so the document name stands in
  // for the show and the outputs map supplies the live counts.
  const documentName = useEditorStore((s) => s.documentName)
  const dirty = useEditorStore(selectDirty)
  const outputs = useEditorStore((s) => s.outputs)

  const [open, setOpen] = useState(null)
  const wrapRef = useRef(null)
  useMenuDismiss(wrapRef, open, setOpen)
  useMenuBarArrows(wrapRef, open, setOpen, MENU_ORDER)

  const run = (fn) => () => { setOpen(null); fn?.() }

  const entries = Object.values(outputs)
  const openCount = entries.filter((o) => o?.state === 'open' || o?.state === 'running').length
  const failed = entries.filter((o) => o?.state === 'error').length
  // Only renderer outputs report a frame rate; show the slowest, since that is
  // the one that would drop a show.
  const rates = entries.map((o) => Number(o?.fps)).filter((n) => Number.isFinite(n) && n > 0)
  const fps = rates.length ? Math.min(...rates) : null

  const MODES = [
    { id: '2d', label: 'Stage' },
    { id: '3d', label: 'Scene' },
    { id: 'output', label: 'Output' },
  ]

  return (
    <div className="appbar" onDoubleClick={toggleMaximiseFromDragRegion}>
      <div className="appbar__brand">
        <img className="appbar__mark" src={constellationMark} alt="" draggable={false} />
        <span className="appbar__wordmark">Constellation</span>
      </div>

      <span className="appbar__rule" aria-hidden="true" />

      <div className="appbar__doc" title={documentName || 'Untitled'}>
        <span className="appbar__doc-name">{documentName || 'Untitled'}</span>
        {dirty && <span className="appbar__doc-dot" title="Unsaved changes" />}
      </div>

      <div ref={wrapRef} role="menubar" className="menubar toolbar">
      <Menu id="file" title="File" open={open} setOpen={setOpen}>
        <MenuItem label="New Show" accel={accelFor('newShow')} onSelect={run(onNewShow)} />
        <MenuItem label="Open Show…" accel={accelFor('openShow')} onSelect={run(onOpenProject)} />
        <MenuItem label="Save Show" accel={accelFor('saveShow')} onSelect={run(onSaveShow)} />
        <MenuItem label="Save Show As…" accel={accelFor('saveShowAs')} onSelect={run(onSaveShowAs)} />
        {recentShows.length > 0 && (
          <>
            <MenuSeparator />
            <MenuSection>Open Recent</MenuSection>
            {recentShows.map((path) => (
              <MenuItem
                key={path}
                label={baseName(path)}
                title={path}
                onSelect={run(() => onOpenRecent?.(path))}
              />
            ))}
          </>
        )}
        <MenuSeparator />
        <MenuItem label="Quit" onSelect={run(onQuit)} />
      </Menu>

      <Menu id="edit" title="Edit" open={open} setOpen={setOpen}>
        <MenuItem
          label={undoDepth ? `Undo ${undoLabel}` : 'Undo'}
          accel={accelFor('undo')}
          disabled={!undoDepth}
          onSelect={run(() => useEditorStore.getState().undo())}
        />
        <MenuItem
          label={redoDepth ? `Redo ${redoLabel}` : 'Redo'}
          accel={accelFor('redo')}
          disabled={!redoDepth}
          onSelect={run(() => useEditorStore.getState().redo())}
        />
        <MenuSeparator />
        <MenuItem
          label="Delete Selection"
          accel={accelFor('delete')}
          disabled={selectionKind === 'none'}
          onSelect={run(() => window.dispatchEvent(new CustomEvent('editor:delete-selection')))}
        />
        <MenuItem label="Select All Clips" accel={accelFor('selectAllClips')} onSelect={run(selectAllClips)} />
        <MenuItem
          label="Deselect"
          accel={accelFor('deselect')}
          disabled={selectionKind === 'none'}
          onSelect={run(clearSelection)}
        />
        <MenuSeparator />
        <MenuItem label="Settings…" onSelect={run(toggleSettings)} />
      </Menu>

      <Menu id="view" title="View" open={open} setOpen={setOpen}>
        <MenuSection>Viewport</MenuSection>
        <MenuItem role="menuitemradio" label="2D Stage" checked={viewMode === '2d'} onSelect={run(() => setViewMode('2d'))} />
        <MenuItem role="menuitemradio" label="3D Scene" checked={viewMode === '3d'} onSelect={run(() => setViewMode('3d'))} />
        <MenuItem role="menuitemradio" label="Output" checked={viewMode === 'output'} onSelect={run(() => setViewMode('output'))} />
        <MenuItem role="menuitemcheckbox" label="Output Overlay" checked={showOutputOverlay} onSelect={run(toggleOutputOverlay)} />
        <MenuSeparator />
        <MenuSection>Gizmo</MenuSection>
        <MenuItem role="menuitemradio" label="Move" checked={gizmoMode === 'translate'} onSelect={run(() => setGizmoMode('translate'))} />
        <MenuItem role="menuitemradio" label="Rotate" checked={gizmoMode === 'rotate'} onSelect={run(() => setGizmoMode('rotate'))} />
        <MenuItem role="menuitemradio" label="Scale" checked={gizmoMode === 'scale'} onSelect={run(() => setGizmoMode('scale'))} />
        <MenuSeparator />
        <MenuSection>Panels</MenuSection>
        <MenuItem role="menuitemcheckbox" label="Media Bin" checked={!layout.mediaCollapsed} onSelect={run(() => toggleLayoutPanel('media'))} />
        <MenuItem role="menuitemcheckbox" label="Inspector" checked={!layout.inspectorCollapsed} onSelect={run(() => toggleLayoutPanel('inspector'))} />
        <MenuItem role="menuitemcheckbox" label="Timeline" checked={!layout.timelineCollapsed} onSelect={run(() => toggleLayoutPanel('timeline'))} />
        <MenuItem role="menuitemcheckbox" label="Console" accel={accelFor('toggleConsole')} checked={consoleOpen} onSelect={run(toggleConsole)} />
      </Menu>

      <Menu id="displays" title="Displays" open={open} setOpen={setOpen}>
        <MenuItem
          label="Open All Displays"
          disabled={outputsEnabled}
          onSelect={run(() => { setOutputsEnabled(true); addLog({ level: 'info', message: 'Opening display outputs' }) })}
        />
        <MenuItem
          label="Close All Displays"
          disabled={!outputsEnabled}
          onSelect={run(() => onCloseDisplays?.())}
        />
        <MenuSeparator />
        <MenuItem
          label="Re-open Displays"
          onSelect={run(() => { onReopenDisplays?.(); addLog({ level: 'info', message: 'Re-opening display outputs' }) })}
        />
      </Menu>

      <Menu id="help" title="Help" open={open} setOpen={setOpen}>
          <MenuItem label="Keyboard Shortcuts…" accel={accelFor('shortcutsHelp')} onSelect={run(toggleShortcutsHelp)} />
        </Menu>
      </div>

      <div className="appbar__modes" role="group" aria-label="Viewport mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={'appbar__mode' + (viewMode === m.id ? ' is-active' : '')}
            aria-pressed={viewMode === m.id}
            onClick={() => setViewMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <span className="appbar__spacer" />

      <div className="appbar__telemetry">
        <span className={'appbar__stat' + (failed ? ' is-error' : '')}>
          <span className={'appbar__dot' + (failed ? ' is-error' : openCount ? ' is-ok' : '')} />
          {openCount}/{entries.length} outputs
        </span>
        {fps !== null && <span className="appbar__stat">{fps.toFixed(2)} fps</span>}
      </div>

      <WindowControls />
    </div>
  )
}
