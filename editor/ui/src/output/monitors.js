import { Screens } from '@wailsio/runtime'
import { isWails } from '../wails/env.js'
import { normalizeMonitors, browserMonitors } from './placement.js'

// The desktop's displays, asked of the Wails runtime and cached so that the
// display manager can position a web window without waiting on it.
let cached = null

export function getCachedMonitors() {
  return cached || browserMonitors()
}

/** Ask the OS again. Resolves to the normalised list and updates the cache. */
export async function loadMonitors() {
  if (!isWails()) {
    cached = browserMonitors()
    return cached
  }
  try {
    const list = normalizeMonitors(await Screens.GetAll())
    cached = list.length ? list : browserMonitors()
  } catch (e) {
    console.warn('Screens.GetAll failed', e)
    cached = cached || browserMonitors()
  }
  return cached
}
