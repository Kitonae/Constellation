import React, { useRef, useState } from 'react'
import { useEditorStore } from '../store.js'
import { selectSelectionSummary } from '../selectors.js'
import { accelFor } from '../shortcuts.js'
import { Menu, MenuItem, MenuSeparator, MenuSection, useMenuDismiss, useMenuBarArrows } from './menu/Menu.jsx'

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
  onSaveShow,
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
  const outputsEnabled = useEditorStore((s) => s.outputsEnabled)
  const setOutputsEnabled = useEditorStore((s) => s.setOutputsEnabled)
  const addLog = useEditorStore((s) => s.addLog)

  // Undo/Redo need to grey out when there is nothing to undo, which means
  // subscribing to the stack depths (numbers, so no render churn).
  const undoDepth = useEditorStore((s) => s._undoStack.length)
  const redoDepth = useEditorStore((s) => s._redoStack.length)
  const undoLabel = useEditorStore((s) => s._currentLabel)
  const redoLabel = useEditorStore((s) => s._redoStack[s._redoStack.length - 1]?.label)
  const selectionKind = useEditorStore((s) => selectSelectionSummary(s).kind)

  const [open, setOpen] = useState(null)
  const wrapRef = useRef(null)
  useMenuDismiss(wrapRef, open, setOpen)
  useMenuBarArrows(wrapRef, open, setOpen, MENU_ORDER)

  const run = (fn) => () => { setOpen(null); fn?.() }

  return (
    <div ref={wrapRef} role="menubar" className="menubar toolbar">
      <Menu id="file" title="File" open={open} setOpen={setOpen}>
        <MenuItem label="New Show" accel={accelFor('newShow')} onSelect={run(onNewShow)} />
        <MenuItem label="Open Show…" accel={accelFor('openShow')} onSelect={run(onOpenProject)} />
        <MenuItem label="Save Show…" accel={accelFor('saveShow')} onSelect={run(onSaveShow)} />
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
          onSelect={run(() => { setOutputsEnabled(false); addLog({ level: 'info', message: 'Closing display outputs' }) })}
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
  )
}
