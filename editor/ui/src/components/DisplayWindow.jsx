import React, { useEffect, useMemo, useState } from 'react'
import { resolveImageSrc } from './MediaThumb.jsx'
import { resolveFileUrl } from '../utils/videoUtils.js'
import { computeRenderList, computeItemLayout, screenOffset } from '../media/renderer.js'

export default function DisplayWindow() {
  const params = new URLSearchParams(window.location.search)
  const screenId = params.get('screenId') || ''
  const width = parseInt(params.get('w') || `${window.innerWidth}`, 10)
  const height = parseInt(params.get('h') || `${window.innerHeight}`, 10)
  // ?debug=1 turns the overlay on; it used to be unconditional, so every
  // output window shipped a debug HUD to the audience.
  const showDebug = params.get('debug') === '1'
  const [snapshot, setSnapshot] = useState(null)
  const [playTime, setPlayTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [imageMeta, setImageMeta] = useState({})
  const videoRefs = React.useRef(new Map())
  const getVideoRef = (id) => {
    if (!videoRefs.current.has(id)) videoRefs.current.set(id, React.createRef())
    return videoRefs.current.get(id)
  }

  // The playhead this window advances on its own.
  //
  // The editor sends an anchor -- a position, whether it is moving, and the
  // moment that was true -- and this window integrates from it at its own
  // refresh rate. Before, the editor posted a position twenty times a second
  // and the window did nothing in between, so an occluded editor, which
  // paints no frames, froze every output it had opened.
  const anchorRef = React.useRef({ time: 0, playing: false, rate: 1, at: 0, seq: 0 })

  useEffect(() => {
    const setAnchor = (next) => {
      if (!next) return
      const seq = Number(next.seq)
      // Corrections are latest-wins on this channel too, so one that lost a
      // race would otherwise drag the playhead backwards.
      if (Number.isFinite(seq) && seq > 0 && seq < anchorRef.current.seq) return
      const time = Number(next.time)
      const rate = Number(next.rate)
      anchorRef.current = {
        time: Number.isFinite(time) ? time : 0,
        playing: !!next.playing,
        rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
        at: performance.now(),
        seq: Number.isFinite(seq) ? seq : anchorRef.current.seq,
      }
      setPlayTime(anchorRef.current.time)
      setPlaying(anchorRef.current.playing)
    }

    const handleMessage = (ev) => {
      // Only the editor that opened this window may drive it. Comparing the
      // source window rather than the origin is what works here: the editor
      // runs on the Wails origin while this page is served by the sidecar.
      if (window.opener && ev.source !== window.opener) return
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
        // A snapshot carries the transport as well, which is what lets a
        // window opened mid-show start in the right place and moving.
        setAnchor({ time: p.time, playing: p.playing ?? anchorRef.current.playing, rate: 1 })
      } else if (event === 'display:transport') {
        setAnchor(payload)
      } else if (event === 'display:close') {
        const sid = payload && payload.screenId
        if (!sid || sid === screenId) {
          try { window.close() } catch { }
        }
      }
    }
    window.addEventListener('message', handleMessage)
    // Tell the editor we are listening. It answers with a snapshot; without
    // this the opener had to guess with a 500 ms timer.
    try { window.opener?.postMessage({ event: 'display:ready', payload: { screenId } }, '*') } catch { }
    return () => window.removeEventListener('message', handleMessage)
  }, [screenId])

  // Advance the local playhead while the show runs.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const a = anchorRef.current
      if (a.playing) {
        setPlayTime(a.time + ((performance.now() - a.at) / 1000) * a.rate)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // Compute render list via media pipeline (auto-migrates legacy data)
  const renderItems = useMemo(() => {
    if (!snapshot?.project) return []
    return computeRenderList(snapshot.project.timeline, snapshot.project.media, playTime)
  }, [snapshot, playTime])

  // Sync video elements to playback time using sourceTime from render list.
  //
  // While playing, let the element play and only correct real drift: setting
  // currentTime on every 20 Hz update meant the video was scrubbed 20 times a
  // second and never actually played.
  useEffect(() => {
    videoRefs.current.forEach((ref, id) => {
      const vid = ref.current
      if (!vid) return
      const item = renderItems.find(r => r.clipId === id)
      if (!item) return
      const st = item.sourceTime || 0
      try {
        if (playing) {
          if (vid.paused) vid.play().catch(() => { })
          if (Math.abs((vid.currentTime || 0) - st) > 0.25) vid.currentTime = st
        } else {
          if (!vid.paused) vid.pause()
          if (Math.abs((vid.currentTime || 0) - st) > 0.03) vid.currentTime = st
        }
      } catch { }
    })
  }, [playTime, playing, renderItems])

  useEffect(() => {
    let cancelled = false
    async function ensureMeta() {
      for (const item of renderItems) {
        const uriStr = String(item.asset?.uri || item.src || '')
        // Keyed by asset id, but only current while the URI matches:
        // relinking keeps the id and changes the URI.
        if (imageMeta[item.assetId]?.uri === uriStr) continue
        if (item.mediaType === 'video') {
          if (!uriStr.startsWith('blob:')) {
            try {
              const { getVideoMetadata } = await import('../utils/videoUtils.js')
              const meta = await getVideoMetadata(item.asset?.uri || uriStr)
              if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { uri: uriStr, w: meta.width || 1920, h: meta.height || 1080, src: null } }))
            } catch {
              if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { uri: uriStr, w: 1920, h: 1080, src: null } }))
            }
          } else {
            if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { uri: uriStr, w: 1920, h: 1080, src: null } }))
          }
          continue
        }
        let src = await resolveImageSrc(item.asset?.uri || uriStr)
        if (!src && uriStr.startsWith('file://')) src = resolveFileUrl(item.asset?.uri || uriStr)
        if (cancelled || !src) continue
        await new Promise((resolve) => {
          const img = new Image()
          img.onload = () => { if (!cancelled) setImageMeta(m => ({ ...m, [item.assetId]: { uri: uriStr, w: img.naturalWidth, h: img.naturalHeight, src } })); resolve() }
          img.onerror = () => resolve()
          img.src = src
        })
      }
    }
    ensureMeta()
    return () => { cancelled = true }
  }, [renderItems, imageMeta])

  // This window is one screen on the stage, and clips are placed in stage
  // space. Composing every screen around the stage origin put a clip
  // centred on a screen at X=500 five hundred pixels off; the native output
  // subtracts the screen's position, and so does this now.
  const offset = useMemo(() => screenOffset(snapshot?.scene, screenId), [snapshot, screenId])

  return (
    <div style={{ position: 'relative', width, height, background: '#000', overflow: 'hidden' }}>
      {renderItems.map((item) => {
        const meta = imageMeta[item.assetId]
        const naturalSize = meta ? { w: meta.w, h: meta.h } : null
        const layout = computeItemLayout(item, width, height, naturalSize, offset)

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
      {showDebug && <DebugOverlay items={renderItems} imageMeta={imageMeta} container={{ width, height }} time={playTime || 0} />}
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
