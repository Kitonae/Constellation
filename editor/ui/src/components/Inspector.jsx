import React, { useState } from 'react'
import { useEditorStore } from '../store.js'
import { selectSelectionSummary, selectedNode, findTimelineItem, assetOf, findAsset } from '../selectors.js'
import ScreenSection from './inspector/ScreenSection.jsx'
import ClipSection from './inspector/ClipSection.jsx'
import MultiClipSection from './inspector/MultiClipSection.jsx'
import NodeTransformSection from './inspector/NodeTransformSection.jsx'
import ModelSection from './inspector/ModelSection.jsx'
import MediaAssetSection from './inspector/MediaAssetSection.jsx'
import HistoryPanel from './inspector/HistoryPanel.jsx'

const TABS = [
  { id: 'properties', icon: 'tune', label: 'Properties' },
  { id: 'history', icon: 'history', label: 'History' },
]

/**
 * The right-hand panel.
 *
 * Dispatches on one selection summary rather than three independent
 * conditionals: a screen node and a clip could both be "selected" at once,
 * and the panel would stack Screen Settings, Transform, Timing, Appearance,
 * Effects and Node Transform in a single column.
 */
function Inspector() {
  const [tab, setTab] = useState('properties')
  const summary = useEditorStore(selectSelectionSummary)
  const node = useEditorStore(selectedNode)
  const project = useEditorStore((s) => s.project)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-inset)', color: 'var(--text)' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flex: '0 0 auto' }} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.05em', border: 'none', borderRadius: 0,
              background: tab === t.id ? 'var(--bg-elevated)' : 'transparent',
              color: tab === t.id ? 'var(--text-strong)' : 'var(--text-muted)',
              borderBottom: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            <span className="ms" style={{ fontSize: 16 }} aria-hidden="true">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'history'
        ? <HistoryPanel />
        : <PropertiesTab summary={summary} node={node} project={project} />}
    </div>
  )
}

function PropertiesTab({ summary, node, project }) {
  if (summary.kind === 'none') {
    return <div style={{ padding: 16, opacity: 0.6, textAlign: 'center', fontSize: 13 }}>No selection</div>
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      {summary.kind === 'node' && node && (
        <>
          {node.kind?.type === 'screen' && <ScreenSection node={node} />}
          {node.kind?.type === 'model' && <ModelSection node={node} />}
          <NodeTransformSection node={node} />
        </>
      )}

      {summary.kind === 'clips' && summary.count > 1 && <MultiClipSection ids={summary.ids} />}

      {summary.kind === 'clips' && summary.count === 1 && (() => {
        const found = findTimelineItem(project, summary.ids[0])
        if (!found) return <div style={{ padding: 16, opacity: 0.6, fontSize: 13 }}>Clip not found</div>
        return <ClipSection tm={found.tm} asset={assetOf(project, found.tm)} />
      })()}

      {summary.kind === 'media' && (() => {
        const asset = findAsset(project, summary.ids[0])
        return asset ? <MediaAssetSection asset={asset} /> : null
      })()}
    </div>
  )
}

// Memoized: the Inspector is expensive and App re-renders on panel resize.
export default React.memo(Inspector)
