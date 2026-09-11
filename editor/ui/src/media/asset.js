// Type-discriminated media asset model.
// Analogous to Microsoft Media Foundation's IMFMediaType + IMFStreamDescriptor.
//
// Replaces the flat { id, name, uri, duration_seconds } model in store.js.

import { resolveUri } from './uri.js'

// --- Constants ---

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg', 'hevc', 'h265', '265', 'ts', 'mts'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'])

const MODEL_EXTS = new Set(['gltf', 'glb', 'obj'])

const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS])

// --- Type detection ---

/**
 * Extract file extension from a URI, filename, or path.
 * @param {string} uriOrName
 * @returns {string} lowercase extension without dot, or ''
 */
export function extFromUri(uriOrName) {
  try {
    const u = String(uriOrName || '')
    // blob: and data: URLs carry no meaningful extension, and a base64 body
    // is full of characters that would fool the split below.
    if (u.startsWith('blob:') || u.startsWith('data:')) return ''
    const clean = u.split('?')[0].split('#')[0]
    const parts = clean.split('.')
    if (parts.length < 2) return ''
    return (parts[parts.length - 1] || '').toLowerCase()
  } catch { return '' }
}

/**
 * The filename-and-extension portion of a path, URI or name.
 *
 * Native file dialogs on Windows hand back backslash-separated absolute
 * paths, so an asset imported that way carried its whole path as its display
 * name and filled a 250px panel with `C:\Users\...`. Splits on either
 * separator, ignores any query or fragment, and un-escapes a file:// URI.
 *
 * A name with no separator comes back unchanged, so this is safe to apply to
 * anything already clean.
 *
 * @param {string} pathOrName
 * @returns {string}
 */
export function baseName(pathOrName) {
  const raw = String(pathOrName ?? '').trim()
  if (!raw) return ''
  // Nothing to recover from these, and their bodies are full of slashes.
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw
  let u = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
  u = u.split('?')[0].split('#')[0]
  const parts = u.split(/[\\/]/).filter(Boolean)
  const last = parts.length ? parts[parts.length - 1] : u
  try { return decodeURIComponent(last) } catch { return last }
}

/**
 * Detect media type from extension.
 * @param {string} ext - lowercase extension
 * @returns {'image'|'video'|'audio'|'unknown'}
 */
export function mediaTypeFromExt(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'unknown'
}

/**
 * Check if a filename/URI represents a supported media file.
 * @param {string} name
 * @returns {boolean}
 */
export function isMediaFile(name) {
  return MEDIA_EXTS.has(extFromUri(name))
}

// --- Name/URI predicates ---
//
// These are the single source of truth for "is this a video?" and friends.
// Ad-hoc regexes scattered across the UI disagreed with each other: a `.ts`
// file passed isMediaFile but was treated as an image by the thumbnail and
// never probed for duration.

export function isVideoName(name) { return VIDEO_EXTS.has(extFromUri(name)) }
export function isImageName(name) { return IMAGE_EXTS.has(extFromUri(name)) }
export function isAudioName(name) { return AUDIO_EXTS.has(extFromUri(name)) }
export function isModelName(name) { return MODEL_EXTS.has(extFromUri(name)) }
/** Anything the media bin accepts: playable media plus 3D models. */
export function isImportableFile(name) { return isMediaFile(name) || isModelName(name) }

// --- Type guards ---

export function isImage(asset) { return asset?.type === 'image' }
export function isVideo(asset) { return asset?.type === 'video' }
export function isAudio(asset) { return asset?.type === 'audio' }
export function isColor(asset) { return asset?.type === 'color' }
export function isText(asset) { return asset?.type === 'text' }

// --- Factory ---

let _idCounter = 0

function generateId(prefix = 'asset') {
  return `${prefix}-${Date.now().toString(36)}-${(++_idCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Create a media asset of the given type.
 * @param {'image'|'video'|'audio'|'color'|'text'} type
 * @param {object} props - type-specific properties
 * @returns {object} MediaAsset
 */
export function createAsset(type, props = {}) {
  const base = {
    id: props.id || generateId(type),
    name: props.name || 'Untitled',
    type,
  }

  switch (type) {
    case 'image':
      return {
        ...base,
        uri: props.uri || '',
        width: props.width || 0,
        height: props.height || 0,
        format: props.format || extFromUri(props.uri || props.name || ''),
      }
    case 'video':
      return {
        ...base,
        uri: props.uri || '',
        width: props.width || 0,
        height: props.height || 0,
        duration: props.duration || 0,
        frameRate: props.frameRate || 0,
        hasAudio: props.hasAudio ?? false,
        format: props.format || extFromUri(props.uri || props.name || ''),
      }
    case 'audio':
      return {
        ...base,
        uri: props.uri || '',
        duration: props.duration || 0,
        sampleRate: props.sampleRate || 0,
        channels: props.channels || 0,
      }
    case 'color':
      return {
        ...base,
        color: props.color || '#000000',
        width: props.width || 1920,
        height: props.height || 1080,
      }
    case 'text':
      return {
        ...base,
        text: props.text || '',
        font: props.font || 'sans-serif',
        fontSize: props.fontSize || 48,
        color: props.color || '#ffffff',
      }
    default:
      return { ...base, uri: props.uri || '' }
  }
}

// --- Probing ---


async function _probeImage(name, uri, playableUrl, ext) {
  const asset = createAsset('image', { name, uri, format: ext })

  if (!playableUrl) return asset

  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      resolve({ ...asset, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => resolve(asset)
    img.src = playableUrl
  })
}

async function _probeVideo(name, uri, playableUrl, ext) {
  const asset = createAsset('video', { name, uri, format: ext })

  if (!playableUrl) return { ...asset, duration: 10 } // fallback

  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true

    const cleanup = () => {
      video.removeAttribute('src')
      video.load()
    }

    video.onloadedmetadata = () => {
      const result = {
        ...asset,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 10,
        frameRate: 0, // Not available from HTMLVideoElement metadata
        hasAudio: _videoHasAudio(video),
      }
      cleanup()
      resolve(result)
    }
    video.onerror = () => {
      cleanup()
      resolve({ ...asset, duration: 10 })
    }
    video.src = playableUrl
  })
}

function _videoHasAudio(videoEl) {
  // Best-effort detection using mozHasAudio, webkitAudioDecodedByteCount, or audioTracks
  if (typeof videoEl.mozHasAudio === 'boolean') return videoEl.mozHasAudio
  if (typeof videoEl.webkitAudioDecodedByteCount === 'number') return videoEl.webkitAudioDecodedByteCount > 0
  if (videoEl.audioTracks) return videoEl.audioTracks.length > 0
  return false
}

async function _probeAudio(name, uri, playableUrl, ext) {
  const asset = createAsset('audio', { name, uri })

  if (!playableUrl) return { ...asset, duration: 10 }

  return new Promise((resolve) => {
    const audio = new Audio()
    audio.preload = 'metadata'

    audio.onloadedmetadata = () => {
      resolve({
        ...asset,
        duration: Number.isFinite(audio.duration) ? audio.duration : 10,
      })
    }
    audio.onerror = () => resolve({ ...asset, duration: 10 })
    audio.src = playableUrl
  })
}

// --- Migration ---

/**
 * Migrate a legacy flat clip object to a typed MediaAsset.
 * Legacy format: { id, name, uri, duration_seconds }
 *
 * @param {object} legacyClip
 * @returns {object} MediaAsset
 */
export function migrateAsset(legacyClip) {
  if (!legacyClip) return null

  // Already migrated?
  if (legacyClip.type && ['image', 'video', 'audio', 'color', 'text'].includes(legacyClip.type)) {
    return legacyClip
  }

  const ext = extFromUri(legacyClip.uri || legacyClip.name || '')
  const type = mediaTypeFromExt(ext)

  switch (type) {
    case 'video':
      return createAsset('video', {
        id: legacyClip.id,
        name: legacyClip.name,
        uri: legacyClip.uri,
        duration: legacyClip.duration_seconds ?? legacyClip.duration ?? 10,
        format: ext,
      })
    case 'audio':
      return createAsset('audio', {
        id: legacyClip.id,
        name: legacyClip.name,
        uri: legacyClip.uri,
        duration: legacyClip.duration_seconds ?? legacyClip.duration ?? 10,
      })
    case 'image':
    default:
      return createAsset('image', {
        id: legacyClip.id,
        name: legacyClip.name,
        uri: legacyClip.uri,
        format: ext,
      })
  }
}

/**
 * Get the duration of an asset in seconds.
 * Normalizes the difference between legacy `duration_seconds` and new `duration`.
 * @param {object} asset
 * @returns {number}
 */
export function getAssetDuration(asset) {
  if (!asset) return 0
  // New model
  if (typeof asset.duration === 'number' && asset.duration > 0) return asset.duration
  // Legacy model
  if (typeof asset.duration_seconds === 'number' && asset.duration_seconds > 0) return asset.duration_seconds
  // Images/colors have no intrinsic duration
  return 0
}

// --- Presentation Descriptors ---
// Analogous to MF's IMFPresentationDescriptor + IMFStreamDescriptor.
//
// Separates "what streams a source has" from the asset identity.
// Enables multi-stream assets (video+audio) and stream selection.

/**
 * @typedef {object} StreamDescriptor
 * @property {string} id         - stream identifier
 * @property {'video'|'audio'|'image'} streamType - stream type
 * @property {object} mediaType  - format-specific attributes
 * @property {boolean} selected  - whether this stream is active
 */

/**
 * @typedef {object} PresentationDescriptor
 * @property {string} assetId     - source asset ID
 * @property {StreamDescriptor[]} streams - available streams
 * @property {number} duration    - presentation duration in seconds
 */

let _streamIdCounter = 0



