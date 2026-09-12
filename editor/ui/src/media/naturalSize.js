/**
 * Natural pixel size of a media asset, cached.
 *
 * The Inspector used to probe this itself with a bare `<Image>`, which meant
 * videos reported no size at all and every selection change refetched. This
 * is the one probe: it handles video, caches per URI, and limits how many
 * `<video>` elements can be decoding at once (the Media Bin can ask for a
 * whole binful in one render).
 */

import { resolveUriSync } from './uri.js'
import { getVideoMetadata } from '../utils/videoUtils.js'
import { assetKind, hasNaturalSize } from './kind.js'
import { MODEL_CONTENT_SIZE } from './modelContent.js'

/** uri -> { w, h } | null (resolved), or a Promise while in flight. */
const cache = new Map()

const MAX_CONCURRENT = 2
let active = 0
const queue = []

function runNext() {
  if (active >= MAX_CONCURRENT) return
  const job = queue.shift()
  if (!job) return
  active++
  job().finally(() => { active--; runNext() })
}

function schedule(fn) {
  return new Promise((resolve) => {
    queue.push(() => fn().then(resolve, () => resolve(null)))
    runNext()
  })
}

function probeImage(uri) {
  return new Promise((resolve) => {
    const src = resolveUriSync(uri)
    if (!src) { resolve(null); return }
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function probeVideo(uri) {
  try {
    const meta = await getVideoMetadata(uri)
    if (meta?.width && meta?.height) return { w: meta.width, h: meta.height }
  } catch { /* fall through */ }
  return null
}

/**
 * @param {string} uri
 * @param {string} [kindHint] skip the extension sniff when the caller knows
 * @returns {Promise<{w:number,h:number}|null>} null for audio, models and failures
 */
export function getNaturalSize(uri, kindHint) {
  if (!uri) return Promise.resolve(null)
  const key = String(uri)
  if (cache.has(key)) {
    const hit = cache.get(key)
    return hit instanceof Promise ? hit : Promise.resolve(hit)
  }
  const kind = kindHint || assetKind(key)
  if (kind === 'model') {
    const size = { w: MODEL_CONTENT_SIZE, h: MODEL_CONTENT_SIZE }
    cache.set(key, size)
    return Promise.resolve(size)
  }
  if (!hasNaturalSize(kind)) {
    cache.set(key, null)
    return Promise.resolve(null)
  }
  const p = schedule(() => (kind === 'video' ? probeVideo(key) : probeImage(key)))
    .then((res) => { cache.set(key, res); return res })
  cache.set(key, p)
  return p
}

/** Synchronous peek — only returns a value the cache already resolved. */
export function peekNaturalSize(uri) {
  const hit = cache.get(String(uri || ''))
  return hit instanceof Promise ? null : (hit || null)
}

/** Forget a URI, e.g. after a relink pointed the same asset at a new file. */
export function invalidateNaturalSize(uri) {
  cache.delete(String(uri || ''))
}
