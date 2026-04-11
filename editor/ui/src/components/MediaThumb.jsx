import React, { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '../store.js'
import Spinner from './Spinner.jsx'
import { generateVideoThumbnail } from '../utils/videoUtils.js'

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
    // blob: and data: URLs don't contain a meaningful file extension
    if (u.startsWith('blob:') || u.startsWith('data:')) return ''
    const q = u.split('?')[0]
    const p = q.split('#')[0]
    const s = p.split('.')
    if (s.length < 2) return ''
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
  if (u.startsWith('blob:')) return u
  if (u.startsWith('file://')) {
    // Use the sidecar file server to serve the image via HTTP (no base64 copy)
    const { resolveUriSync } = await import('../media/uri.js')
    const resolved = resolveUriSync(u)
    return resolved || null
  }
  return u
}

export async function inlineFromUri(uri, mimeHint = 'image/*') {
  // (Tauri inline fallback removed)
  return null
}

function isVideoExt(ext) {
  return ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'].includes(ext)
}

function isModelExt(ext) {
  return ['gltf', 'glb', 'obj'].includes(ext)
}

export default React.memo(function MediaThumb({ uri, size = 48, alt = '', fill = false }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const ext = useMemo(() => {
    const e = extFromUri(uri)
    if (e) return e
    // Fallback: try to get extension from alt text (filename) if uri is a blob/data url
    return extFromUri(alt)
  }, [uri, alt])
  const isVideo = useMemo(() => isVideoExt(ext), [ext])
  const isModel = useMemo(() => isModelExt(ext), [ext])
  const mime = useMemo(() => MIME_BY_EXT[ext] || (isVideo ? 'video/*' : 'image/*'), [ext, isVideo])
  const [triedInlineFallback, setTriedInlineFallback] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    setLoaded(false)

    async function load() {
      if (isModel) {
        setSrc(null)
        setLoaded(true)
        return
      }
      if (isVideo) {
        try {
          const thumb = await generateVideoThumbnail(uri)
          if (cancelled) return
          setSrc(thumb)
        } catch (e) {
          console.warn('Failed to generate video thumbnail', e)
          useEditorStore.getState().addLog({ level: 'error', message: `Thumb error: ${e.message}` })
          setSrc(null)
        }
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
      {isModel ? (
        <span style={{ fontSize: 11, color: '#a78bfa', opacity: 0.9, fontWeight: 600 }}>3D</span>
      ) : isVideo ? (
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
                setError(true)
              }}
              style={{ display: 'none' }}
            />
          </>
        )
      ) : (
        error ? (
          <span style={{ fontSize: 11, color: '#c7cfdb', opacity: 0.7 }}>Unavailable</span>
        ) : <Spinner size={16} />
      )}
    </div>
  )
})
