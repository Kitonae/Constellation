// Unified URI resolver — single source of truth for all media URI resolution.
// Analogous to Microsoft Media Foundation's IMFSourceResolver.
//
// Replaces the scattered implementations in:
//   - videoUtils.js (resolveFileUrl)
//   - MediaThumb.jsx (resolveImageSrc)
//   - store.js, MediaBin.jsx, App.jsx (toFileUri)

import { ReadFileBase64 } from '@bindings/app.js'
import { isWails } from '../wails/env.js'

let _fileServerBase = ''

/**
 * Set the base URL for the sidecar file server (Wails dev mode).
 * Called once at startup when the Go backend reports its port.
 */
export function setFileServerBase(url) {
  _fileServerBase = url || ''
}

/**
 * Get the current file server base URL.
 */
export function getFileServerBase() {
  return _fileServerBase
}

/**
 * Convert an OS file path to a file:// URI.
 * Handles Windows drive letters, spaces, and special characters.
 *
 * @param {string} path - OS file path (e.g. "C:\\images\\photo.jpg" or "/home/user/photo.jpg")
 * @returns {string} file:// URI
 */
export function toFileUri(path) {
  let norm = String(path).replace(/\\/g, '/')

  // Encode each path segment to handle spaces and special characters
  const parts = norm.split('/')
  const encoded = parts.map(part => encodeURIComponent(part))
  norm = encoded.join('/')

  // Restore drive letter colon if it was encoded (e.g. "C%3A" -> "C:")
  norm = norm.replace(/^([a-zA-Z])%3A/, '$1:')

  // Windows drive letter: file:///C:/...
  if (/^[A-Za-z]:\//.test(norm)) return `file:///${norm}`
  // POSIX absolute: file:///home/...
  if (norm.startsWith('/')) return `file://${norm}`
  // Fallback
  return `file://${norm}`
}

/**
 * Extract the filesystem path from a file:// URI.
 *
 * @param {string} uri - file:// URI
 * @returns {string} OS file path
 */
export function fromFileUri(uri) {
  try {
    const u = new URL(uri)
    if (u.protocol !== 'file:') return uri
    let p = decodeURIComponent(u.pathname)
    // On Windows, pathname like "/C:/..." — strip leading slash
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
    return p
  } catch {
    // Manual fallback for malformed URIs
    const stripped = String(uri).replace(/^file:\/\/\/?/, '')
    return decodeURIComponent(stripped)
  }
}

/**
 * Resolve any media URI to a URL playable by the browser.
 *
 * Resolution strategy:
 *   1. data: / blob:   → return as-is (already playable)
 *   2. http: / https:  → return as-is
 *   3. file://          → rewrite to sidecar file server if available,
 *                         else try Wails ReadFileBase64, else return null
 *   4. bare path        → convert to file:// then apply (3)
 *
 * @param {string|File} uri - Media URI, path, or File object
 * @returns {Promise<string|null>} Playable URL, or null if unresolvable
 */
export async function resolveUri(uri) {
  if (!uri) return null

  // File objects → object URL
  if (uri instanceof File) return URL.createObjectURL(uri)

  const u = String(uri)

  // Already playable
  if (u.startsWith('data:') || u.startsWith('blob:')) return u
  if (u.startsWith('http:') || u.startsWith('https:')) return u

  // file:// URI → resolve via sidecar or Wails backend
  if (u.startsWith('file://')) {
    return _resolveFileUri(u)
  }

  // Bare path → convert to file:// first
  if (u.startsWith('/') || /^[A-Za-z]:[\\/]/.test(u)) {
    return _resolveFileUri(toFileUri(u))
  }

  // Unknown scheme — return as-is and hope for the best
  return u
}

/**
 * Synchronous version for contexts where async isn't possible.
 * Only handles sidecar rewrite and direct URLs. Does NOT try Wails ReadFileBase64.
 *
 * @param {string} uri
 * @returns {string} Playable URL, or empty string if unresolvable
 */
export function resolveUriSync(uri) {
  if (!uri) return ''

  if (uri instanceof File) return URL.createObjectURL(uri)

  const u = String(uri)

  if (u.startsWith('data:') || u.startsWith('blob:')) return u
  if (u.startsWith('http:') || u.startsWith('https:')) return u

  if (u.startsWith('file://')) {
    return _rewriteFileToHttp(u)
  }

  if (u.startsWith('/') || /^[A-Za-z]:[\\/]/.test(u)) {
    return _rewriteFileToHttp(toFileUri(u))
  }

  return u
}

// --- Internal helpers ---

/**
 * Resolve a file:// URI to a playable URL (async — tries all backends).
 */
async function _resolveFileUri(fileUri) {
  // Try sidecar HTTP rewrite first (works in both Wails and dev mode)
  const httpUrl = _rewriteFileToHttp(fileUri)
  if (httpUrl !== '') return httpUrl

  // Try Wails Go backend ReadFileBase64
  if (isWails()) {
    try {
      const path = fromFileUri(fileUri)
      const dataUrl = await ReadFileBase64(path)
      if (dataUrl) return dataUrl
    } catch { /* fall through */ }
  }

  // Browsers block file:// URIs — return null so callers can show placeholder
  return null
}

/**
 * Rewrite a file:// URI to the sidecar HTTP file server.
 * Returns empty string if no file server is configured.
 */
function _rewriteFileToHttp(fileUri) {
  if (!_fileServerBase) return ''
  const path = fromFileUri(fileUri)
  const safePath = path.startsWith('/') ? path : '/' + path
  // Re-encode for the HTTP URL
  const segments = safePath.split('/')
  const encoded = segments.map(s => encodeURIComponent(s)).join('/')
  return `${_fileServerBase}/fs${encoded}`
}
