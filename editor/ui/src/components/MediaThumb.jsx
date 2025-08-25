import React, { useEffect, useMemo, useState } from 'react'
import Spinner from './Spinner.jsx'

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  // Basic video types for hinting when needed
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
}

function extFromUri(uri) {
  try {
    const u = String(uri)
    const q = u.split('?')[0]
    const p = q.split('#')[0]
    const s = p.split('.')
    return (s[s.length - 1] || '').toLowerCase()
  } catch { return '' }
}

function u8ToBase64(u8) {
  // Chunk to avoid call stack limits on large files
  let res = ''
  const chunk = 0x8000
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk)
    res += String.fromCharCode.apply(null, sub)
  }
  return btoa(res)
}

function base64ToU8(b64) {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

export async function resolveImageSrc(uri, mimeHint = 'image/*') {
  if (!uri) return null
  const u = String(uri)
  if (u.startsWith('data:')) return u
  if (u.startsWith('file://')) {
    // Build a filesystem path portable across platforms
    try {
      const url = new URL(u)
      let p = decodeURI(url.pathname)
      // On Windows, pathname like "/C:/..." -> strip leading slash
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      if (typeof window !== 'undefined' && window.__TAURI__) {
        // In dev (http dev server), avoid convertFileSrc to prevent asset.localhost 403s.
        const isDevHttp = typeof location !== 'undefined' && /^https?:/.test(location.protocol)
        if (!isDevHttp) {
          try {
            const { convertFileSrc } = await import('@tauri-apps/api/tauri')
            const src = convertFileSrc(p)
            if (src) return src
          } catch {}
        }
        // Inline as data URL (works in dev/prod and avoids 403s)
        try {
          const { readBinaryFile } = await import('@tauri-apps/api/fs')
          const data = await readBinaryFile(p)
          const b64 = u8ToBase64(Uint8Array.from(data))
          const ext = extFromUri(u)
          const mime = MIME_BY_EXT[ext] || mimeHint || 'image/*'
          return `data:${mime};base64,${b64}`
        } catch {
          return null
        }
      }
      // Fallback for non-Tauri web: browsers generally block file://; return null
      // so callers can show a placeholder.
      return null
    } catch {
      return null
    }
  }
  return u
}

export async function inlineFromUri(uri, mimeHint = 'image/*') {
  try {
    const u = String(uri)
    if (!u.startsWith('file://')) return null
    const url = new URL(u)
    let p = decodeURI(url.pathname)
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    const { readBinaryFile } = await import('@tauri-apps/api/fs')
    const data = await readBinaryFile(p)
    const b64 = u8ToBase64(Uint8Array.from(data))
    const ext = extFromUri(u)
    const mime = MIME_BY_EXT[ext] || mimeHint || 'image/*'
    return `data:${mime};base64,${b64}`
  } catch { return null }
}

function isVideoExt(ext) {
  return ['mp4','mov','webm','mkv','avi','m4v','mpg','mpeg'].includes(ext)
}

export default function MediaThumb({ uri, size = 48, alt = '', fill = false }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const ext = useMemo(() => extFromUri(uri), [uri])
  const isVideo = useMemo(() => isVideoExt(ext), [ext])
  const mime = useMemo(() => MIME_BY_EXT[ext] || (isVideo ? 'video/*' : 'image/*'), [ext, isVideo])
  const [triedInlineFallback, setTriedInlineFallback] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    setLoaded(false)
    
    async function load() {
      if (isVideo) {
        // Attempt to load cached PNG thumbnail for video; if missing, generate and write to cache
        try {
          if (typeof window !== 'undefined' && window.__TAURI__ && String(uri).startsWith('file://')) {
            const url = new URL(String(uri))
            let p = decodeURI(url.pathname)
            if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
            const parts = p.split(/[\\\/]+/).filter(Boolean)
            const filename = parts.pop() || 'vid'
            const base = filename.split('.')[0]
            const thumbName = `${base}.thumb.png`
            const { join } = await import('@tauri-apps/api/path')
            const { exists, BaseDirectory, writeBinaryFile } = await import('@tauri-apps/api/fs')
            const rel = await join('media-cache', thumbName)
            const has = await exists(rel, { dir: BaseDirectory.AppCache })
            if (has) {
              // Use convertFileSrc to load cached thumbnail
              try {
                const { appCacheDir } = await import('@tauri-apps/api/path')
                const cacheDir = await appCacheDir()
                const full = await join(cacheDir, thumbName)
                const { convertFileSrc } = await import('@tauri-apps/api/tauri')
                setSrc(convertFileSrc(full))
                return
              } catch {}
            }
            // Generate thumbnail via <video> + <canvas>
            const { convertFileSrc } = await import('@tauri-apps/api/tauri')
            const videoSrc = convertFileSrc(p)
            await new Promise((resolve) => setTimeout(resolve, 0))
            const video = document.createElement('video')
            video.src = videoSrc
            video.muted = true
            video.playsInline = true
            video.crossOrigin = 'anonymous'
            video.preload = 'auto'
            const gotFrame = await new Promise((resolve) => {
              const onReady = async () => {
                try {
                  // Seek to a tiny offset to ensure a decodable frame
                  if (video.readyState < 2) {
                    try { video.currentTime = 0.05 } catch {}
                  }
                  const handler = () => resolve(true)
                  video.addEventListener('seeked', handler, { once: true })
                  try { video.currentTime = Math.max(0.01, Math.min(0.3, video.duration ? 0.05 : 0.05)) } catch { resolve(false) }
                } catch { resolve(false) }
              }
              if (video.readyState >= 2) onReady(); else video.addEventListener('loadeddata', onReady, { once: true })
              video.addEventListener('error', () => resolve(false), { once: true })
            })
            if (gotFrame) {
              const vw = video.videoWidth || 320
              const vh = video.videoHeight || 180
              const target = fill ? [size, size] : [size, size]
              const scale = Math.min(target[0] / vw, target[1] / vh)
              const cw = Math.max(1, Math.round(vw * scale))
              const ch = Math.max(1, Math.round(vh * scale))
              const canvas = document.createElement('canvas')
              canvas.width = cw
              canvas.height = ch
              const ctx = canvas.getContext('2d')
              ctx.drawImage(video, 0, 0, cw, ch)
              const dataUrl = canvas.toDataURL('image/png')
              setSrc(dataUrl)
              try {
                const b64 = dataUrl.split(',')[1]
                const bytes = base64ToU8(b64)
                await writeBinaryFile({ contents: bytes, path: rel }, { dir: BaseDirectory.AppCache })
              } catch {}
              return
            }
          }
        } catch {}
        // Fallback: simple video badge remains
        setSrc(null)
        return
      }
      const resolved = await resolveImageSrc(uri, mime)
      if (cancelled) return
      setSrc(resolved)
    }
    load()
    return () => { cancelled = true }
  }, [uri, mime])

  return (
    <div style={{
      width: fill ? '100%' : size,
      height: fill ? '100%' : size,
      background: '#0f1115',
      border: '1px solid #232636',
      borderRadius: 4,
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
    }}>
      {isVideo ? (
        src ? (
          <img
            src={src}
            alt={alt}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span style={{ fontSize: 11, color: '#c7cfdb', opacity: 0.9 }}>Video</span>
        )
      ) : src && !error ? (
        loaded ? (
          <img
            src={src}
            alt={alt}
            onLoad={() => setLoaded(true)}
            onError={async () => {
              // Attempt inline fallback on asset protocol 403s
              if (window.__TAURI__ && !triedInlineFallback) {
                setTriedInlineFallback(true)
                const inlined = await inlineFromUri(uri, mime)
                if (inlined) { setSrc(inlined); setLoaded(false); return }
              }
              setError(true)
            }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          // Show spinner while the image source is resolving or loading
          <>
            <Spinner size={16} />
            {/* Preload image invisibly to detect onLoad */}
            <img
              src={src}
              alt={alt}
              onLoad={() => setLoaded(true)}
              onError={async () => {
                if (window.__TAURI__ && !triedInlineFallback) {
                  setTriedInlineFallback(true)
                  const inlined = await inlineFromUri(uri, mime)
                  if (inlined) { setSrc(inlined); setLoaded(false); return }
                }
                setError(true)
              }}
              style={{ display: 'none' }}
            />
          </>
        )
      ) : (
        <Spinner size={16} />
      )}
    </div>
  )
}
