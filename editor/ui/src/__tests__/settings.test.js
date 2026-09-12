import { describe, it, expect, beforeEach } from 'vitest'
import {
  SETTINGS_SCHEMA,
  DEFAULT_SETTINGS,
  isValidSetting,
  normalizeSettings,
  readSettings,
  writeSettings,
} from '../settings.js'
import { THEMES } from '../theme.js'

describe('settings schema', () => {
  it('gives every setting a default that is one of its own options', () => {
    for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
      expect(spec.options.length, `${key} needs options`).toBeGreaterThan(1)
      expect(isValidSetting(key, spec.default), `${key} default is not an option`).toBe(true)
    }
  })

  it('defaults the grid to dots and the theme to signal', () => {
    expect(DEFAULT_SETTINGS.gridStyle).toBe('dots')
    expect(DEFAULT_SETTINGS.theme).toBe('signal')
  })

  it('offers every theme that exists', () => {
    const offered = SETTINGS_SCHEMA.theme.options.map((o) => o.value).sort()
    expect(offered).toEqual(Object.keys(THEMES).sort())
  })

  it('accepts only the declared grid styles', () => {
    expect(isValidSetting('gridStyle', 'dots')).toBe(true)
    expect(isValidSetting('gridStyle', 'lines')).toBe(true)
    expect(isValidSetting('gridStyle', 'hexagons')).toBe(false)
    expect(isValidSetting('nonexistent', 'dots')).toBe(false)
  })
})

// Local storage outlives the code that wrote it, so a value that has since
// been renamed or hand-edited must not reach a component that assumes one of
// a fixed set.
describe('normalizeSettings', () => {
  it('keeps a valid stored value', () => {
    expect(normalizeSettings({ gridStyle: 'lines' }).gridStyle).toBe('lines')
  })

  it('falls back to the default for an unrecognised value', () => {
    expect(normalizeSettings({ gridStyle: 'hexagons' }).gridStyle).toBe('dots')
  })

  it('drops keys that are not settings', () => {
    const out = normalizeSettings({ gridStyle: 'lines', legacyThing: 42 })
    expect(out.gridStyle).toBe('lines')
    expect('legacyThing' in out).toBe(false)
    // Asserted against the schema rather than a literal object, so adding a
    // setting does not fail this test.
    expect(Object.keys(out).sort()).toEqual(Object.keys(SETTINGS_SCHEMA).sort())
  })

  it('survives null, a non-object, and a missing key', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })
})

describe('settings persistence', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('round-trips through local storage', () => {
    writeSettings({ gridStyle: 'lines' })
    expect(readSettings().gridStyle).toBe('lines')
  })

  it('returns defaults when nothing is stored', () => {
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults when the stored value is corrupt', () => {
    window.localStorage.setItem('constellation.editor.settings', '{not json')
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
