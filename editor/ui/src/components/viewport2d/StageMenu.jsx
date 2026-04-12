import React, { useMemo } from 'react'
import { useEditorStore } from '../../store.js'

export function StageMenu({ onAddScreen, onRemoveClip, onRemoveScreen }) {
  const hasSelectedClip = useEditorStore((s) => !!s.selectedClipId)
  const selectedId = useEditorStore((s) => s.selectedId)
  const scene = useEditorStore((s) => s.scene)
  const isScreenSelected = useMemo(() => {
    if (!selectedId || !scene?.roots) return false
    const stack = [...scene.roots]
    while (stack.length) {
      const n = stack.pop()
      if (!n) continue
      if (n.id === selectedId) return n.kind?.type === 'screen'
      if (n.children?.length) stack.push(...n.children)
    }
    return false
  }, [selectedId, scene])
  return (
    <div>
      <MenuItem label="Add Web Screen" onClick={() => onAddScreen('web')} />
      <MenuItem label="Add Renderer Screen" onClick={() => onAddScreen('renderer')} />
      {hasSelectedClip && <MenuItem label="Remove Selected Clip" onClick={onRemoveClip} />}
      {isScreenSelected && <MenuItem label="Remove Screen" onClick={onRemoveScreen} />}
    </div>
  )
}

function MenuItem({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', color: '#c7cfdb', border: 'none', padding: '8px 12px', cursor: 'pointer' }}>
      {label}
    </button>
  )
}
