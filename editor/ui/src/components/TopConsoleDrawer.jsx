import React from 'react'
import { useEditorStore } from '../store.js'
import ConsolePanel from './ConsolePanel.jsx'

/**
 * The log drawer that slides down from the top.
 *
 * Sits below modal dialogs in the stacking order — at its old z-index of
 * 4000 it covered the Save dialog.
 */
export default function TopConsoleDrawer() {
  const open = useEditorStore((s) => s.consoleOpen)

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '32vh',
        maxHeight: '50vh',
        transform: open ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 160ms ease-in-out',
        background: 'var(--bg-deep)',
        borderBottom: '1px solid var(--border)',
        boxShadow: 'var(--shadow-menu)',
        zIndex: 'var(--z-console)',
        pointerEvents: open ? 'auto' : 'none',
      }}
      aria-hidden={!open}
    >
      <ConsolePanel />
    </div>
  )
}
