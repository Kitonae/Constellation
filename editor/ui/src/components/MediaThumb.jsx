import React, { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '../store.js'
import Spinner from './Spinner.jsx'
import { generateVideoThumbnail } from '../utils/videoUtils.js'
import { generateModelThumbnail } from '../utils/modelThumbnail.js'
import { extFromUri } from '../media/asset.js'
import { resolveUriSync } from '../media/uri.js'
import { assetKind, KIND_ICON } from '../media/kind.js'

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
}

/**
 * Resolve a media URI to something an `<img>` can load.
 *
 * `mimeHint` is used to pick a kind when the URI carries no extension —
 * blob: and data: URLs, which is exactly when the extension sniff fails.
 */
export async function resolveImageSrc(uri, mimeHint = 'image/*') {
  if (!uri) return null
  return resolveUriSync(uri) || null
}

/**
 * A thumbnail for one media asset.
 *
 * `missing` is passed in by the Media Bin from a real file-existence check.
 * Without it a moved file and a thumbnail that merely failed to decode both
 * rendered as the same grey word, so there was no way to tell a broken link
 * from an unsupported codec.
 */
export default React.memo(function MediaThumb({ uri, size = 48, alt = '', fill = false, kind: kindProp, mimeHint, missing = false }) {
  const [src, setSrc] = useState(null)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const ext = useMemo(() => extFromUri(uri) || extFromUri(alt), [uri, alt])
  const kind = useMemo(() => {
    if (kindProp) return kindProp
    const k = assetKind(uri)
    if (k !== 'unknown') return k
    const byName = assetKind(alt)
    if (byName !== 'unknown') return byName
    // blob:/data: URIs have no extension; the caller's MIME hint is all
    // there is to go on.
    if (mimeHint?.startsWith('video/')) return 'video'
    if (mimeHint?.startsWith('image/')) return 'image'
    if (mimeHint?.startsWith('audio/')) return 'audio'
    return 'unknown'
  }, [kindProp, uri, alt, mimeHint])

  const mime = useMemo(() => mimeHint || MIME_BY_EXT[ext] || (kind === 'video' ? 'video/*' : 'image/*'), [mimeHint, ext, kind])

  useEffect(() => {
    let cancelled = false
    setError(false)
    setLoaded(false)
    setSrc(null)

    async function load() {
      if (kind === 'model') {
        try {
          const thumb = await generateModelThumbnail(uri)
          if (cancelled) return
          setSrc(thumb)
        } catch (e) {
          if (cancelled) return
          console.warn('Failed to generate model thumbnail', e)
          setError(true)
        }
        return
      }
      if (kind === 'video') {
        try {
          const thumb = await generateVideoThumbnail(uri)
          if (cancelled) return
          setSrc(thumb)
        } catch (e) {
          if (cancelled) return
          console.warn('Failed to generate video thumbnail', e)
          useEditorStore.getState().addLog({ level: 'warn', message: `No thumbnail for ${alt || uri}: ${e.message || e}` })
          setError(true)
        }
        return
      }
      if (kind === 'audio' || kind === 'unknown') {
        setError(true)
        return
      }
      const resolved = await resolveImageSrc(uri, mime)
      if (cancelled) return
      if (!resolved) setError(true)
      else setSrc(resolved)
    }
    load()
    return () => { cancelled = true }
  }, [uri, mime, kind, alt])

  const box = {
    width: fill ? '100%' : size,
    height: fill ? '100%' : size,
    background: 'var(--bg-primary)',
    border: `1px solid ${missing ? 'var(--error)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    position: 'relative',
  }

  if (missing) {
    return (
      <div style={box} title="File is missing">
        <span className="ms" style={{ fontSize: Math.max(14, size * 0.4), color: 'var(--error)' }}>link_off</span>
      </div>
    )
  }

  if (error || (!src && (kind === 'audio' || kind === 'unknown'))) {
    return (
      <div style={box} title={error ? 'No preview available' : undefined}>
        <span className="ms" style={{ fontSize: Math.max(14, size * 0.4), color: kind === 'model' ? 'var(--model)' : 'var(--text-muted)' }}>
          {KIND_ICON[kind] || KIND_ICON.unknown}
        </span>
      </div>
    )
  }

  return (
    <div style={box}>
      {/* One image element, faded in on load. There used to be a second,
          hidden copy purely to detect the load event, so the browser
          fetched every thumbnail twice. */}
      {src && (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: kind === 'model' ? 'contain' : 'cover',
            display: 'block',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
        />
      )}
      {!loaded && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size={16} />
        </span>
      )}
    </div>
  )
})
