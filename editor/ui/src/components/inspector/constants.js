/**
 * Property field configuration.
 *
 * Steps and clamps used to be written inline at each call site and drifted:
 * clip position stepped by 1 while node position stepped by 0.1, and the
 * effects fields had no bounds at all, so brightness accepted negatives.
 */

export const FIELD = {
  screenPixels: { step: 1, min: 1, max: 16384, unit: 'px' },
  clipPosition: { step: 1, unit: 'px' },
  clipSize: { step: 1, min: 1, unit: 'px' },
  clipStart: { step: 0.1, min: 0, unit: 's' },
  clipDuration: { step: 0.1, min: 0.01, unit: 's' },
  clipFade: { step: 0.1, min: 0, unit: 's' },
  // Opacity is stored 0..1 but shown as a percentage: 0.05 is a meaningless
  // number to type, 5 is not.
  opacity: { step: 1, min: 0, max: 100, unit: '%', displayScale: 100 },
  nodePosition: { step: 1 },
  nodeScale: { step: 0.01, min: 0.001 },
  nodeRotation: { step: 1, unit: '°' },
}

/** Ranges the store also enforces, so a scrub cannot escape them. */
export const EFFECT_RANGES = {
  brightness: { min: 0, max: 10, step: 0.05, defaultValue: 1 },
  contrast: { min: 0, max: 10, step: 0.05, defaultValue: 1 },
  saturate: { min: 0, max: 10, step: 0.05, defaultValue: 1 },
  'hue-rotate': { min: 0, max: 360, step: 1, unit: '°', defaultValue: 0 },
  blur: { min: 0, max: 100, step: 0.5, unit: 'px', defaultValue: 0 },
  grayscale: { toggleOnly: true, defaultValue: 1 },
  sepia: { toggleOnly: true, defaultValue: 1 },
  invert: { toggleOnly: true, defaultValue: 1 },
}

/** Named output resolutions, so nobody types 3840 by hand. */
export const RESOLUTION_PRESETS = [
  { label: '1920 × 1080 (HD)', w: 1920, h: 1080 },
  { label: '3840 × 2160 (4K UHD)', w: 3840, h: 2160 },
  { label: '2560 × 1440 (QHD)', w: 2560, h: 1440 },
  { label: '1280 × 720 (720p)', w: 1280, h: 720 },
  { label: '1080 × 1920 (Portrait HD)', w: 1080, h: 1920 },
  { label: '2160 × 3840 (Portrait 4K)', w: 2160, h: 3840 },
]
