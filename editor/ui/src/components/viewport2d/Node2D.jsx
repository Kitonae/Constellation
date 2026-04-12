import React, { useState, useEffect, Suspense } from 'react'
import { useEditorStore } from '../../store.js'
import { ModelPreview } from './ModelPreview.jsx'

export function Node2D({ node, center, scale, selectedId, onSelect, highlight, shiftHeld, dragScreen, setDragScreen, dragScreenRef }) {
  const t = node.transform
  const ratio = scale / 50
  const posX = (t?.position?.x ?? 0)
  const posY = (t?.position?.y ?? 0)
  const x = posX * ratio + center.x
  const y = center.y - posY * ratio
  const isSelected = node.id === selectedId

  const children = (node.children ?? []).map((c) => (
    <Node2D key={c.id} node={c} center={center} scale={scale} selectedId={selectedId} onSelect={onSelect} shiftHeld={shiftHeld} dragScreen={dragScreen} setDragScreen={setDragScreen} dragScreenRef={dragScreenRef} />
  ))

  if (node.kind?.type === 'screen') {
    const px = node.kind?.pixels?.[0] || 0
    const py = node.kind?.pixels?.[1] || 0
    const w = Math.max(2, px * ratio)
    const h = Math.max(2, py * ratio)
    const isRenderer = (node.kind?.screenType || 'web') === 'renderer'
    const borderColor = isSelected || highlight ? '#ffcc00' : '#3a4e85'

    const isDragging = dragScreen?.nodeId === node.id
    const drawX = isDragging && dragScreen.currentX !== undefined ? dragScreen.currentX * ratio + center.x : x
    const drawY = isDragging && dragScreen.currentY !== undefined ? center.y - dragScreen.currentY * ratio : y
    const screenLabel = `${node.name || node.id} (${px}x${py})`
    const typeTag = isRenderer ? 'NDI' : 'Web'

    return (
      <>
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
          onPointerDown={(e) => {
            if (!shiftHeld || e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
            onSelect(node.id)
            const d = { nodeId: node.id, origX: posX, origY: posY, startX: e.clientX, startY: e.clientY }
            setDragScreen(d)
            dragScreenRef.current = d
          }}
          onPointerMove={(e) => {
            const d = dragScreenRef.current
            if (!d || d.nodeId !== node.id) return
            if ((e.buttons & 1) === 0) { setDragScreen(null); dragScreenRef.current = null; return }
            const dx = e.clientX - d.startX
            const dy = e.clientY - d.startY
            const next = { ...d, currentX: d.origX + dx / ratio, currentY: d.origY - dy / ratio }
            dragScreenRef.current = next
            setDragScreen(next)
          }}
          onPointerUp={(e) => {
            const d = dragScreenRef.current
            if (!d || d.nodeId !== node.id) return
            if (d.currentX !== undefined) {
              useEditorStore.getState().updateNodeTransform(d.nodeId, {
                position: { x: d.currentX, y: d.currentY, z: 0 },
              })
            }
            setDragScreen(null)
            dragScreenRef.current = null
            try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
          }}
          title={screenLabel}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{ position: 'absolute', left: drawX - w / 2, top: drawY - h / 2, width: w, height: h, background: isSelected ? 'rgba(30,40,80,0.5)' : 'rgba(16,21,32,0.5)', border: `1px dashed ${borderColor}`, borderRadius: 2, zIndex: 1, cursor: shiftHeld ? 'move' : (isSelected ? 'not-allowed' : 'default') }}
        >
          {shiftHeld && <>
            <span style={{ position: 'absolute', top: 3, left: 5, fontSize: 10, color: '#8898b8', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: w - 10, pointerEvents: 'none', userSelect: 'none' }}>
              {screenLabel}
            </span>
            <span style={{ position: 'absolute', top: 3, right: 5, fontSize: 9, color: isRenderer ? '#a78bfa' : '#6aa0ff', fontWeight: 600, pointerEvents: 'none', userSelect: 'none', background: 'rgba(0,0,0,0.4)', padding: '1px 4px', borderRadius: 2 }}>
              {typeTag}
            </span>
          </>}
        </div>
        {children}
      </>
    )
  }

  if (node.kind?.type === 'model') {
    return <ModelNode2D node={node} x={x} y={y} ratio={ratio} isSelected={isSelected} onSelect={onSelect}>{children}</ModelNode2D>
  }

  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); onSelect(node.id) }} style={{ position: 'absolute', left: x - 2, top: y - 2, width: 4, height: 4, background: '#5a78ff', borderRadius: 2 }} title={node.name || node.id} />
      {children}
    </>
  )
}

function ModelNode2D({ node, x, y, ratio, isSelected, onSelect, children }) {
  const uri = node.kind?.uri
  const sz = Math.max(40, 80 * ratio)
  const borderColor = isSelected ? '#ffcc00' : '#a78bfa'

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
          borderRadius: 4,
          background: '#0b0d12',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          zIndex: 2,
          overflow: 'hidden',
        }}
      >
        <ModelPreview uri={uri} size={sz} />
        <span style={{
          position: 'absolute', bottom: 2, left: 0, right: 0,
          fontSize: Math.max(8, Math.min(10, sz * 0.11)),
          color: '#c7cfdb', textAlign: 'center',
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
