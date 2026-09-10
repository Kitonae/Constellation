import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../store.js'

function useClickAway(ref, onAway) {
  useEffect(() => {
    const handler = (e) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target)) onAway()
    }
    window.addEventListener('pointerdown', handler)
    return () => {
      window.removeEventListener('pointerdown', handler)
    }
  }, [ref, onAway])
}

// Defined at module scope: nesting these inside MenuBar created brand new
// component types on every render, so React remounted every open menu.

function Menu({ id, title, open, setOpen, children }) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault() // suppress the follow-up click
          setOpen(open === id ? null : id)
        }}
      >
        {title}
      </button>
      {open === id && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, minWidth: 220, background: '#0f1115', border: '1px solid #232636', borderRadius: 6, boxShadow: '0 8px 18px rgba(0,0,0,0.5)', padding: 6, zIndex: 2001 }}>
          {children}
        </div>
      )}
    </div>
  )
}

function Item({ onClick, children }) {
  return (
    <button type="button" onPointerDown={onClick} onClick={(e) => e.preventDefault()} style={{ width: '100%', textAlign: 'left' }}>{children}</button>
  )
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 12, opacity: 0.7, padding: '4px 6px' }}>{children}</div>
}

export default function MenuBar({
  onNewShow,
  onOpenProject,
  onSaveShow,
  onReopenDisplays,
}) {
  const viewMode = useEditorStore((s) => s.viewMode)
  const setViewMode = useEditorStore((s) => s.setViewMode)
  const gizmoMode = useEditorStore((s) => s.gizmoMode)
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode)
  const showOutputOverlay = useEditorStore((s) => s.showOutputOverlay)
  const toggleOutputOverlay = useEditorStore((s) => s.toggleOutputOverlay)
  const setSelected = useEditorStore((s) => s.setSelected)
  const addLog = useEditorStore((s) => s.addLog)
  const [open, setOpen] = useState(null) // 'file' | 'view' | 'displays' | null
  const wrapRef = useRef(null)
  useClickAway(wrapRef, () => setOpen(null))

  const pick = (fn) => () => { setOpen(null); fn?.() }

  return (
    <div ref={wrapRef} className="toolbar" style={{ gap: 10, alignItems: 'center', position: 'relative', zIndex: 2000 }}>
      <Menu id="file" title="File" open={open} setOpen={setOpen}>
        <Item onClick={pick(onNewShow)}>New Show</Item>
        <Item onClick={pick(onOpenProject)}>Open Show…</Item>
        <Item onClick={pick(onSaveShow)}>Save Show…</Item>
        <div style={{ height: 1, background: '#232636', margin: '4px 0' }} />
        <Item onClick={pick(() => { if (confirm('Quit?')) window.close() })}>Quit</Item>
      </Menu>

      {/* Previously `disabled`, which made 3D and Output view modes
          unreachable from the UI even though both viewports exist. */}
      <Menu id="view" title="View" open={open} setOpen={setOpen}>
        <SectionTitle>Viewport</SectionTitle>
        <div style={{ display: 'flex', gap: 6, padding: '0 6px 6px 6px', alignItems: 'center' }}>
          <button type="button" onPointerDown={pick(() => setViewMode('2d'))} onClick={(e) => e.preventDefault()} style={{ opacity: viewMode === '2d' ? 1 : 0.7 }}>2D</button>
          <button type="button" onPointerDown={pick(() => setViewMode('3d'))} onClick={(e) => e.preventDefault()} style={{ opacity: viewMode === '3d' ? 1 : 0.7 }}>3D</button>
          <button type="button" onPointerDown={pick(() => setViewMode('output'))} onClick={(e) => e.preventDefault()} style={{ opacity: viewMode === 'output' ? 1 : 0.7 }}>Output</button>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 6px 6px 6px', alignItems: 'center' }}>
          <button type="button" onPointerDown={pick(toggleOutputOverlay)} onClick={(e) => e.preventDefault()} style={{ opacity: showOutputOverlay ? 1 : 0.6 }}>Output Overlay</button>
        </div>
        <SectionTitle>Gizmo</SectionTitle>
        <div style={{ display: 'flex', gap: 6, padding: '0 6px 6px 6px', alignItems: 'center' }}>
          <button type="button" onPointerDown={pick(() => setGizmoMode('translate'))} onClick={(e) => e.preventDefault()} style={{ opacity: gizmoMode === 'translate' ? 1 : 0.6 }}>Move</button>
          <button type="button" onPointerDown={pick(() => setGizmoMode('rotate'))} onClick={(e) => e.preventDefault()} style={{ opacity: gizmoMode === 'rotate' ? 1 : 0.6 }}>Rotate</button>
          <button type="button" onPointerDown={pick(() => setGizmoMode('scale'))} onClick={(e) => e.preventDefault()} style={{ opacity: gizmoMode === 'scale' ? 1 : 0.6 }}>Scale</button>
        </div>
        <Item onClick={pick(() => setSelected(null))}>Deselect</Item>
      </Menu>

      {/* Replaces the old, permanently disabled "Remote" menu, whose Apply /
          Play / Pause / Stop buttons called stubs that only ever threw. */}
      <Menu id="displays" title="Displays" open={open} setOpen={setOpen}>
        <Item onClick={pick(() => { onReopenDisplays?.(); addLog({ level: 'info', message: 'Re-opening display outputs' }) })}>Re-open Displays</Item>
      </Menu>
    </div>
  )
}
