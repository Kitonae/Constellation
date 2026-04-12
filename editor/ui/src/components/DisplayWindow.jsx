import React, { useEffect, useMemo, useState } from 'react'
import { resolveImageSrc } from './MediaThumb.jsx'
import { resolveFileUrl } from '../utils/videoUtils.js'
import { computeRenderList, computeItemLayout } from '../media/renderer.js'

export default function DisplayWindow() {
  const params = new URLSearchParams(window.location.search)
  const screenId = params.get('screenId') || ''
  const width = parseInt(params.get('w') || `${window.innerWidth}`, 10)
  const height = parseInt(params.get('h') || `${window.innerHeight}`, 10)
  const [snapshot, setSnapshot] = useState(null)
  const [playTime, setPlayTime] = useState(0)
  const [imageMeta, setImageMeta] = useState({})
  const videoRefs = React.useRef(new Map())
  const getVideoRef = (id) => {
    if (!videoRefs.current.has(id)) videoRefs.current.set(id, React.createRef())
    return videoRefs.current.get(id)
  }

  useEffect(() => {
    const handleMessage = (ev) => {
      const { event, payload } = ev.data || {}
      if (event === 'display:snapshot') {
        const p = payload || {}
        let newSnap = p
        if (p.raw && !p.project && !p.scene) {
          try {
            const js = JSON.parse(p.raw)
            newSnap = { project: js.project, scene: js.scene, time: p.time }
          } catch {
            newSnap = { project: null, scene: null, time: p.time }
          }
        }
        setSnapshot(prev => {
          const nextProj = newSnap.project
          if (nextProj && nextProj.media === undefined && prev?.project?.media) {
            nextProj.media = prev.project.media
          }
          return newSnap
        })
        setPlayTime(Number(p.time || 0))
      } else if (event === 'display:time') {
        setPlayTime(Number((payload && payload.time) || 0))
      } else if (event === 'display:close') {
        const sid = payload && payload.screenId
        if (!sid || sid === screenId) {
          try { window.close() } catch { }
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [screenId])

  // Compute render list via media pipeline (auto-migrates legacy data)
  const renderItems = useMemo(() => {
    if (!snapshot?.project) return []
    return computeRenderList(snapshot.project.timeline, snapshot.project.media, playTime)
  }, [snapshot, playTime])

  // Sync video elements to playback time using sourceTime from render list
  useEffect(() => {
    videoRefs.current.forEach((ref, id) => {
      const vid = ref.current
      if (!vid) return
      const item = renderItems.find(r => r.clipId === id)
      if (!item) return
      const st = item.sourceTime || 0
      try { if (Math.abs((vid.currentTime || 0) - st) > 0.03) vid.currentTime = st } catch { }
    })
  }, [playTime, renderItems])

  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const item of renderItems) {
        if (imageMeta[item.assetId]) continue
        const uriStr = String(item.asset?.uri || item.src || '')
        if (item.mediaType === 'video') {
          if (!uriStr.startsWith('blob:')) {
            try {
              const { getVideoMetadata } = await import('../utils/videoUtils.js')
              const meta = await getVideoMetadata(item.asset?.uri || uriStr)
              if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { w: meta.width || 1920, h: meta.height || 1080, src: null } }))
            } catch {
              if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { w: 1920, h: 1080, src: null } }))
            }
          } else {
            if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { w: 1920, h: 1080, src: null } }))
          }
          continue
        }
        let src = await resolveImageSrc(item.asset?.uri || uriStr)
        if (!src && uriStr.startsWith('file://')) src = resolveFileUrl(item.asset?.uri || uriStr)
        if (cancelled || !src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => { if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { w: img.naturalWidth, h: img.naturalHeight, src } })); resolve() }
          img.onerror = () => resolve()
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [renderItems, imageMeta])

  return (
    <div style={{ position: 'relative', width, height, background: '#000', overflow: 'hidden' }}>
      {renderItems.map((item) => {
        const meta = imageMeta[item.assetId]
        const naturalSize = meta ? { w: meta.w, h: meta.h } : null
        const layout = computeItemLayout(item, width, height, naturalSize)

        return (
          <div key={item.clipId} style={{ position: 'absolute', left: layout.left, top: layout.top, width: layout.width, height: layout.height, overflow: 'hidden', opacity: item.opacity, filter: item.filter }}>
            {item.mediaType === 'video' ? (
              <VideoFrame clip={item.asset} refEl={getVideoRef(item.clipId)} style={{ width: '100%', height: '100%' }} />
            ) : meta?.src ? (
              <img src={meta.src} alt={item.asset?.name || item.assetId} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
            ) : null}
          </div>
        )
      })}
      <DebugOverlay items={renderItems} imageMeta={imageMeta} container={{ width, height }} time={playTime || 0} />
    </div>
  )
}

function VideoFrame({ clip, refEl, style }) {
  useEffect(() => {
    try {
      const uri = String(clip?.uri || '')
      if (!refEl?.current) return
      if (/^blob:/.test(uri)) return
      if (/^data:/.test(uri) || /^https?:/.test(uri)) {
        refEl.current.src = uri
        return
      }
      refEl.current.src = resolveFileUrl(uri)
    } catch { }
  }, [clip?.uri, refEl])
  return <video ref={refEl} muted playsInline preload="auto" crossOrigin="anonymous" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', ...style }} />
}

function DebugOverlay({ items, imageMeta, container, time }) {
  const lines = items.map((item, idx) => {
    const meta = imageMeta[item.assetId]
    const naturalSize = meta ? { w: meta.w, h: meta.h } : null
    const layout = computeItemLayout(item, container.width, container.height, naturalSize)
    return `${idx + 1}. ${item.asset?.name || item.assetId} x=${layout.left.toFixed(1)} y=${layout.top.toFixed(1)} w=${layout.width.toFixed(1)} h=${layout.height.toFixed(1)}`
  })
  return (
    <div style={{ position: 'absolute', top: 4, left: 4, padding: '6px 8px', background: '#0f1115cc', border: '1px solid #232636', borderRadius: 4, fontSize: 11, lineHeight: 1.3, color: '#c7cfdb', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', maxWidth: '40%', pointerEvents: 'none', whiteSpace: 'pre' }}>
      {`Time: ${time.toFixed(3)}s\nMedia (${lines.length}):\n${lines.join('\n')}`}
    </div>
  )
}
