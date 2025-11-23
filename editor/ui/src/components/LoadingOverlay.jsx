import React from 'react'
import { useEditorStore } from '../store.js'
import Spinner from './Spinner.jsx'

export default function LoadingOverlay() {
  const importing = useEditorStore((s) => s.importingMediaCount || 0)
  const progress = useEditorStore((s) => s.importProgress)
  const cancelImport = useEditorStore((s) => s.cancelImport)

  if (progress) {
    const { current, total, filename } = progress
    const pct = total > 0 ? (current / total) * 100 : 0
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#141821', border: '1px solid #232636', borderRadius: 8, padding: 20, width: 400, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
          <div style={{ marginBottom: 12, fontWeight: 600, color: '#fff' }}>Importing Media...</div>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#b9c3d6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {filename || 'Preparing...'}
          </div>
          <div style={{ height: 6, background: '#232636', borderRadius: 3, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: '#5a78ff', transition: 'width 0.1s linear' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: '#8996a8' }}>{current} / {total}</div>
            <button
              onClick={cancelImport}
              style={{ background: 'transparent', border: '1px solid #3a4060', color: '#c7cfdb', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!importing) return null
  return (
    <div style={{ position: 'fixed', top: 8, right: 8, zIndex: 1000, pointerEvents: 'none' }}>
      <div style={{ background: '#0f1115cc', border: '1px solid #232636', borderRadius: 6, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner size={14} />
        <div style={{ fontSize: 12, color: '#b9c3d6' }}>Importing media…</div>
      </div>
    </div>
  )
}

