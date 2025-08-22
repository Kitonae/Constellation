import React, { useEffect, useRef, useState } from 'react'

function useClickAway(ref, onAway) {
  useEffect(() => {
    const handler = (e) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target)) onAway()
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('touchstart', handler)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('touchstart', handler)
    }
  }, [ref, onAway])
}

export default function MenuBar({
  onOpenProject,
  onAddImage,
  viewMode,
  setViewMode,
  gizmoMode,
  setGizmoMode,
  onDeselect,
  addr,
  setAddr,
  onApply,
  onRemotePlay,
  onRemotePause,
  onRemoteStop,
}) {
  const [open, setOpen] = useState(null) // 'file' | 'view' | 'remote' | null
  const wrapRef = useRef(null)
  useClickAway(wrapRef, () => setOpen(null))

  const Menu = ({ id, title, children }) => (
    <div style={{ position: 'relative' }}>
      <button type="button" style={{ display:'inline-flex', alignItems:'center' }} onClick={() => setOpen(open === id ? null : id)}>{title}</button>
      {open === id && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, minWidth: 220, background: '#0f1115', border: '1px solid #232636', borderRadius: 6, boxShadow: '0 8px 18px rgba(0,0,0,0.5)', padding: 6, zIndex: 50 }}>
          {children}
        </div>
      )}
    </div>
  )

  const Item = ({ onClick, children }) => (
    <button type="button" onPointerDown={() => { setOpen(null); onClick?.() }} onClick={(e)=>e.preventDefault()} style={{ width: '100%', textAlign: 'left' }}>{children}</button>
  )

  const SectionTitle = ({ children }) => (
    <div style={{ fontSize: 12, opacity: 0.7, padding: '4px 6px' }}>{children}</div>
  )

  return (
    <div ref={wrapRef} className="toolbar" style={{ gap: 10, alignItems:'center' }}>
      <Menu id="file" title="File">
        <Item onClick={onOpenProject}>Open Project…</Item>
        <Item onClick={onAddImage}>Add Image…</Item>
      </Menu>

      <Menu id="view" title="View">
        <SectionTitle>Viewport</SectionTitle>
        <div style={{ display: 'flex', gap: 6, padding: '0 6px 6px 6px', alignItems:'center' }}>
          <button onClick={() => { setOpen(null); setViewMode('2d') }} style={{ opacity: viewMode === '2d' ? 1 : 0.7 }}>2D</button>
          <button onClick={() => { setOpen(null); setViewMode('3d') }} style={{ opacity: viewMode === '3d' ? 1 : 0.7 }}>3D</button>
        </div>
        <SectionTitle>Gizmo</SectionTitle>
        <div style={{ display: 'flex', gap: 6, padding: '0 6px 6px 6px', alignItems:'center' }}>
          <button onClick={() => { setOpen(null); setGizmoMode('translate') }} style={{ opacity: gizmoMode === 'translate' ? 1 : 0.6 }}>Move</button>
          <button onClick={() => { setOpen(null); setGizmoMode('rotate') }} style={{ opacity: gizmoMode === 'rotate' ? 1 : 0.6 }}>Rotate</button>
          <button onClick={() => { setOpen(null); setGizmoMode('scale') }} style={{ opacity: gizmoMode === 'scale' ? 1 : 0.6 }}>Scale</button>
        </div>
        <Item onClick={onDeselect}>Deselect</Item>
      </Menu>

      <Menu id="remote" title="Remote">
        <SectionTitle>Display Address</SectionTitle>
        <div style={{ padding: '0 6px 6px 6px' }}>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} style={{ width: 240, background: '#0f1115', color: '#c7cfdb', border: '1px solid #232636', borderRadius: 4, padding: '4px 6px' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 6px 6px 6px', alignItems:'center' }}>
          <button type="button" onPointerDown={() => { setOpen(null); onApply() }} onClick={(e)=>e.preventDefault()}>Apply</button>
          <button type="button" onPointerDown={() => { setOpen(null); onRemotePlay() }} onClick={(e)=>e.preventDefault()}>Play</button>
          <button type="button" onPointerDown={() => { setOpen(null); onRemotePause() }} onClick={(e)=>e.preventDefault()}>Pause</button>
          <button type="button" onPointerDown={() => { setOpen(null); onRemoteStop() }} onClick={(e)=>e.preventDefault()}>Stop</button>
        </div>
      </Menu>
    </div>
  )
}
