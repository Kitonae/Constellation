import React from 'react'
import { useEditorStore } from '../store.js'
import Spinner from './Spinner.jsx'

export default function LoadingOverlay() {
  const importing = useEditorStore((s) => s.importingMediaCount || 0)
  if (!importing) return null
  return (
    <div style={{ position:'fixed', top: 8, right: 8, zIndex: 1000, pointerEvents:'none' }}>
      <div style={{ background:'#0f1115cc', border:'1px solid #232636', borderRadius:6, padding:'6px 8px', display:'flex', alignItems:'center', gap:8 }}>
        <Spinner size={14} />
        <div style={{ fontSize:12, color:'#b9c3d6' }}>Importing media…</div>
      </div>
    </div>
  )
}

