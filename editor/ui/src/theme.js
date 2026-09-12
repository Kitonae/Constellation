/**
 * Design tokens, mirrored from the `:root` and `[data-theme]` blocks in
 * `styles.css`.
 *
 * Prefer the CSS variables (`var(--accent)`) in markup. These exports exist
 * for the handful of places that need a token from JS — canvas painting, the
 * three.js scene, generated data URLs. `__tests__/theme.test.js` asserts the
 * two stay in sync, for every theme.
 *
 * Signal is the default and lives in `:root`; the other three override the
 * same token names under a `[data-theme]` selector, so switching theme is a
 * single attribute on the document element.
 *
 * Accent and success come from the source designs. Error, warn, info and
 * model are derived per theme — the designs do not show them — and are only
 * pitched to sit in the same key as the rest of the palette.
 */

/** Near-black, high contrast, one cool accent. */
const signal = {
  bgPrimary: '#0a0c0e',
  bgDeep: '#08090b',
  bgPanel: '#0e1013',
  bgHover: '#131619',
  bgSelected: '#1b2530',
  bgRowSelected: '#16202b',
  bgElevated: '#14181c',
  bgInset: '#0b0d10',
  bgControl: '#131619',
  bgControlSubtle: '#0f1215',
  bgStage: '#0a0c0e',
  border: '#23272d',
  borderSubtle: '#3c424a',
  borderFaint: '#12161a',
  borderAccent: '#2b4560',
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
  stageLine: '#223040',
  stageGrid: '#111418',
  stageTick: '#2f3a45',
  stageMode: '#4fb3a1',
  // The stage screen rectangles are translucent so the grid reads through
  // them; derived from this theme's own surfaces rather than a fixed navy.
  screenFill: 'rgba(11, 13, 16, 0.5)',
  screenFillSelected: 'rgba(27, 37, 48, 0.55)',
}

/** Warm graphite, muted amber, softer edges. */
const studio = {
  bgPrimary: '#17140f',
  bgDeep: '#141210',
  bgPanel: '#1c1916',
  bgHover: '#232019',
  bgSelected: '#33271a',
  bgRowSelected: '#2b2418',
  bgElevated: '#201d18',
  bgInset: '#181510',
  bgControl: '#232019',
  bgControlSubtle: '#1a1713',
  bgStage: '#17140f',
  border: '#322c25',
  borderSubtle: '#3f382e',
  borderFaint: '#272219',
  borderAccent: '#59431f',
  text: '#d8cfc2',
  textSecondary: '#cdc3b5',
  textTertiary: '#9c9287',
  textMuted: '#a39889',
  textStrong: '#efe9df',
  accent: '#e2a33c',
  accentYellow: '#e2a33c',
  playhead: '#e2a33c',
  error: '#e06a5a',
  success: '#94a35c',
  warn: '#e2a33c',
  info: '#d8b98a',
  model: '#b08cff',
  stageLine: '#3d3325',
  stageGrid: '#201c16',
  stageTick: '#4a4034',
  stageMode: '#94a35c',
  // The stage screen rectangles are translucent so the grid reads through
  // them; derived from this theme's own surfaces rather than a fixed navy.
  screenFill: 'rgba(24, 21, 16, 0.5)',
  screenFillSelected: 'rgba(51, 39, 26, 0.55)',
}

/** Cool mid-grey, flat, almost no accent. */
const technical = {
  bgPrimary: '#22252a',
  bgDeep: '#24272b',
  bgPanel: '#2c3034',
  bgHover: '#32373d',
  bgSelected: '#3b444c',
  bgRowSelected: '#363d45',
  bgElevated: '#30353a',
  bgInset: '#282c30',
  bgControl: '#32373d',
  bgControlSubtle: '#2a2e33',
  bgStage: '#22252a',
  border: '#4a5158',
  borderSubtle: '#5a6167',
  borderFaint: '#3d4349',
  borderAccent: '#6d7a86',
  text: '#dce1e5',
  textSecondary: '#c3c9ce',
  textTertiary: '#b2b9bf',
  textMuted: '#a7aeb5',
  textStrong: '#f0f3f5',
  accent: '#9fb3c4',
  accentYellow: '#d4b483',
  playhead: '#9fb3c4',
  error: '#d98a80',
  success: '#7fa899',
  warn: '#d4b483',
  info: '#c3d2de',
  model: '#a9a0d8',
  stageLine: '#565e66',
  stageGrid: '#2f3338',
  stageTick: '#464e56',
  stageMode: '#7fa899',
  // The stage screen rectangles are translucent so the grid reads through
  // them; derived from this theme's own surfaces rather than a fixed navy.
  screenFill: 'rgba(40, 44, 48, 0.5)',
  screenFillSelected: 'rgba(59, 68, 76, 0.55)',
}

/** Deep ink blue-black, saturated violet accent. */
const ink = {
  bgPrimary: '#080b17',
  bgDeep: '#060814',
  bgPanel: '#0c1020',
  bgHover: '#121729',
  bgSelected: '#231d4d',
  bgRowSelected: '#1a1640',
  bgElevated: '#111630',
  bgInset: '#0a0d1a',
  bgControl: '#121729',
  bgControlSubtle: '#0e1322',
  bgStage: '#080b17',
  border: '#232a45',
  borderSubtle: '#333c5e',
  borderFaint: '#151b2d',
  borderAccent: '#3f2f86',
  text: '#c6cdea',
  textSecondary: '#b4bbdd',
  textTertiary: '#8f97bd',
  textMuted: '#9aa2c6',
  textStrong: '#e9ecfa',
  accent: '#7c5cff',
  accentYellow: '#e2a33c',
  playhead: '#7c5cff',
  error: '#ff6b8a',
  success: '#3fd6a6',
  warn: '#e2a33c',
  info: '#c0b0ff',
  model: '#7c5cff',
  stageLine: '#2b3459',
  stageGrid: '#0f1428',
  stageTick: '#1f2745',
  stageMode: '#3fd6a6',
  // The stage screen rectangles are translucent so the grid reads through
  // them; derived from this theme's own surfaces rather than a fixed navy.
  screenFill: 'rgba(10, 13, 26, 0.5)',
  screenFillSelected: 'rgba(35, 29, 77, 0.55)',
}

/** Every theme, keyed by the value stored in settings. */
export const THEMES = { signal, studio, technical, ink }

/** The theme applied when nothing is stored, and the one `:root` declares. */
export const DEFAULT_THEME = 'signal'

/** Tokens for one theme, falling back to the default for an unknown id. */
export function colorsFor(themeId) {
  return THEMES[themeId] || THEMES[DEFAULT_THEME]
}

/**
 * The default theme's tokens.
 *
 * Kept as a named export for anything that genuinely does not vary by theme;
 * anything drawn on screen should use `colorsFor(activeTheme)` instead.
 */
export const colors = signal

/**
 * Put a theme on the document.
 *
 * The default theme is `:root`, so it carries no attribute at all — that way
 * the base declarations are never shadowed by an identical override.
 */
export function applyTheme(themeId) {
  if (typeof document === 'undefined') return
  const id = THEMES[themeId] ? themeId : DEFAULT_THEME
  if (id === DEFAULT_THEME) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = id
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
