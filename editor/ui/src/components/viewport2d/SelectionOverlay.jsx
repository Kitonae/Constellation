import React from 'react'
import { useEditorStore } from '../../store.js'
import { findMediaAssetByTimelineItem } from '../../project/projectCodec.js'

export function SelectionOverlay({ nodes, nodeIndex, selectedId, selectedClipId }) {
  let text = ''
  if (selectedClipId) {
    try {
      const proj = useEditorStore.getState().project
      const mediaEntry = findMediaAssetByTimelineItem(proj, selectedClipId)
      text = mediaEntry?.name || mediaEntry?.id || selectedClipId
    } catch { text = selectedClipId }
  } else if (selectedId) {
    const n = nodeIndex.get(selectedId)
    if (n) {
      const prefix = n.kind?.type === 'screen'
        ? `Screen (${n.kind?.screenType || 'web'})`
        : 'Node'
      text = `${prefix}: ${n.name || n.id}`
    }
  }
  if (!text) return null
  return (
    <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 10, pointerEvents: 'none', padding: '2px 6px', fontSize: 12, color: '#b9c3d6', background: '#0f1115cc', border: '1px solid #232636', borderRadius: 4 }}>
      {text}
    </div>
  )
}
