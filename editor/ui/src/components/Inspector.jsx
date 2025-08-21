import React, { useMemo } from 'react'
import { useEditorStore } from '../store.js'

function NumberInput({ value, onChange, step = 0.1 }) {
  return (
    <input type="number" step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: 90, background:'#0f1115', color:'#e6e6e6', border:'1px solid #232636', borderRadius:4, padding:'4px 6px' }} />
  )
}

export default function Inspector() {
  const scene = useEditorStore((s) => s.scene)
  const selectedId = useEditorStore((s) => s.selectedId)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)

  const selectedNode = useMemo(() => {
    if (!scene || !selectedId) return null
    const stack = [...(scene.roots ?? [])]
    while (stack.length) {
      const n = stack.pop()
      if (n.id === selectedId) return n
      if (n.children?.length) stack.push(...n.children)
    }
    return null
  }, [scene, selectedId])

  return (
    <div style={{ padding: 8, color: '#e6e6e6' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Inspector</div>
      {!selectedNode && <div style={{ opacity: 0.7 }}>No selection.</div>}
      {selectedNode && (
        <div style={{ display:'grid', gap:8 }}>
          <div style={{ opacity:0.8 }}>
            <div style={{ fontWeight:600 }}>{selectedNode.name || selectedNode.id}</div>
            <div style={{ fontSize:12, opacity:0.7 }}>{selectedNode.id}</div>
          </div>
          <div>
            <div style={{ marginBottom:4, opacity:0.8 }}>Position</div>
            <div style={{ display:'flex', gap:6 }}>
              <NumberInput value={selectedNode.transform.position.x} onChange={(v)=>updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, x: v } })} />
              <NumberInput value={selectedNode.transform.position.y} onChange={(v)=>updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, y: v } })} />
              <NumberInput value={selectedNode.transform.position.z} onChange={(v)=>updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, z: v } })} />
            </div>
          </div>
          <div>
            <div style={{ marginBottom:4, opacity:0.8 }}>Scale</div>
            <div style={{ display:'flex', gap:6 }}>
              <NumberInput value={selectedNode.transform.scale.x} onChange={(v)=>updateNodeTransform(selectedNode.id, { scale: { ...selectedNode.transform.scale, x: v } })} />
              <NumberInput value={selectedNode.transform.scale.y} onChange={(v)=>updateNodeTransform(selectedNode.id, { scale: { ...selectedNode.transform.scale, y: v } })} />
              <NumberInput value={selectedNode.transform.scale.z} onChange={(v)=>updateNodeTransform(selectedNode.id, { scale: { ...selectedNode.transform.scale, z: v } })} />
            </div>
          </div>
          <div>
            <div style={{ marginBottom:4, opacity:0.8 }}>Rotation (quaternion)</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:6 }}>
              <NumberInput value={selectedNode.transform.rotation.x} step={0.01} onChange={(v)=>updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, x: v } })} />
              <NumberInput value={selectedNode.transform.rotation.y} step={0.01} onChange={(v)=>updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, y: v } })} />
              <NumberInput value={selectedNode.transform.rotation.z} step={0.01} onChange={(v)=>updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, z: v } })} />
              <NumberInput value={selectedNode.transform.rotation.w} step={0.01} onChange={(v)=>updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, w: v } })} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
