import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { colors, cssVarName, zIndex } from '../theme.js'

// The test runs under jsdom, where import.meta.url is an http URL, so this
// resolves from the vitest root (editor/ui) instead.
const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))

function varValue(name) {
  const m = rootBlock.match(new RegExp(`${name}\s*:\s*([^;]+);`))
  return m ? m[1].trim() : null
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
