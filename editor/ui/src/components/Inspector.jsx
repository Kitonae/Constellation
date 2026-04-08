import React, { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '../store.js'
import { resolveImageSrc, inlineFromUri } from './MediaThumb.jsx'

function NumberInput({ value, onChange, step = 0.1, style }) {
  return (
    <input
      type="number"
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={{
        width: '100%',
        background: '#0f1115',
        color: '#c7cfdb',
        border: '1px solid #232636',
        borderRadius: 4,
        padding: '4px 8px',
        fontSize: 12,
        boxSizing: 'border-box',
        outline: 'none',
        transition: 'border-color 0.2s',
        ...style
      }}
      onFocus={(e) => e.target.style.borderColor = '#4a5568'}
      onBlur={(e) => e.target.style.borderColor = '#232636'}
    />
  )
}

function Divider() {
  return <div style={{ height: 1, background: '#232636', margin: '4px 0' }} />
}

function Category({ title, children, defaultOpen = true, actions }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderBottom: '1px solid #232636' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none',
          background: '#1b1e26',
          transition: 'background 0.2s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = '#232636'}
        onMouseLeave={(e) => e.currentTarget.style.background = '#1b1e26'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ 
            fontSize: 10, 
            opacity: 0.6, 
            color: '#c7cfdb',
            transform: open ? 'rotate(90deg)' : 'none', 
            transition: 'transform 0.2s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 12,
            height: 12
          }}>▶</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#e1e4e8' }}>{title}</span>
        </div>
        {actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
      </div>
      {open && <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 16 }}>{children}</div>}
    </div>
  )
}

function PropertyRow({ label, children, style }) {
  return (
    <div style={style}>
      {label && <div style={{ marginBottom: 6, fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500, color: '#c7cfdb' }}>{label}</div>}
      <div style={{ display: 'flex', gap: 8 }}>{children}</div>
    </div>
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
  const updateScreenType = useEditorStore((s) => s.updateScreenType)
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
      const mediaList = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
      const found = mediaList.find(m => m.id === selectedClipId)
      if (found) return found
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
          } catch { }
          resolve()
        }
        img.src = src
      })
    }
    loadMeta()
    return () => { cancelled = true }
  }, [selectedClip?.uri])

  if (!selectedNode && !selectedMedia) {
    return <div style={{ padding: 16, opacity: 0.5, textAlign: 'center', fontSize: 13, color: '#c7cfdb' }}>No selection</div>
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#13151a', color: '#c7cfdb' }}>
      {selectedNode?.kind?.type === 'screen' && (
        <Category title="Screen Settings">
          <PropertyRow label="Type">
            <select
              value={selectedNode.kind?.screenType || 'web'}
              onChange={(e) => updateScreenType(selectedNode.id, e.target.value)}
              style={{
                width: '100%',
                background: '#0f1115',
                color: '#c7cfdb',
                border: '1px solid #232636',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 12,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="web">Web</option>
              <option value="renderer">Renderer</option>
            </select>
          </PropertyRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={(selectedNode.kind?.enabled ?? true)} onChange={(e) => updateScreenEnabled(selectedNode.id, e.target.checked)} />
              <span style={{ fontSize: 12, color: '#c7cfdb' }}>Enabled</span>
            </label>
          </div>
          <PropertyRow label="Resolution (W x H)">
            <NumberInput value={selectedNode.kind?.pixels?.[0] || 0} onChange={(v) => updateScreenPixels(selectedNode.id, [v, selectedNode.kind?.pixels?.[1] || 0])} />
            <NumberInput value={selectedNode.kind?.pixels?.[1] || 0} onChange={(v) => updateScreenPixels(selectedNode.id, [selectedNode.kind?.pixels?.[0] || 0, v])} />
          </PropertyRow>
        </Category>
      )}

      {selectedMedia && (
        <>
          <Category title="Transform">
            <PropertyRow label="Position (X, Y)">
              <NumberInput step={1} value={selectedMedia.position?.x ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, position: { x: Math.round(v) } })} />
              <NumberInput step={1} value={selectedMedia.position?.y ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, position: { y: Math.round(v) } })} />
            </PropertyRow>
            <PropertyRow label="Size (W, H)">
              <NumberInput
                step={1}
                value={selectedMedia.scale?.x ?? (naturalSize?.w ?? 0)}
                onChange={(v) => {
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
                onChange={(v) => {
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
            </PropertyRow>
            
            <Divider />

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setKeepAR(!keepAR)}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  background: keepAR ? '#354066' : '#161820',
                  border: `1px solid ${keepAR ? '#6aa0ff' : '#232636'}`,
                  color: keepAR ? '#fff' : '#c7cfdb',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                {keepAR ? 'AspectRatio: Locked' : 'AspectRatio: Free'}
              </button>
              <button
                onClick={() => { if (naturalSize) updateClipTransform({ timelineId: selectedMedia.id, scale: { x: naturalSize.w, y: naturalSize.h } }) }}
                style={{
                  padding: '6px 8px',
                  background: '#161820',
                  border: '1px solid #232636',
                  color: '#c7cfdb',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                Reset Size
              </button>
            </div>
          </Category>

          <Category title="Timing">
            <PropertyRow label="Start / Duration (s)">
              <NumberInput step={0.01} value={selectedMedia.start ?? selectedMedia.start_at_seconds ?? 0} onChange={(v) => useEditorStore.getState().updateClipStart({ timelineId: selectedMedia.id, startAt: Math.max(0, v) })} />
              <NumberInput step={0.01} value={selectedMedia.duration ?? Math.max(0, (selectedMedia.out_seconds - selectedMedia.in_seconds) || 0)} onChange={(v) => useEditorStore.getState().updateClipDuration({ timelineId: selectedMedia.id, duration: Math.max(0, v) })} />
            </PropertyRow>
            <PropertyRow label="Fade In / Out (s)">
              <NumberInput step={0.1} value={selectedMedia.fade_in ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, fade_in: v })} />
              <NumberInput step={0.1} value={selectedMedia.fade_out ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, fade_out: v })} />
            </PropertyRow>
          </Category>

          <Category title="Appearance">
            <PropertyRow label="Opacity">
              <NumberInput step={0.1} value={selectedMedia.opacity ?? 1} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, opacity: v })} />
            </PropertyRow>
          </Category>

          <Category title="Effects" defaultOpen={false}>
            <div style={{ display: 'grid', gap: 12 }}>
              <EffectControl label="Brightness" effect="brightness" defaultValue={1} step={0.1} media={selectedMedia} />
              <EffectControl label="Contrast" effect="contrast" defaultValue={1} step={0.1} media={selectedMedia} />
              <EffectControl label="Saturation" effect="saturate" defaultValue={1} step={0.1} media={selectedMedia} />
              <EffectControl label="Grayscale" effect="grayscale" defaultValue={1} hasValue={false} media={selectedMedia} />
              <EffectControl label="Sepia" effect="sepia" defaultValue={1} hasValue={false} media={selectedMedia} />
              <EffectControl label="Hue Rotate" effect="hue-rotate" defaultValue={0} step={1} media={selectedMedia} />
              <EffectControl label="Invert" effect="invert" defaultValue={1} hasValue={false} media={selectedMedia} />
              <EffectControl label="Blur" effect="blur" defaultValue={0} step={1} media={selectedMedia} />
            </div>
          </Category>
        </>
      )}

      {selectedNode && (
        <>
          <Category title="Node Transform">
            <PropertyRow label="Position (X, Y, Z)">
              <NumberInput value={selectedNode.transform.position.x} onChange={(v) => updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, x: v } })} />
              <NumberInput value={selectedNode.transform.position.y} onChange={(v) => updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, y: v } })} />
              <NumberInput value={selectedNode.transform.position.z} onChange={(v) => updateNodeTransform(selectedNode.id, { position: { ...selectedNode.transform.position, z: v } })} />
            </PropertyRow>
            <PropertyRow label="Scale (X, Y, Z)">
              <NumberInput value={selectedNode.transform.scale.x} onChange={(v) => updateNodeTransform(selectedNode.id, { scale: { ...selectedNode.transform.scale, x: v } })} />
              <NumberInput value={selectedNode.transform.scale.y} onChange={(v) => updateNodeTransform(selectedNode.id, { scale: { ...selectedNode.transform.scale, y: v } })} />
              <NumberInput value={selectedNode.transform.scale.z} onChange={(v) => updateNodeTransform(selectedNode.id, { scale: { ...selectedNode.transform.scale, z: v } })} />
            </PropertyRow>
            <PropertyRow label="Rotation (Quaternion X, Y, Z, W)">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <NumberInput value={selectedNode.transform.rotation.x} step={0.01} onChange={(v) => updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, x: v } })} />
                <NumberInput value={selectedNode.transform.rotation.y} step={0.01} onChange={(v) => updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, y: v } })} />
                <NumberInput value={selectedNode.transform.rotation.z} step={0.01} onChange={(v) => updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, z: v } })} />
                <NumberInput value={selectedNode.transform.rotation.w} step={0.01} onChange={(v) => updateNodeTransform(selectedNode.id, { rotation: { ...selectedNode.transform.rotation, w: v } })} />
              </div>
            </PropertyRow>
          </Category>
        </>
      )}
    </div>
  )
}

function EffectControl({ label, effect, defaultValue, step, media, hasValue = true }) {
  const updateClipEffect = useEditorStore((s) => s.updateClipEffect)
  const data = media.effects?.[effect] || {}
  const enabled = data.enabled ?? false
  const value = data.value ?? defaultValue

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const isEnabled = e.target.checked
            const update = { enabled: isEnabled }
            if (isEnabled && !hasValue) update.value = 1
            updateClipEffect({ timelineId: media.id, effect, ...update })
          }}
        />
        <span style={{ opacity: enabled ? 1 : 0.7 }}>{label}</span>
      </label>
      {hasValue && (
        <div style={{ width: 60, opacity: enabled ? 1 : 0.5, pointerEvents: enabled ? 'auto' : 'none' }}>
          <NumberInput
            step={step}
            value={value}
            onChange={(v) => updateClipEffect({ timelineId: media.id, effect, value: v })}
          />
        </div>
      )}
    </div>
  )
}
