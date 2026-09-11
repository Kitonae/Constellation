/**
 * Editor preferences.
 *
 * Settings describe how this machine shows the editor, not what the show
 * contains. So they live outside the project: they persist to local storage,
 * never enter a saved file, and never enter the undo stack — undoing a clip
 * move should not also flip the grid back.
 */

import { readPersisted, writePersisted } from './hooks/usePersistentState.js'
import { DEFAULT_THEME } from './theme.js'

export const SETTINGS_KEY = 'settings'

/**
 * Every setting, with its allowed values and default.
 *
 * Adding one here is all that is needed: the store validates against this
 * table and the settings dialog renders from it, so neither has a list of
 * its own to fall out of step.
 */
export const SETTINGS_SCHEMA = {
  theme: {
    label: 'Theme',
    description: 'Colour palette for the whole editor.',
    default: DEFAULT_THEME,
    options: [
      { value: 'signal', label: 'Signal' },
      { value: 'studio', label: 'Studio' },
      { value: 'technical', label: 'Technical' },
      { value: 'ink', label: 'Ink' },
    ],
  },
  gridStyle: {
    label: 'Grid style',
    description: 'How the stage grid is drawn behind your screens.',
    default: 'dots',
    options: [
      { value: 'dots', label: 'Dots' },
      { value: 'lines', label: 'Lines' },
    ],
  },
}

export const DEFAULT_SETTINGS = Object.fromEntries(
  Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => [key, spec.default]),
)

/** Is `value` one of the values this setting accepts? */
export function isValidSetting(key, value) {
  const spec = SETTINGS_SCHEMA[key]
  if (!spec) return false
  return spec.options.some((o) => o.value === value)
}

/**
 * Settings as stored, with anything unrecognised discarded.
 *
 * Local storage outlives the code that wrote it, so a setting that has been
 * renamed, removed, or hand-edited to nonsense must fall back to its default
 * rather than reaching a component that assumes one of a fixed set.
 */
export function normalizeSettings(stored) {
  const out = { ...DEFAULT_SETTINGS }
  if (!stored || typeof stored !== 'object') return out
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    if (isValidSetting(key, stored[key])) out[key] = stored[key]
  }
  return out
}

/** Read the persisted settings, falling back to defaults. */
export function readSettings() {
  return normalizeSettings(readPersisted(SETTINGS_KEY, null))
}

/** Persist the whole settings object. */
export function writeSettings(settings) {
  writePersisted(SETTINGS_KEY, settings)
}
