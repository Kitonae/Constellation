import React, { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '../store.js'
import { resolveImageSrc } from './MediaThumb.jsx'

function NumberInput({ value, onChange, step = 0.1 }) {
  return (
    <input type="number" step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: 90, background:'#0f1115', color:'#c7cfdb', border:'1px solid #232636', borderRadius:4, padding:'4px 6px' }} />
  )
}

export default function Inspector() {
  const scene = useEditorStore((s) => s.scene)
  const selectedId = useEditorStore((s) => s.selectedId)
  const selectedClipId = useEditorStore((s) => s.selectedClipId)
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)
  const project = useEditorStore((s) => s.project)
  const [keepAR, setKeepAR] = useState(true)
  const [naturalSize, setNaturalSize] = useState(null) // { w, h }

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

  // Find selected clip media entry
  const selectedMedia = useMemo(() => {
    if (!selectedClipId || !project?.timeline?.tracks) return null
    for (const t of project.timeline.tracks) {
      if (t.media && t.media.clip_id === selectedClipId) return t.media
    }
    return null
  }, [project, selectedClipId])

  const selectedClip = useMemo(() => {
    if (!selectedMedia) return null
    return (project?.media || []).find((m) => m.id === selectedMedia.clip_id) || null
  }, [project, selectedMedia])

  useEffect(() => {
    let cancelled = false
    async function loadMeta() {
      if (!selectedClip?.uri) { setNaturalSize(null); return }
      const src = await resolveImageSrc(selectedClip.uri)
      if (cancelled || !src) return
      await new Promise((resolve) => {
        const img = new Image()
        img.onload = () => { if (!cancelled) setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight }); resolve() }
        img.onerror = () => resolve()
        img.src = src
      })
    }
    loadMeta()
    return () => { cancelled = true }
  }, [selectedClip?.uri])

  return (
    <div style={{ padding: 8, color: '#c7cfdb' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Inspector</div>
      {!selectedNode && !selectedMedia && <div style={{ opacity: 0.7 }}>No selection.</div>}

      {selectedMedia && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Clip</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>ID: {selectedMedia.clip_id}</div>
          <div>
            <div style={{ marginBottom:4, opacity:0.8 }}>Position (X, Y)</div>
            <div style={{ display:'flex', gap:6 }}>
              <NumberInput value={selectedMedia.position?.x ?? 0} onChange={(v)=>updateClipTransform({ clipId: selectedMedia.clip_id, position: { x: v } })} />
              <NumberInput value={selectedMedia.position?.y ?? 0} onChange={(v)=>updateClipTransform({ clipId: selectedMedia.clip_id, position: { y: v } })} />
            </div>
          </div>
          <div style={{ marginTop:8 }}>
            <div style={{ marginBottom:4, opacity:0.8 }}>Size (W, H px)</div>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              <NumberInput
                value={selectedMedia.scale?.x ?? (naturalSize?.w ?? 0)}
                onChange={(v)=>{
                  if (keepAR) {
                    const baseW = selectedMedia.scale?.x ?? naturalSize?.w ?? 0
                    const baseH = selectedMedia.scale?.y ?? naturalSize?.h ?? 0
                    const ratio = baseW > 0 ? (baseH / baseW) : 1
                    const newH = Math.max(1, Math.round(v * ratio))
                    updateClipTransform({ clipId: selectedMedia.clip_id, scale: { x: v, y: newH } })
                  } else {
                    updateClipTransform({ clipId: selectedMedia.clip_id, scale: { x: v } })
                  }
                }}
              />
              <NumberInput
                value={selectedMedia.scale?.y ?? (naturalSize?.h ?? 0)}
                onChange={(v)=>{
                  if (keepAR) {
                    const baseW = selectedMedia.scale?.x ?? naturalSize?.w ?? 0
                    const baseH = selectedMedia.scale?.y ?? naturalSize?.h ?? 0
                    const ratio = baseH > 0 ? (baseW / baseH) : 1
                    const newW = Math.max(1, Math.round(v * ratio))
                    updateClipTransform({ clipId: selectedMedia.clip_id, scale: { x: newW, y: v } })
                  } else {
                    updateClipTransform({ clipId: selectedMedia.clip_id, scale: { y: v } })
                  }
                }}
              />
              <button type="button" onClick={()=>setKeepAR(!keepAR)} style={{ opacity: keepAR ? 1 : 0.7 }}>Aspect</button>
              <button type="button" onClick={()=>{ if (naturalSize) updateClipTransform({ clipId: selectedMedia.clip_id, scale: { x: naturalSize.w, y: naturalSize.h } }) }}>Reset</button>
            </div>
          </div>
        </div>
      )}

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
