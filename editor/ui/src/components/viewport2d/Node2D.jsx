import React, { useEffect, useState } from 'react'
import { useEditorStore } from '../../store.js'
import { generateModelThumbnail } from '../../utils/modelThumbnail.js'
import { BASE_SCALE } from './constants.js'

const DRAG_THRESHOLD_PX = 3

/**
 * A scene node drawn on the 2D stage.
 *
 * Screens are draggable whenever they are selected. They used to move only
 * while Shift was held, and an unselected-but-clicked screen showed a
 * `not-allowed` cursor, which reads as "this is broken" rather than "hold a
 * modifier". Shift now only means "screens only" — it pushes clips out of
 * the way for picking, and that mode is what the cyan viewport outline
 * announces.
 */
export default function Node2D({
  node, center, scale, selectedId, onSelect, highlight, shiftHeld,
  dragScreen, setDragScreen, dragScreenRef,
}) {
  const t = node.transform
  const ratio = scale / BASE_SCALE
  const posX = t?.position?.x ?? 0
  const posY = t?.position?.y ?? 0
  const x = posX * ratio + center.x
  const y = center.y - posY * ratio
  const isSelected = node.id === selectedId

  const children = (node.children ?? []).map((c) => (
    <Node2D key={c.id} node={c} center={center} scale={scale} selectedId={selectedId} onSelect={onSelect}
      shiftHeld={shiftHeld} dragScreen={dragScreen} setDragScreen={setDragScreen} dragScreenRef={dragScreenRef} />
  ))

  if (node.kind?.type === 'screen') {
    const px = node.kind?.pixels?.[0] || 0
    const py = node.kind?.pixels?.[1] || 0
    const w = Math.max(2, px * ratio)
    const h = Math.max(2, py * ratio)
    const isRenderer = (node.kind?.screenType || 'web') === 'renderer'
    const borderColor = isSelected || highlight ? 'var(--accent-yellow)' : 'var(--stage-line)'

    const isDragging = dragScreen?.nodeId === node.id
    const drawX = isDragging && dragScreen.currentX !== undefined ? dragScreen.currentX * ratio + center.x : x
    const drawY = isDragging && dragScreen.currentY !== undefined ? center.y - dragScreen.currentY * ratio : y
    const screenLabel = `${node.name || node.id} (${px}x${py})`
    const typeTag = isRenderer ? 'NDI' : 'Web'

    return (
      <>
        <div
          className="v2d-screen"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
            onSelect(node.id)
            const d = { nodeId: node.id, origX: posX, origY: posY, startX: e.clientX, startY: e.clientY, moved: false }
            setDragScreen(d)
            dragScreenRef.current = d
          }}
          onPointerMove={(e) => {
            const d = dragScreenRef.current
            if (!d || d.nodeId !== node.id) return
            if ((e.buttons & 1) === 0) { setDragScreen(null); dragScreenRef.current = null; return }
            const dx = e.clientX - d.startX
            const dy = e.clientY - d.startY
            if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
            const next = { ...d, moved: true, currentX: d.origX + dx / ratio, currentY: d.origY - dy / ratio }
            dragScreenRef.current = next
            setDragScreen(next)
          }}
          onPointerUp={(e) => {
            const d = dragScreenRef.current
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
            if (!d || d.nodeId !== node.id) return
            if (d.moved && d.currentX !== undefined) {
              useEditorStore.getState().updateNodeTransform(d.nodeId, {
                position: { x: d.currentX, y: d.currentY, z: 0 },
              })
            }
            setDragScreen(null)
            dragScreenRef.current = null
          }}
          title={screenLabel}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{
            position: 'absolute',
            left: drawX - w / 2,
            top: drawY - h / 2,
            width: w,
            height: h,
            background: isSelected ? 'var(--screen-fill-selected)' : 'var(--screen-fill)',
            border: `1px dashed ${borderColor}`,
            borderRadius: 2,
            zIndex: 1,
            cursor: 'move',
          }}
        >
          {/* Labels are always on: at rest the stage used to be a set of
              unidentified dashed rectangles unless you happened to hold
              Shift. Hidden only when the screen is too small to hold text. */}
          {w > 60 && (
            <>
              <span style={{
                position: 'absolute', top: 3, left: 5, fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 500,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: w - 46,
                pointerEvents: 'none', userSelect: 'none',
              }}>
                {screenLabel}
              </span>
              <span style={{
                position: 'absolute', top: 3, right: 5, fontSize: 9,
                color: isRenderer ? 'var(--model)' : 'var(--accent)', fontWeight: 600,
                pointerEvents: 'none', userSelect: 'none', background: 'rgba(0,0,0,0.4)',
                padding: '1px 4px', borderRadius: 2,
              }}>
                {typeTag}
              </span>
            </>
          )}
        </div>
        {children}
      </>
    )
  }

  if (node.kind?.type === 'model') {
    return <ModelNode2D node={node} x={x} y={y} ratio={ratio} isSelected={isSelected} onSelect={onSelect}>{children}</ModelNode2D>
  }

  // Any other node: a small dot.
  return (
    <>
      <div
        onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
        style={{ position: 'absolute', left: x - 3, top: y - 3, width: 6, height: 6, background: 'var(--accent)', borderRadius: 3, cursor: 'pointer' }}
        title={node.name || node.id}
      />
      {children}
    </>
  )
}

function ModelNode2D({ node, x, y, ratio, isSelected, onSelect, children }) {
  const [thumb, setThumb] = useState(null)
  const uri = node.kind?.uri
  const format = node.kind?.format || node.name

  useEffect(() => {
    if (!uri) return
    let cancelled = false
    generateModelThumbnail(uri, format).then((url) => { if (!cancelled) setThumb(url) })
    return () => { cancelled = true }
  }, [uri, format])

  const sz = Math.max(40, 80 * ratio)
  const borderColor = isSelected ? 'var(--accent-yellow)' : 'var(--model)'

  return (
    <>
      <div
        onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
        title={node.name || node.id}
        style={{
          position: 'absolute',
          left: x - sz / 2,
          top: y - sz / 2,
          width: sz,
          height: sz,
          border: `1px dashed ${borderColor}`,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-deep)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 2,
          overflow: 'hidden',
        }}
      >
        {thumb ? (
          <img src={thumb} alt={node.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} draggable={false} />
        ) : (
          <span className="ms" style={{ fontSize: Math.max(16, sz * 0.4), color: 'var(--model)', opacity: 0.8 }}>view_in_ar</span>
        )}
        <span style={{
          position: 'absolute', bottom: 2, left: 0, right: 0,
          fontSize: Math.max(8, Math.min(10, sz * 0.11)),
          color: 'var(--text)', textAlign: 'center',
          background: 'rgba(0,0,0,0.6)', padding: '1px 4px',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {node.name || 'Model'}
        </span>
      </div>
      {children}
    </>
  )
}
