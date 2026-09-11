/**
 * Design tokens, mirrored from the `:root` block in `styles.css`.
 *
 * Prefer the CSS variables (`var(--accent)`) in markup. These exports exist
 * for the handful of places that need a token from JS — canvas painting, the
 * three.js scene, generated data URLs. `__tests__/theme.test.js` asserts the
 * two stay in sync.
 */

export const colors = {
  bgPrimary: '#0a0c0e',
  bgDeep: '#08090b',
  bgPanel: '#0e1013',
  bgHover: '#131619',
  bgSelected: '#1b2530',
  bgElevated: '#14181c',
  bgInset: '#0b0d10',
  bgControl: '#131619',
  bgControlSubtle: '#0f1215',
  bgStage: '#0a0c0e',
  border: '#23272d',
  borderSubtle: '#3c424a',
  text: '#cfd5dc',
  textSecondary: '#b9c1ca',
  textTertiary: '#8a929c',
  textMuted: '#7f8994',
  textStrong: '#e6eaef',
  accent: '#4ea3ff',
  accentYellow: '#e2a33c',
  playhead: '#4ea3ff',
  error: '#ff5f56',
  success: '#4fb3a1',
  warn: '#e2a33c',
  info: '#9fc9f5',
  model: '#7c5cff',
  // Stage chrome. Exposed here because the grid is painted to a canvas tile,
  // which cannot read a CSS variable.
  stageLine: '#223040',
  stageGrid: '#111418',
}

/** CSS custom-property name for a `colors` key (`accentYellow` → `--accent-yellow`). */
export function cssVarName(key) {
  return '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

/** `var(--accent)` for a `colors` key, for use in inline styles. */
export function cssVar(key) {
  return `var(${cssVarName(key)})`
}

/**
 * Stacking order. Every z-index in the app comes from here or from the
 * matching CSS variable; nothing hardcodes a number.
 */
export const zIndex = {
  hud: 10,
  splitter: 20,
  menubar: 2000,
  menu: 2100,
  toast: 2500,
  console: 3000,
  modal: 4000,
  blocking: 9000,
}
