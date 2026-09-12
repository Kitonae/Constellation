/**
 * Asset kind, including models.
 *
 * Models use a rendered source frame for timeline playback. Preserve their
 * kind through browser imports, whose blob URLs contain no file extension.
 */

import { extFromUri, mediaTypeFromExt, isModelName } from './asset.js'

/** Accept a URI/name or an asset, including browser imports with blob URLs.
 * @returns {'image'|'video'|'audio'|'model'|'unknown'} */
export function assetKind(nameOrUri) {
  const asset = nameOrUri && typeof nameOrUri === 'object' ? nameOrUri : null
  const s = asset
    ? `asset.${extFromUri(asset.uri) || asset.format || extFromUri(asset.name)}`
    : String(nameOrUri || '')
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
 * model's is also an insert default; showing either as "10s" implied the file
 * itself had that length.
 */
export function isTimeBased(kind) {
  return kind === 'video' || kind === 'audio'
}

/** Can this kind carry pixel dimensions? */
export function hasNaturalSize(kind) {
  return kind === 'image' || kind === 'video'
}
