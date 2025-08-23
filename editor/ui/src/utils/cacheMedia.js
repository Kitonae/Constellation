// Utilities for caching media files locally and relinking project URIs

// Note: These helpers are designed to run inside a Tauri environment.
// They no-op gracefully in a plain browser (returning original URIs).

export async function ensureCacheDir() {
  if (typeof window === 'undefined' || !window.__TAURI__) return null
  const { appCacheDir, join } = await import('@tauri-apps/api/path')
  const { createDir, BaseDirectory } = await import('@tauri-apps/api/fs')
  const base = await appCacheDir()
  const dir = await join(base, 'media-cache')
  try {
    // Use BaseDirectory.AppCache so path falls within FS scope
    await createDir('media-cache', { recursive: true, dir: BaseDirectory.AppCache })
  } catch {}
  return dir
}

export async function cacheMediaFromPath(filePath) {
  // Accepts OS path or file:// URI
  try {
    if (!filePath) return null
    let path = String(filePath)
    if (path.startsWith('file://')) {
      try {
        const url = new URL(path)
        path = decodeURI(url.pathname)
        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1) // strip leading slash on Windows
      } catch {}
    }
    const cacheDir = await ensureCacheDir()
    if (!cacheDir) return toFileUri(path)

    const { readBinaryFile, writeBinaryFile, exists, BaseDirectory } = await import('@tauri-apps/api/fs')
    const { join, basename, extname } = await import('@tauri-apps/api/path')
    const data = await readBinaryFile(path)
    const hash = await sha256Hex(data)
    // Keep original extension for type hints
    let ext = await extname(path)
    // Ensure extension includes a leading dot
    if (ext && !ext.startsWith('.')) ext = '.' + ext
    if (!ext) {
      const name = await basename(path)
      const idx = name.lastIndexOf('.')
      ext = idx >= 0 ? name.slice(idx) : ''
    }
    const fileName = `${hash}${ext || ''}`
    const relPath = await join('media-cache', fileName)
    const dest = await join(cacheDir, fileName)
    const present = await exists(relPath, { dir: BaseDirectory.AppCache })
    if (!present) {
      await writeBinaryFile({ contents: data, path: relPath }, { dir: BaseDirectory.AppCache })
    }
    return toFileUri(dest)
  } catch (e) {
    console.error('cacheMediaFromPath failed:', e)
    return null
  }
}

export async function cacheMediaFromUri(uri) {
  if (!uri) return null
  if (!String(uri).startsWith('file://')) return uri
  return await cacheMediaFromPath(uri)
}

export async function relinkProjectMediaToCache(project) {
  try {
    if (!project?.media?.length) return project
    if (typeof window === 'undefined' || !window.__TAURI__) return project
    const cacheDir = await ensureCacheDir()
    if (!cacheDir) return project

    const updated = { ...project, media: [...project.media] }
    let changed = false
    for (let i = 0; i < updated.media.length; i++) {
      const m = updated.media[i]
      if (!m?.uri || !String(m.uri).startsWith('file://')) continue
      // Parse to path and check if already in cacheDir
      let p
      try {
        const url = new URL(m.uri)
        p = decodeURI(url.pathname)
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      } catch { p = null }
      if (!p) continue
      if (await isUnderDir(p, cacheDir)) continue
      const cached = await cacheMediaFromPath(p)
      if (cached) {
        updated.media[i] = { ...m, uri: cached }
        changed = true
      }
    }
    return changed ? updated : project
  } catch (e) {
    console.error('relinkProjectMediaToCache failed:', e)
    return project
  }
}

async function isUnderDir(path, dir) {
  try {
    const { normalize } = await import('@tauri-apps/api/path')
    let p = await normalize(path)
    let d = await normalize(dir)
    // Make comparison case-insensitive on Windows-like paths
    if (/^[A-Za-z]:\\/.test(p) || /^[A-Za-z]:\//.test(p)) {
      p = p.toLowerCase()
      d = d.toLowerCase()
    }
    return p.startsWith(d)
  } catch { return false }
}

function toFileUri(p) {
  let norm = String(p).replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(norm)) return `file:///${norm}`
  if (norm.startsWith('/')) return `file://${norm}`
  return `file://${norm}`
}

async function sha256Hex(u8) {
  const buf = u8 instanceof Uint8Array ? u8 : Uint8Array.from(u8)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16).padStart(2, '0')
    hex += h
  }
  return hex
}
