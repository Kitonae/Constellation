import React, { useEffect, useMemo, useState } from 'react'

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
        const { readBinaryFile } = await import('@tauri-apps/api/fs')
        const data = await readBinaryFile(p)
        const b64 = u8ToBase64(Uint8Array.from(data))
        const ext = extFromUri(u)
        const mime = MIME_BY_EXT[ext] || mimeHint || 'image/*'
        return `data:${mime};base64,${b64}`
      }
      // Fallback: let the webview try to load file:// directly
      return u
    } catch {
      return null
    }
  }
  return u
}

export default function MediaThumb({ uri, size = 48, alt = '', fill = false }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const mime = useMemo(() => MIME_BY_EXT[extFromUri(uri)] || 'image/*', [uri])

  useEffect(() => {
    let cancelled = false
    setError(false)

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
        <img
          src={src}
          alt={alt}
          onError={() => setError(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div style={{ width: '60%', height: '60%', background: '#1b2233', borderRadius: 3 }} />
      )}
    </div>
  )
}
