import React from 'react'
import { useEditorStore } from '../../store.js'
import Category from './Category.jsx'
import PropertyRow, { TextInput } from './PropertyRow.jsx'
import NumberInput from './NumberInput.jsx'
import { FIELD, RESOLUTION_PRESETS } from './constants.js'

/** Properties of a selected screen node. */
export default function ScreenSection({ node }) {
  const updateScreenPixels = useEditorStore((s) => s.updateScreenPixels)
  const updateScreenEnabled = useEditorStore((s) => s.updateScreenEnabled)
  const updateScreenType = useEditorStore((s) => s.updateScreenType)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)
  const renameNode = useEditorStore((s) => s.renameNode)

  const px = node.kind?.pixels?.[0] || 0
  const py = node.kind?.pixels?.[1] || 0
  const pos = node.transform?.position || { x: 0, y: 0, z: 0 }
  const presetIndex = RESOLUTION_PRESETS.findIndex((p) => p.w === px && p.h === py)

  const setPos = (patch) => updateNodeTransform(node.id, { position: { ...pos, ...patch } }, 'Move Screen')

  return (
    <Category title="Screen">
      <PropertyRow label="Name">
        <TextInput value={node.name || ''} placeholder={node.id} onCommit={(v) => renameNode(node.id, v)} />
      </PropertyRow>

      <PropertyRow label="Type">
        <select
          value={node.kind?.screenType || 'web'}
          onChange={(e) => updateScreenType(node.id, e.target.value)}
          style={{ width: '100%' }}
        >
          <option value="web">Web</option>
          <option value="renderer">Renderer</option>
        </select>
      </PropertyRow>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', fontSize: 12 }}>
        <input type="checkbox" checked={node.kind?.enabled ?? true} onChange={(e) => updateScreenEnabled(node.id, e.target.checked)} />
        Enabled
      </label>

      {/* A named list first: an output resolution is almost always a
          standard one, and typing 3840 by hand invites typos that close and
          reopen the output window. */}
      <PropertyRow label="Resolution">
        <select
          value={presetIndex}
          onChange={(e) => {
            const i = Number(e.target.value)
            if (i < 0) return
            const p = RESOLUTION_PRESETS[i]
            updateScreenPixels(node.id, [p.w, p.h])
          }}
          style={{ width: '100%' }}
        >
          {presetIndex === -1 && <option value={-1}>Custom ({px} × {py})</option>}
          {RESOLUTION_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
      </PropertyRow>

      <PropertyRow>
        <NumberInput prefix="W" {...FIELD.screenPixels} value={px} scrubLabel="Resize Screen"
          onChange={(v) => updateScreenPixels(node.id, [Math.round(v), py])} />
        <NumberInput prefix="H" {...FIELD.screenPixels} value={py} scrubLabel="Resize Screen"
          onChange={(v) => updateScreenPixels(node.id, [px, Math.round(v)])} />
      </PropertyRow>

      <PropertyRow label="Stage Position">
        <NumberInput prefix="X" {...FIELD.nodePosition} value={pos.x ?? 0} scrubLabel="Move Screen" onChange={(v) => setPos({ x: v })} />
        <NumberInput prefix="Y" {...FIELD.nodePosition} value={pos.y ?? 0} scrubLabel="Move Screen" onChange={(v) => setPos({ y: v })} />
      </PropertyRow>

      {(node.kind?.screenType || 'web') === 'renderer' && <RendererStatusRow screenId={node.id} />}
    </Category>
  )
}

const STATE_COLOR = {
  ready: 'var(--success)',
  open: 'var(--success)',
  launching: 'var(--warn)',
  error: 'var(--error)',
  blocked: 'var(--error)',
}

/**
 * Live status of a renderer output.
 *
 * Reads the shared `outputs` slice that App polls once for every renderer,
 * rather than running its own 2-second loop for whichever screen happened to
 * be selected. The error text is shown: it was in the payload all along, but
 * the UI only ever rendered a red dot and the word "error".
 */
function RendererStatusRow({ screenId }) {
  const status = useEditorStore((s) => s.outputs[screenId])
  const requestScreenReopen = useEditorStore((s) => s.requestScreenReopen)
  const state = status?.state || 'stopped'
  const fps = status?.fps || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLOR[state] || 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ opacity: 0.8 }}>Renderer: {state}</span>
        {fps > 0 && <span style={{ opacity: 0.6 }}>{fps.toFixed(1)} FPS</span>}
        <button type="button" className="btn btn--ghost" style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
          onClick={() => requestScreenReopen(screenId)}>
          Relaunch
        </button>
      </div>
      {status?.error && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--error)', wordBreak: 'break-word', lineHeight: 1.4 }}>
          {status.error}
        </div>
      )}
    </div>
  )
}
