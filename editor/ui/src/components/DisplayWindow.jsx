import React, { useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { resolveImageSrc } from './MediaThumb.jsx'

export default function DisplayWindow() {
  const params = new URLSearchParams(window.location.search)
  const screenId = params.get('screenId') || ''
  const width = parseInt(params.get('w') || `${window.innerWidth}`, 10)
  const height = parseInt(params.get('h') || `${window.innerHeight}`, 10)
  const [snapshot, setSnapshot] = useState(null) // { project, scene, time }
  const [imageMeta, setImageMeta] = useState({})

  useEffect(() => {
    let unlisten
    listen('display:snapshot', (e) => {
      // Expect payload: { project, scene, time }
      setSnapshot(e.payload)
    }).then((u) => (unlisten = u))
    return () => { try { unlisten && unlisten() } catch {} }
  }, [])

  const active = useMemo(() => {
    if (!snapshot) return []
    const { project, scene, time } = snapshot
    const mediaById = Object.fromEntries((project?.media || []).map((m) => [m.id, m]))
    const nodeIndex = new Map()
    function walk(n) { if (!n) return; nodeIndex.set(n.id, n); (n.children||[]).forEach(walk) }
    ;(scene?.roots || []).forEach(walk)
    const res = []
    for (const t of project?.timeline?.tracks || []) {
      if (!t.media) continue
      const m = t.media
      if ((m.target_node_id || '') !== screenId) continue
      const start = m.start_at_seconds || 0
      const dur = Math.max(0, (m.out_seconds - m.in_seconds) || 0)
      if (time < start || time > start + dur) continue
      const clip = mediaById[m.clip_id]
      res.push({ tm: m, clip })
    }
    return res
  }, [snapshot, screenId])

  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const { clip, tm } of active) {
        if (!clip?.uri || imageMeta[tm.clip_id]) continue
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
        return (
          <div key={tm.clip_id} style={{ position:'absolute', left, top, width:w, height:h, overflow:'hidden' }}>
            {meta?.src ? (
              <img src={meta.src} alt={clip?.name || tm.clip_id} style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

