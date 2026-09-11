/**
 * Asset kind, including models.
 *
 * `mediaTypeFromExt` in asset.js only knows image/video/audio (it feeds the
 * playback pipeline, which has no notion of a 3D model). The UI needs one
 * more bucket to pick an icon and to decide whether a duration is meaningful,
 * so that lives here rather than widening the pipeline's contract.
 */

import { extFromUri, mediaTypeFromExt, isModelName } from './asset.js'

/** @returns {'image'|'video'|'audio'|'model'|'unknown'} */
export function assetKind(nameOrUri) {
  const s = String(nameOrUri || '')
  if (isModelName(s)) return 'model'
  return mediaTypeFromExt(extFromUri(s))
}

/** Material Symbols glyph per kind. */
export const KIND_ICON = {
  image: 'image',
  video: 'movie',
  audio: 'music_note',
  model: 'view_in_ar',
  unknown: 'draft',
}

/** Short human label per kind. */
export const KIND_LABEL = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  model: '3D Model',
  unknown: 'File',
}

/**
 * Does a duration mean anything for this kind?
 *
 * An image's stored `duration_seconds` is just the 10 s insert default and a
 * model's is 0; showing either as "10s" / "0s" in the bin implied the file
 * itself had that length.
 */
export function isTimeBased(kind) {
  return kind === 'video' || kind === 'audio'
}

/** Can this kind carry pixel dimensions? */
export function hasNaturalSize(kind) {
  return kind === 'image' || kind === 'video'
}
