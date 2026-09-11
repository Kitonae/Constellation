/**
 * Design tokens, mirrored from the `:root` block in `styles.css`.
 *
 * Prefer the CSS variables (`var(--accent)`) in markup. These exports exist
 * for the handful of places that need a token from JS — canvas painting, the
 * three.js scene, generated data URLs. `__tests__/theme.test.js` asserts the
 * two stay in sync.
 */

export const colors = {
  bgPrimary: '#0f1115',
  bgDeep: '#0b0d12',
  bgPanel: '#151821',
  bgHover: '#1c202b',
  bgSelected: '#354066',
  bgElevated: '#1b1e26',
  bgInset: '#13151a',
  bgControl: '#2a2f45',
  bgControlSubtle: '#161820',
  bgStage: '#283042',
  border: '#232636',
  borderSubtle: '#3a4060',
  text: '#c7cfdb',
  textSecondary: '#b9c3d6',
  textTertiary: '#8b9bb4',
  textMuted: '#6b7280',
  textStrong: '#e1e4e8',
  accent: '#6aa0ff',
  accentYellow: '#ffcc00',
  playhead: '#ff6',
  error: '#ff4444',
  success: '#4ade80',
  warn: '#facc15',
  info: '#8bc3ff',
  model: '#a78bfa',
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
