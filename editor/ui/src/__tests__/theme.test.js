import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { THEMES, DEFAULT_THEME, colors, colorsFor, cssVarName, zIndex } from '../theme.js'

// The test runs under jsdom, where import.meta.url is an http URL, so this
// resolves from the vitest root (editor/ui) instead.
const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
/** The declaration block for a theme: `:root` for the default, `[data-theme=...]` otherwise. */
function blockFor(themeId) {
  const selector = themeId === DEFAULT_THEME ? ':root {' : `[data-theme='${themeId}'] {`
  const at = css.indexOf(selector)
  if (at === -1) return null
  return css.slice(at, css.indexOf('}', at))
}

function varValueIn(block, name) {
  const m = block.match(new RegExp(`${name}\s*:\s*([^;]+);`))
  return m ? m[1].trim() : null
}

const rootBlock = blockFor(DEFAULT_THEME)

function varValue(name) {
  return varValueIn(rootBlock, name)
}

describe('theme tokens', () => {
  // theme.js is the JS mirror of the :root block. They drift silently
  // otherwise, and then half the app is one shade off the other half.
  it('every colour token exists in styles.css with the same value', () => {
    for (const [key, value] of Object.entries(colors)) {
      const name = cssVarName(key)
      expect(varValue(name), `${name} missing from styles.css`).toBe(value)
    }
  })

  // The CSS blocks are generated from these tables, so a hand-edit to either
  // side shows up here rather than as one theme being half-applied.
  it.each(Object.keys(THEMES))('theme %s matches its styles.css block', (themeId) => {
    const block = blockFor(themeId)
    expect(block, `no declaration block for ${themeId}`).toBeTruthy()
    for (const [key, value] of Object.entries(THEMES[themeId])) {
      const name = cssVarName(key)
      expect(varValueIn(block, name), `${name} missing from ${themeId}`).toBe(value)
    }
  })

  it('gives every theme the same token names, so none falls back mid-palette', () => {
    const expected = Object.keys(THEMES[DEFAULT_THEME]).sort()
    for (const [id, table] of Object.entries(THEMES)) {
      expect(Object.keys(table).sort(), `${id} token set differs`).toEqual(expected)
    }
  })

  it('falls back to the default theme for an unknown id', () => {
    expect(colorsFor('nonexistent')).toBe(THEMES[DEFAULT_THEME])
    expect(colorsFor(undefined)).toBe(THEMES[DEFAULT_THEME])
    expect(colorsFor('ink')).toBe(THEMES.ink)
  })

  it('every z-index layer exists in styles.css with the same value', () => {
    for (const [key, value] of Object.entries(zIndex)) {
      const name = `--z-${key}`
      expect(varValue(name), `${name} missing from styles.css`).toBe(String(value))
    }
  })

  it('maps camelCase keys to kebab-case variables', () => {
    expect(cssVarName('accentYellow')).toBe('--accent-yellow')
    expect(cssVarName('text')).toBe('--text')
  })
})
