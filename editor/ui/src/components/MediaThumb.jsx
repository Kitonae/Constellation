import React, { useEffect, useMemo, useState } from 'react'
import Spinner from './Spinner.jsx'

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
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

export default function MediaThumb({ uri, size = 48, alt = '', fill = false }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const mime = useMemo(() => MIME_BY_EXT[extFromUri(uri)] || 'image/*', [uri])
  const [triedInlineFallback, setTriedInlineFallback] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    setLoaded(false)
    
    async function load() {
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
      {src && !error ? (
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
