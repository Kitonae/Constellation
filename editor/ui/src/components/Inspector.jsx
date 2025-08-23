import React, { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '../store.js'
import { resolveImageSrc, inlineFromUri } from './MediaThumb.jsx'

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
  const updateScreenPixels = useEditorStore((s) => s.updateScreenPixels)
  const updateScreenEnabled = useEditorStore((s) => s.updateScreenEnabled)
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
      if (t.media && t.media.id === selectedClipId) return t.media
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
        img.onerror = async () => {
          try {
            const inlined = await inlineFromUri(selectedClip.uri)
            if (inlined) {
              const probe = new Image()
              probe.onload = () => { if (!cancelled) setNaturalSize({ w: probe.naturalWidth, h: probe.naturalHeight }); resolve() }
              probe.onerror = () => resolve()
              probe.src = inlined
              return
            }
          } catch {}
          resolve()
        }
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

      {selectedNode?.kind?.type === 'screen' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Screen</div>
          <div style={{ display:'grid', gap:8 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <label style={{ display:'flex', alignItems:'center', gap:6 }}>
                <input type="checkbox" checked={(selectedNode.kind?.enabled ?? true)} onChange={(e)=>updateScreenEnabled(selectedNode.id, e.target.checked)} />
                <span>Enabled</span>
              </label>
            </div>
            <div>
              <div style={{ marginBottom:4, opacity:0.8 }}>Position (X, Y px)</div>
              <div style={{ display:'flex', gap:6 }}>
                <NumberInput value={selectedNode.transform.position.x} onChange={(v)=>updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, x: v } })} />
                <NumberInput value={selectedNode.transform.position.y} onChange={(v)=>updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, y: v } })} />
              </div>
            </div>
            <div>
              <div style={{ marginBottom:4, opacity:0.8 }}>Resolution (W, H px)</div>
              <div style={{ display:'flex', gap:6 }}>
                <NumberInput value={selectedNode.kind?.pixels?.[0] || 0} onChange={(v)=>updateScreenPixels(selectedNode.id, [v, selectedNode.kind?.pixels?.[1] || 0])} />
                <NumberInput value={selectedNode.kind?.pixels?.[1] || 0} onChange={(v)=>updateScreenPixels(selectedNode.id, [selectedNode.kind?.pixels?.[0] || 0, v])} />
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedMedia && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Clip</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>ID: {selectedMedia.id}</div>
          <div style={{ marginTop:8 }}>
            <div style={{ marginBottom:4, opacity:0.8 }}>Timing (Start, Duration s)</div>
            <div style={{ display:'flex', gap:6 }}>
              <NumberInput step={0.01} value={selectedMedia.start ?? selectedMedia.start_at_seconds ?? 0} onChange={(v)=>useEditorStore.getState().updateClipStart({ timelineId: selectedMedia.id, startAt: Math.max(0, v) })} />
              <NumberInput step={0.01} value={selectedMedia.duration ?? Math.max(0, (selectedMedia.out_seconds - selectedMedia.in_seconds) || 0)} onChange={(v)=>useEditorStore.getState().updateClipDuration({ timelineId: selectedMedia.id, duration: Math.max(0, v) })} />
            </div>
          </div>
          <div>
            <div style={{ marginBottom:4, opacity:0.8 }}>Position (X, Y px)</div>
            <div style={{ display:'flex', gap:6 }}>
              <NumberInput step={1} value={selectedMedia.position?.x ?? 0} onChange={(v)=>updateClipTransform({ timelineId: selectedMedia.id, position: { x: Math.round(v) } })} />
              <NumberInput step={1} value={selectedMedia.position?.y ?? 0} onChange={(v)=>updateClipTransform({ timelineId: selectedMedia.id, position: { y: Math.round(v) } })} />
            </div>
          </div>
          <div style={{ marginTop:8 }}>
            <div style={{ marginBottom:4, opacity:0.8 }}>Size (W, H px)</div>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              <NumberInput
                step={1}
                value={selectedMedia.scale?.x ?? (naturalSize?.w ?? 0)}
                onChange={(v)=>{
                  if (keepAR) {
                    const baseW = selectedMedia.scale?.x ?? naturalSize?.w ?? 0
                    const baseH = selectedMedia.scale?.y ?? naturalSize?.h ?? 0
                    const ratio = baseW > 0 ? (baseH / baseW) : 1
                    const newH = Math.max(1, Math.round(v * ratio))
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { x: Math.round(v), y: newH } })
                  } else {
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { x: Math.round(v) } })
                  }
                }}
              />
              <NumberInput
                step={1}
                value={selectedMedia.scale?.y ?? (naturalSize?.h ?? 0)}
                onChange={(v)=>{
                  if (keepAR) {
                    const baseW = selectedMedia.scale?.x ?? naturalSize?.w ?? 0
                    const baseH = selectedMedia.scale?.y ?? naturalSize?.h ?? 0
                    const ratio = baseH > 0 ? (baseW / baseH) : 1
                    const newW = Math.max(1, Math.round(v * ratio))
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { x: newW, y: Math.round(v) } })
                  } else {
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { y: Math.round(v) } })
                  }
                }}
              />
              <button type="button" onClick={()=>setKeepAR(!keepAR)} style={{ opacity: keepAR ? 1 : 0.7 }}>Aspect</button>
              <button type="button" onClick={()=>{ if (naturalSize) updateClipTransform({ timelineId: selectedMedia.id, scale: { x: naturalSize.w, y: naturalSize.h } }) }}>Reset</button>
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
