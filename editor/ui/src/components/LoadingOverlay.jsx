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
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 20, width: 400, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
          <div style={{ marginBottom: 12, fontWeight: 600, color: 'var(--text-strong)' }}>Importing Media...</div>
          <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {filename || 'Preparing...'}
          </div>
          <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.1s linear' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{current} / {total}</div>
            <button
              onClick={cancelImport}
              style={{ background: 'transparent', border: '1px solid var(--border-subtle)', color: 'var(--text)', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}
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
      <div style={{ background: 'var(--bg-primary-alpha)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner size={14} />
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Importing media…</div>
      </div>
    </div>
  )
}

