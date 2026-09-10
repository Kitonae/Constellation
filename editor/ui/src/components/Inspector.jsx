import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../store.js'
import { resolveImageSrc } from './MediaThumb.jsx'

/**
 * A number field that edits a local draft string and commits on blur or Enter.
 *
 * The previous fully-controlled version called parseFloat on every keystroke,
 * so clearing the field or typing a lone minus sign wrote NaN straight into
 * the document: a clip start became NaN and the clip vanished, and a
 * resolution field transiently became 0, which closed the output window. It
 * also produced one undo entry and one snapshot push per character.
 *
 * Escape reverts the draft, and the field never fights the user while focused.
 */
function NumberInput({ value, onChange, step = 0.1, min, max, style }) {
  const [text, setText] = useState(() => String(value ?? 0))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(String(value ?? 0))
  }, [value])

  const commit = () => {
    const n = parseFloat(text)
    if (!Number.isFinite(n)) { setText(String(value ?? 0)); return }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    setText(String(clamped))
    if (clamped !== value) onChange(clamped)
  }

  return (
    <input
      type="number"
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
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
      onFocus={(e) => { focused.current = true; e.target.style.borderColor = '#4a5568' }}
      onBlur={(e) => { focused.current = false; e.target.style.borderColor = '#232636'; commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur() }
        else if (e.key === 'Escape') { setText(String(value ?? 0)); e.currentTarget.blur() }
      }}
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

function Inspector() {
  const [tab, setTab] = useState('properties') // 'properties' | 'history'
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

  // A stored scale of 0 means "use the natural size", so the Size fields and
  // the aspect lock must resolve through naturalSize before doing any maths.
  const effectiveW = (selectedMedia?.scale?.x > 0) ? selectedMedia.scale.x : (naturalSize?.w ?? 0)
  const effectiveH = (selectedMedia?.scale?.y > 0) ? selectedMedia.scale.y : (naturalSize?.h ?? 0)

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

  const TabBar = (
    <div style={{ display: 'flex', borderBottom: '1px solid #232636', background: '#13151a' }}>
      {[
        { id: 'properties', icon: 'tune', label: 'Properties' },
        { id: 'history', icon: 'history', label: 'History' },
      ].map(t => (
        <button key={t.id} onClick={() => setTab(t.id)} style={{
          flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: 0.5, border: 'none', cursor: 'pointer',
          background: tab === t.id ? '#1b1e26' : 'transparent',
          color: tab === t.id ? '#e1e4e8' : '#6b7280',
          borderBottom: tab === t.id ? '2px solid #6aa0ff' : '2px solid transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        }}>
          <span className="ms" style={{ fontSize: 16 }}>{t.icon}</span>
          {t.label}
        </button>
      ))}
    </div>
  )

  if (tab === 'history') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#13151a', color: '#c7cfdb' }}>
        {TabBar}
        <HistoryPanel />
      </div>
    )
  }

  if (!selectedNode && !selectedMedia) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#13151a', color: '#c7cfdb' }}>
        {TabBar}
        <div style={{ padding: 16, opacity: 0.5, textAlign: 'center', fontSize: 13 }}>No selection</div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#13151a', color: '#c7cfdb' }}>
      {TabBar}
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
            <NumberInput step={1} min={1} value={selectedNode.kind?.pixels?.[0] || 0} onChange={(v) => updateScreenPixels(selectedNode.id, [v, selectedNode.kind?.pixels?.[1] || 0])} />
            <NumberInput step={1} min={1} value={selectedNode.kind?.pixels?.[1] || 0} onChange={(v) => updateScreenPixels(selectedNode.id, [selectedNode.kind?.pixels?.[0] || 0, v])} />
          </PropertyRow>
          {(selectedNode.kind?.screenType || 'web') === 'renderer' && (
            <RendererStatusRow screenId={selectedNode.id} />
          )}
        </Category>
      )}

      {selectedMedia && (
        <>
          <Category title="Transform">
            <PropertyRow label="Position (X, Y)">
              <NumberInput step={1} value={selectedMedia.position?.x ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, position: { x: Math.round(v) } })} />
              <NumberInput step={1} value={selectedMedia.position?.y ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, position: { y: Math.round(v) } })} />
            </PropertyRow>
            {/* A stored scale of 0 means "use the natural size of the media",
                so it has to fall through to naturalSize rather than display as
                0 and hand the aspect lock a 0/0 ratio. */}
            <PropertyRow label="Size (W, H)">
              <NumberInput
                step={1}
                min={1}
                value={effectiveW}
                onChange={(v) => {
                  const w = Math.max(1, Math.round(v))
                  if (keepAR) {
                    const ratio = effectiveW > 0 ? (effectiveH / effectiveW) : 1
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { x: w, y: Math.max(1, Math.round(w * ratio)) } })
                  } else {
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { x: w } })
                  }
                }}
              />
              <NumberInput
                step={1}
                min={1}
                value={effectiveH}
                onChange={(v) => {
                  const h = Math.max(1, Math.round(v))
                  if (keepAR) {
                    const ratio = effectiveH > 0 ? (effectiveW / effectiveH) : 1
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { x: Math.max(1, Math.round(h * ratio)), y: h } })
                  } else {
                    updateClipTransform({ timelineId: selectedMedia.id, scale: { y: h } })
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
              <NumberInput step={0.01} min={0} value={selectedMedia.start ?? selectedMedia.start_at_seconds ?? 0} onChange={(v) => useEditorStore.getState().updateClipStart({ timelineId: selectedMedia.id, startAt: v })} />
              <NumberInput step={0.01} min={0} value={selectedMedia.duration ?? Math.max(0, (selectedMedia.out_seconds - selectedMedia.in_seconds) || 0)} onChange={(v) => useEditorStore.getState().updateClipDuration({ timelineId: selectedMedia.id, duration: v })} />
            </PropertyRow>
            <PropertyRow label="Fade In / Out (s)">
              <NumberInput step={0.1} min={0} value={selectedMedia.fade_in ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, fade_in: v })} />
              <NumberInput step={0.1} min={0} value={selectedMedia.fade_out ?? 0} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, fade_out: v })} />
            </PropertyRow>
          </Category>

          <Category title="Appearance">
            <PropertyRow label="Opacity">
              <NumberInput step={0.1} min={0} max={1} value={selectedMedia.opacity ?? 1} onChange={(v) => updateClipTransform({ timelineId: selectedMedia.id, opacity: v })} />
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

      {selectedNode?.kind?.type === 'model' && (
        <Category title="Model">
          <PropertyRow label="File">
            <div style={{ fontSize: 12, wordBreak: 'break-all', opacity: 0.8 }}>
              {selectedNode.name || String(selectedNode.kind.uri || '').split(/[\\\/]/).pop() || 'Unknown'}
            </div>
          </PropertyRow>
        </Category>
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
    </div>
  )
}

const HISTORY_ICONS = {
  'Add Screen': 'desktop_windows',
  'Remove Screen': 'delete',
  'Move Screen': 'open_with',
  'Resize Screen': 'aspect_ratio',
  'Enable Screen': 'visibility',
  'Disable Screen': 'visibility_off',
  'Import Media': 'upload_file',
  'Add Track': 'playlist_add',
  'Move Clip': 'drag_indicator',
  'Resize Clip': 'photo_size_select_large',
  'Change Opacity': 'opacity',
  'Move Clip on Timeline': 'swap_horiz',
  'Resize Clip Duration': 'timelapse',
  'Reorder Clip': 'reorder',
  'Remove Clip from Timeline': 'playlist_remove',
  'Remove Media': 'delete_sweep',
  'Load Project': 'folder_open',
  'New Project': 'note_add',
  'Initial State': 'flag',
  'Edit Clip': 'edit',
}

function historyIcon(label) {
  // Exact match first
  if (HISTORY_ICONS[label]) return HISTORY_ICONS[label]
  // Prefix match
  for (const [key, icon] of Object.entries(HISTORY_ICONS)) {
    if (label.startsWith(key)) return icon
  }
  // Keyword match
  if (label.includes('Add') || label.includes('Import')) return 'add_circle'
  if (label.includes('Remove') || label.includes('Delete')) return 'delete'
  if (label.includes('Move')) return 'open_with'
  if (label.includes('Resize')) return 'aspect_ratio'
  if (label.includes('Change')) return 'tune'
  if (label.includes('Screen')) return 'desktop_windows'
  if (label.includes('Model')) return 'view_in_ar'
  if (label.includes('Image')) return 'image'
  return 'edit'
}

function HistoryPanel() {
  const undoStack = useEditorStore((s) => s._undoStack)
  const redoStack = useEditorStore((s) => s._redoStack)
  const currentLabel = useEditorStore((s) => s._currentLabel) || 'Initial State'
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const undoTo = useEditorStore((s) => s.undoTo)

  return (
    <div style={{ flex: 1, overflowY: 'auto', fontSize: 12 }}>
      {/* Redo stack (future states, grayed out, click to redo to) */}
      {redoStack.slice().reverse().map((entry, i) => {
        const realIdx = redoStack.length - 1 - i
        return (
          <div
            key={`redo-${realIdx}`}
            onClick={() => {
              for (let j = 0; j <= realIdx; j++) redo()
            }}
            style={{
              padding: '5px 12px',
              cursor: 'pointer',
              opacity: 0.35,
              borderLeft: '3px solid transparent',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#1b1e26'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <span className="ms" style={{ fontSize: 16, color: '#6b7280' }}>{historyIcon(entry.label)}</span>
            <span style={{ color: '#6b7280' }}>{entry.label}</span>
          </div>
        )
      })}

      {/* Current state marker */}
      <div style={{
        padding: '5px 12px',
        borderLeft: '3px solid #6aa0ff',
        background: '#1b1e26',
        fontWeight: 600,
        color: '#e1e4e8',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span className="ms" style={{ fontSize: 16, color: '#6aa0ff' }}>{historyIcon(currentLabel)}</span>
        {currentLabel}
      </div>

      {/* Undo stack (past states, newest first) */}
      {undoStack.slice().reverse().map((entry, i) => {
        const realIdx = undoStack.length - 1 - i
        return (
          <div
            key={`undo-${realIdx}`}
            onClick={() => undoTo(realIdx)}
            style={{
              padding: '5px 12px',
              cursor: 'pointer',
              opacity: 0.7,
              borderLeft: '3px solid transparent',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#1b1e26'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            <span className="ms" style={{ fontSize: 16, color: '#8898b8' }}>{historyIcon(entry.label)}</span>
            <span>{entry.label}</span>
          </div>
        )
      })}

      {undoStack.length === 0 && redoStack.length === 0 && (
        <div style={{ padding: 16, opacity: 0.5, textAlign: 'center' }}>No history yet</div>
      )}
    </div>
  )
}

function RendererStatusRow({ screenId }) {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      while (!cancelled) {
        try {
          const s = await window.go?.main?.App?.GetRendererStatus(screenId)
          if (!cancelled && s) setStatus(s)
        } catch { }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    poll()
    return () => { cancelled = true }
  }, [screenId])

  const state = status?.state || 'stopped'
  const fps = status?.fps || 0
  const stateColor = state === 'ready' ? '#4ade80' : state === 'launching' ? '#facc15' : state === 'error' ? '#f87171' : '#6b7280'

  return (
    <div style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor, flexShrink: 0 }} />
      <span style={{ opacity: 0.7 }}>Renderer: {state}</span>
      {fps > 0 && <span style={{ opacity: 0.5 }}>{fps.toFixed(1)} FPS</span>}
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

// Memoized: the Inspector is expensive and App re-renders on panel resize.
export default React.memo(Inspector)
