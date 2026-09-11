import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

const SRC = resolve(process.cwd(), 'src')

/**
 * Files whose hex values are not UI chrome and must stay literal:
 * three.js material colours, canvas paint, the output window's true black,
 * document data, and the token definitions themselves.
 */
const ALLOWED = new Set([
  'theme.js',
  join('components', 'Viewport.jsx'),
  join('components', 'DisplayWindow.jsx'),
  join('components', 'viewport2d', 'dotGridBg.js'),
  join('media', 'asset.js'),
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Generated Wails bindings live outside src/ (ui/bindings/), so only the
    // test directory needs skipping here.
    if (name === '__tests__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.jsx?$/.test(name)) out.push(full)
  }
  return out
}

describe('colour tokens', () => {
  // Colours drift when they are retyped. Everything that paints UI chrome
  // goes through a CSS variable so there is one place to change it.
  it('no component hardcodes a hex colour', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file)
      if (ALLOWED.has(rel) || ALLOWED.has(rel.split(sep).pop())) continue
      const hits = readFileSync(file, 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g)
      if (hits) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders, `use a var(--token) from styles.css instead:\n${offenders.join('\n')}`).toEqual([])
  })
})
