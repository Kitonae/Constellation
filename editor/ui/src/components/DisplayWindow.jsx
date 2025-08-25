import React, { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { resolveImageSrc } from './MediaThumb.jsx'

export default function DisplayWindow() {
  const params = new URLSearchParams(window.location.search)
  const screenId = params.get('screenId') || ''
  const width = parseInt(params.get('w') || `${window.innerWidth}`, 10)
  const height = parseInt(params.get('h') || `${window.innerHeight}`, 10)
  const [snapshot, setSnapshot] = useState(null) // { project, scene, time }
  const [playTime, setPlayTime] = useState(0)
  const [imageMeta, setImageMeta] = useState({})
  const videoRefs = React.useRef(new Map())
  const getVideoRef = (id) => {
    if (!videoRefs.current.has(id)) videoRefs.current.set(id, React.createRef())
    return videoRefs.current.get(id)
  }

  useEffect(() => {
    let unlistenSnap, unlistenTime
    listen('display:snapshot', (e) => {
      // Expect payload: { project, scene, time }
      setSnapshot(e.payload)
      setPlayTime(e.payload?.time || 0)
    }).then((u) => (unlistenSnap = u))
    listen('display:time', (e) => {
      // Expect payload: { time }
      setPlayTime(Number(e.payload?.time || 0))
    }).then((u) => (unlistenTime = u))
    return () => { try { unlistenSnap && unlistenSnap() } catch {} try { unlistenTime && unlistenTime() } catch {} }
  }, [])

  const active = useMemo(() => {
    if (!snapshot) return []
    const { project, scene } = snapshot
    const time = playTime
    const mediaById = Object.fromEntries((project?.media || []).map((m) => [m.id, m]))
    // No per-screen filtering; render all active clips
    const res = []
    for (const t of project?.timeline?.tracks || []) {
      if (!t.media) continue
      const m = t.media
      const start = (m.start ?? m.start_at_seconds) || 0
      const dur = Math.max(0, m.duration ?? ((m.out_seconds - m.in_seconds) || 0))
      if (time < start || time > start + dur) continue
      const clip = mediaById[m.clip_id]
      res.push({ tm: m, clip })
    }
    return res
  }, [snapshot, screenId])

  // Sync videos to playTime
  useEffect(() => {
    videoRefs.current.forEach((ref, id) => {
      const vid = ref.current
      if (!vid) return
      // Find clip by id
      const m = snapshot?.project?.timeline?.tracks?.map(t => t.media).find(mm => mm && mm.id === id)
      if (!m) return
      const start = (m.start ?? m.start_at_seconds) || 0
      const offset = Math.max(0, playTime - start)
      try { if (Math.abs((vid.currentTime || 0) - offset) > 0.03) vid.currentTime = offset } catch {}
    })
  }, [playTime, snapshot])

  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of active) {
        if (!clip?.uri || imageMeta[tm.clip_id]) continue
        const ext = String(clip.uri).split('?')[0].split('#')[0].split('.').pop().toLowerCase()
        if (['mp4','mov','webm','mkv','avi','m4v','mpg','mpeg'].includes(ext)) continue
        const src = await resolveImageSrc(clip.uri)
        if (cancelled || !src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => { if (!cancelled) setImageMeta((m) => ({ ...m, [tm.clip_id]: { w: img.naturalWidth, h: img.naturalHeight, src } })); resolve() }
          img.onerror = () => resolve()
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [active, imageMeta])

  return (
    <div style={{ position:'relative', width: width, height: height, background:'#000', overflow:'hidden' }}>
      {active.map(({ tm, clip }) => {
        const meta = imageMeta[tm.clip_id]
        const baseW = meta?.w || 100
        const baseH = meta?.h || 100
        const w = Math.max(2, (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW)
        const h = Math.max(2, (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH)
        const cx = width/2
        const cy = height/2
        const left = cx + (tm.position?.x || 0) - w/2
        const top = cy - (tm.position?.y || 0) - h/2
        const ext = String(clip?.uri || '').split('?')[0].split('#')[0].split('.').pop().toLowerCase()
        const isVideo = ['mp4','mov','webm','mkv','avi','m4v','mpg','mpeg'].includes(ext)
        return (
          <div key={tm.clip_id} style={{ position:'absolute', left, top, width:w, height:h, overflow:'hidden' }}>
            {isVideo ? (
              <VideoFrame clip={clip} refEl={getVideoRef(tm.id)} style={{ width:'100%', height:'100%' }} />
            ) : meta?.src ? (
              <img src={meta.src} alt={clip?.name || tm.clip_id} style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
            ) : null}
          </div>
        )
      })}
      {/* Debug overlay: timeline time + list of rendered media with position & size */}
      <DebugOverlay active={active} imageMeta={imageMeta} container={{ width, height }} time={playTime || 0} />
    </div>
  )
}

function VideoFrame({ clip, refEl, style }) {
  useEffect(() => {
    async function setSrc() {
      try {
        const uri = String(clip?.uri || '')
        if (!refEl?.current) return
        if (/^data:/.test(uri) || /^https?:/.test(uri)) {
          refEl.current.src = uri
          return
        }
        if (uri.startsWith('file://')) {
          if (typeof window === 'undefined' || !window.__TAURI__) return
          const url = new URL(uri)
          let p = decodeURI(url.pathname)
          if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
          const { convertFileSrc } = await import('@tauri-apps/api/tauri')
          const src = convertFileSrc(p)
          refEl.current.src = src
          return
        }
      } catch {}
    }
    setSrc()
  }, [clip?.uri, refEl])
  return <video ref={refEl} muted playsInline preload="auto" style={{ width:'100%', height:'100%', objectFit:'contain', display:'block', ...style }} />
}

function DebugOverlay({ active, imageMeta, container, time }) {
  // Build list of items with computed layout identical to render logic
  const lines = []
  const cx = container.width / 2
  const cy = container.height / 2
  active.forEach(({ tm, clip }, idx) => {
    const meta = imageMeta[tm.clip_id]
    const baseW = meta?.w || 100
    const baseH = meta?.h || 100
    const w = Math.max(2, (tm.scale?.x && tm.scale.x > 0) ? tm.scale.x : baseW)
    const h = Math.max(2, (tm.scale?.y && tm.scale.y > 0) ? tm.scale.y : baseH)
    const left = cx + (tm.position?.x || 0) - w/2
    const top = cy - (tm.position?.y || 0) - h/2
    lines.push(`${idx+1}. ${(clip?.name || tm.clip_id)} id=${tm.clip_id} x=${left.toFixed(1)} y=${top.toFixed(1)} w=${w.toFixed(1)} h=${h.toFixed(1)}`)
  })
  return (
    <div style={{ position:'absolute', top:4, left:4, padding:'6px 8px', background:'#0f1115cc', border:'1px solid #232636', borderRadius:4, fontSize:11, lineHeight:1.3, color:'#c7cfdb', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', maxWidth:'40%', pointerEvents:'none', whiteSpace:'pre' }}>
      {`Time: ${time.toFixed(3)}s\nMedia (${lines.length}):\n${lines.join('\n')}`}
    </div>
  )
}
