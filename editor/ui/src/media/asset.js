// Type-discriminated media asset model.
// Analogous to Microsoft Media Foundation's IMFMediaType + IMFStreamDescriptor.
//
// Replaces the flat { id, name, uri, duration_seconds } model in store.js.

import { resolveUri } from './uri.js'

// --- Constants ---

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'])

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
    const clean = u.split('?')[0].split('#')[0]
    const parts = clean.split('.')
    if (parts.length < 2) return ''
    return (parts[parts.length - 1] || '').toLowerCase()
  } catch { return '' }
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

/**
 * Probe a file or URI to determine its type and extract metadata.
 * This is the async equivalent of MF's source resolver — it inspects the media
 * and populates width, height, duration, frameRate, etc.
 *
 * @param {File|string} fileOrUri - File object or URI string
 * @param {string} [nameHint] - optional filename hint (for blob/data URIs)
 * @returns {Promise<object>} Populated MediaAsset
 */
export async function probeAsset(fileOrUri, nameHint) {
  const isFile = fileOrUri instanceof File
  const name = nameHint || (isFile ? fileOrUri.name : String(fileOrUri).split(/[\\\/]/).pop()) || 'media'
  const uri = isFile ? null : String(fileOrUri)
  const ext = extFromUri(name) || extFromUri(uri || '')
  const type = mediaTypeFromExt(ext)

  // Resolve to a playable URL for probing
  let playableUrl = null
  if (isFile) {
    playableUrl = URL.createObjectURL(fileOrUri)
  } else if (uri) {
    playableUrl = await resolveUri(uri)
  }

  try {
    switch (type) {
      case 'image':
        return await _probeImage(name, uri || '', playableUrl, ext)
      case 'video':
        return await _probeVideo(name, uri || '', playableUrl, ext)
      case 'audio':
        return await _probeAudio(name, uri || '', playableUrl, ext)
      default:
        // Unknown type — create a basic asset
        return createAsset('image', { name, uri: uri || '', format: ext })
    }
  } finally {
    // Clean up object URL if we created one from a File
    if (isFile && playableUrl) {
      // Don't revoke immediately — caller may need it. Revoke after a delay.
      setTimeout(() => { try { URL.revokeObjectURL(playableUrl) } catch {} }, 60000)
    }
  }
}

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

/**
 * Create a presentation descriptor for a media asset.
 *
 * Inspects the asset type and creates appropriate stream descriptors.
 * Video assets get both a video and an audio stream (if hasAudio is true).
 * Image assets get a single video (still frame) stream.
 * Audio assets get a single audio stream.
 *
 * @param {object} asset - MediaAsset
 * @returns {PresentationDescriptor}
 */
export function createPresentationDescriptor(asset) {
  if (!asset) return { assetId: '', streams: [], duration: 0 }

  const streams = []
  const duration = getAssetDuration(asset)

  switch (asset.type) {
    case 'video':
      streams.push({
        id: `stream-${(++_streamIdCounter).toString(36)}`,
        streamType: 'video',
        mediaType: {
          width: asset.width || 0,
          height: asset.height || 0,
          frameRate: asset.frameRate || 0,
          format: asset.format || '',
        },
        selected: true,
      })
      if (asset.hasAudio) {
        streams.push({
          id: `stream-${(++_streamIdCounter).toString(36)}`,
          streamType: 'audio',
          mediaType: {
            sampleRate: 0,  // not probed yet
            channels: 0,
          },
          selected: true,
        })
      }
      break

    case 'audio':
      streams.push({
        id: `stream-${(++_streamIdCounter).toString(36)}`,
        streamType: 'audio',
        mediaType: {
          sampleRate: asset.sampleRate || 0,
          channels: asset.channels || 0,
        },
        selected: true,
      })
      break

    case 'image':
    case 'color':
    case 'text':
    default:
      streams.push({
        id: `stream-${(++_streamIdCounter).toString(36)}`,
        streamType: 'video',
        mediaType: {
          width: asset.width || 0,
          height: asset.height || 0,
          frameRate: 0,
          format: asset.format || '',
        },
        selected: true,
      })
      break
  }

  return {
    assetId: asset.id,
    streams,
    duration,
  }
}

/**
 * Select or deselect a stream in a presentation descriptor.
 *
 * @param {PresentationDescriptor} pd
 * @param {string} streamId
 * @param {boolean} selected
 * @returns {PresentationDescriptor} new descriptor with updated selection
 */
export function selectStream(pd, streamId, selected) {
  return {
    ...pd,
    streams: pd.streams.map(s =>
      s.id === streamId ? { ...s, selected } : s
    ),
  }
}

/**
 * Get selected streams of a given type from a presentation descriptor.
 *
 * @param {PresentationDescriptor} pd
 * @param {'video'|'audio'} [streamType] - filter by type (omit for all selected)
 * @returns {StreamDescriptor[]}
 */
export function getSelectedStreams(pd, streamType) {
  if (!pd?.streams) return []
  return pd.streams.filter(s =>
    s.selected && (!streamType || s.streamType === streamType)
  )
}
