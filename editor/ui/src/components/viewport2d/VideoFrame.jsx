import React, { useEffect, useState } from 'react'

/** A poster frame for a video clip on the stage. */
export default function VideoFrame({ clip, style }) {
  const [thumb, setThumb] = useState(null)
  const uri = String(clip?.uri || '')

  useEffect(() => {
    let cancelled = false
    async function loadThumb() {
      try {
        const { generateVideoThumbnail } = await import('../../utils/videoUtils.js')
        const dataUrl = await generateVideoThumbnail(uri, 0)
        if (!cancelled) setThumb(dataUrl)
      } catch { }
    }
    if (uri) loadThumb()
    return () => { cancelled = true }
  }, [uri])

  if (thumb) {
    return <img src={thumb} alt={clip?.name || ''} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', ...style }} />
  }
  return <span style={{ padding: '0 4px', color: 'var(--text-muted)', fontSize: 11, userSelect: 'none', ...style }}>{clip?.name || 'video'}</span>
}
