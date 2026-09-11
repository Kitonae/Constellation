// Transform abstraction — analogous to MF's Media Foundation Transforms (MFTs).
//
// Each transform declares a type, configuration, and can produce a CSS filter
// string or (in future) a WebGL/Canvas processing function.
//
// Replaces the flat { type, value, enabled } effect arrays on TimelineClips
// with a richer model that supports chaining, type negotiation, and future
// non-CSS processing paths.

// --- Transform type registry ---

/**
 * Known transform types and their CSS filter function templates.
 * Each entry maps a type name to { css, unit, defaultValue }.
 */
export const TRANSFORM_TYPES = {
  blur:         { css: 'blur',        unit: 'px',  defaultValue: 0 },
  brightness:   { css: 'brightness',  unit: '',    defaultValue: 1 },
  contrast:     { css: 'contrast',    unit: '',    defaultValue: 1 },
  saturate:     { css: 'saturate',    unit: '',    defaultValue: 1 },
  grayscale:    { css: 'grayscale',   unit: '',    defaultValue: 0 },
  sepia:        { css: 'sepia',       unit: '',    defaultValue: 0 },
  'hue-rotate': { css: 'hue-rotate',  unit: 'deg', defaultValue: 0 },
  invert:       { css: 'invert',      unit: '',    defaultValue: 0 },
}

// --- Factory ---

/**
 * Create a transform node.
 *
 * @param {string} type    - Transform type (e.g. 'blur', 'brightness')
 * @param {object} [config]
 * @param {number} [config.value]   - Parameter value
 * @param {boolean} [config.enabled] - Whether the transform is active
 * @returns {Transform}
 */
export function createTransform(type, config = {}) {
  const typeDef = TRANSFORM_TYPES[type]
  return {
    type,
    value: config.value ?? typeDef?.defaultValue ?? 0,
    enabled: config.enabled ?? true,
  }
}

/**
 * Convert a single transform to its CSS filter function string.
 *
 * @param {Transform} transform
 * @returns {string} e.g. 'blur(5px)' or '' if disabled/identity
 */
export function transformToCSS(transform) {
  if (!transform?.enabled) return ''
  const typeDef = TRANSFORM_TYPES[transform.type]
  if (!typeDef) return ''

  const val = transform.value ?? typeDef.defaultValue
  // Skip identity values (no visual effect)
  if (val === typeDef.defaultValue) return ''

  return `${typeDef.css}(${val}${typeDef.unit})`
}

/**
 * Convert an ordered chain of transforms to a CSS filter string.
 * Equivalent to timeline.js getClipFilterString() but operates on
 * Transform objects instead of raw effect arrays.
 *
 * @param {Transform[]} transforms
 * @returns {string} CSS filter value, or 'none'
 */
export function chainToCSS(transforms) {
  if (!transforms?.length) return 'none'

  const parts = []
  for (const t of transforms) {
    const css = transformToCSS(t)
    if (css) parts.push(css)
  }

  return parts.length ? parts.join(' ') : 'none'
}

/**
 * Check if a transform type is known/registered.
 * @param {string} type
 * @returns {boolean}
 */
export function isKnownTransform(type) {
  return type in TRANSFORM_TYPES
}

/**
 * Convert a legacy effect object { type, value, enabled } to a Transform.
 * This is a pass-through since the shapes are identical, but validates
 * against the registry.
 *
 * @param {object} legacyEffect
 * @returns {Transform}
 */
export function migrateEffect(legacyEffect) {
  if (!legacyEffect) return null
  return createTransform(legacyEffect.type, {
    value: legacyEffect.value,
    enabled: legacyEffect.enabled,
  })
}

/**
 * Convert a clip's legacy effects array to a Transform chain.
 * @param {Array} effects - Array of { type, value, enabled }
 * @returns {Transform[]}
 */
export function effectsToTransforms(effects) {
  if (!Array.isArray(effects)) return []
  return effects.map(migrateEffect).filter(Boolean)
}
