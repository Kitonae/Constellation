/**
 * "Is this file still there?" for the Media Bin's missing-file badge.
 *
 * Three answers, and the third matters: `true`, `false`, or `null` for
 * "cannot tell". A thumbnail that fails to decode is not the same as a file
 * that has been moved, and the bin used to show both as the same grey word.
 */

import { fromFileUri } from '../media/uri.js'
import { resolveUriSync } from '../media/uri.js'
import { FileExists } from '@bindings/app.js'
import { isWails } from '../wails/env.js'

/** uri -> boolean | null (resolved), or a Promise while in flight. */
const cache = new Map()

async function probe(uri) {
  const s = String(uri)
  // Anything not backed by a local path is either always there (data:, blob:)
  // or not ours to judge.
  if (!s.startsWith('file:')) return true

  if (isWails()) {
    try { return !!(await FileExists(fromFileUri(s))) } catch { /* fall through */ }
  }

  // Fallback: the Go file sidecar serves local files over HTTP, and HEAD is
  // CORS-safelisted, so a 404 here is a genuine missing file.
  const url = resolveUriSync(s)
  if (!url || !url.startsWith('http')) return null
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return res.ok
  } catch { return null }
}

/**
 * @param {string} uri
 * @returns {Promise<boolean|null>}
 */
export function checkFileExists(uri) {
  if (!uri) return Promise.resolve(null)
  const key = String(uri)
  if (cache.has(key)) {
    const hit = cache.get(key)
    return hit instanceof Promise ? hit : Promise.resolve(hit)
  }
  const p = probe(key).then((res) => { cache.set(key, res); return res }, () => { cache.set(key, null); return null })
  cache.set(key, p)
  return p
}

/** Synchronous peek — only returns an answer the cache already resolved. */
export function peekFileExists(uri) {
  const hit = cache.get(String(uri || ''))
  return hit instanceof Promise ? null : (hit === undefined ? null : hit)
}

/** Forget a URI, e.g. after a relink or a re-import. */
export function invalidateFileExists(uri) {
  cache.delete(String(uri || ''))
}
