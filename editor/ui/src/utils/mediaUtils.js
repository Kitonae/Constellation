/**
 * Shared media utility functions.
 * Extracted from duplicated copies across App.jsx, store.js, MediaBin.jsx,
 * Viewport2D.jsx, Timeline.jsx, and DisplayWindow.jsx.
 */

/**
 * Converts a local file path to a file:// URI with properly encoded path parts.
 */
export function toFileUri(p) {
  let norm = p.replace(/\\/g, '/')
  const parts = norm.split('/')
  const encodedParts = parts.map(part => encodeURIComponent(part))
  norm = encodedParts.join('/')
  // Restore drive letter colon if it was encoded (e.g. "C%3A" -> "C:")
  norm = norm.replace(/^([a-zA-Z])%3A/, '$1:')
  if (/^[A-Za-z]:\//.test(norm)) return `file:///${norm}`
  if (norm.startsWith('/')) return `file://${norm}`
  return `file://${norm}`
}

/**
 * Converts a File object to a data URL via FileReader.
 */
export async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = (e) => reject(e)
      reader.readAsDataURL(file)
    } catch (e) { reject(e) }
  })
}

/**
 * Detects overlapping clips in a media list.
 * Returns a Set of clip IDs that overlap with at least one other clip.
 */
export function computeOverlaps(mediaList) {
  const overlaps = new Set()
  for (let j = 0; j < mediaList.length; j++) {
    for (let k = j + 1; k < mediaList.length; k++) {
      const m1 = mediaList[j]
      const m2 = mediaList[k]
      const s1 = m1.start ?? m1.start_at_seconds ?? 0
      const d1 = m1.duration ?? ((m1.out_seconds - m1.in_seconds) || 0)
      const e1 = s1 + d1

      const s2 = m2.start ?? m2.start_at_seconds ?? 0
      const d2 = m2.duration ?? ((m2.out_seconds - m2.in_seconds) || 0)
      const e2 = s2 + d2

      if (s1 < e2 && s2 < e1) {
        overlaps.add(m1.id)
        overlaps.add(m2.id)
      }
    }
  }
  return overlaps
}

/**
 * Computes fade opacity for a timeline clip at a given time.
 * Returns a number 0-1 representing the fade multiplier.
 */
export function computeFadeOpacity(tm, currentTime) {
  const start = (tm.start ?? tm.start_at_seconds) || 0
  const dur = Math.max(0, (tm.duration ?? ((tm.out_seconds - tm.in_seconds) || 0)))
  const timeInClip = currentTime - start
  const fadeIn = tm.fade_in ?? 0
  const fadeOut = tm.fade_out ?? 0
  let fadeOpacity = 1

  if (fadeIn > 0 && timeInClip < fadeIn) {
    fadeOpacity = Math.min(1, Math.max(0, timeInClip / fadeIn))
  } else if (fadeOut > 0 && timeInClip > dur - fadeOut) {
    fadeOpacity = Math.min(1, Math.max(0, (dur - timeInClip) / fadeOut))
  }

  return (tm.opacity ?? 1) * fadeOpacity
}

/**
 * Builds a CSS filter string from a timeline clip's effects.
 */
export function buildFilterString(tm) {
  const effects = tm.effects || {}
  const filters = []
  if (tm.blur) filters.push(`blur(${tm.blur}px)`)
  if (effects.blur?.enabled) filters.push(`blur(${effects.blur.value}px)`)
  if (effects.brightness?.enabled) filters.push(`brightness(${effects.brightness.value})`)
  if (effects.contrast?.enabled) filters.push(`contrast(${effects.contrast.value})`)
  if (effects.saturate?.enabled) filters.push(`saturate(${effects.saturate.value})`)
  if (effects.grayscale?.enabled) filters.push(`grayscale(${effects.grayscale.value})`)
  if (effects.sepia?.enabled) filters.push(`sepia(${effects.sepia.value})`)
  if (effects['hue-rotate']?.enabled) filters.push(`hue-rotate(${effects['hue-rotate'].value}deg)`)
  if (effects.invert?.enabled) filters.push(`invert(${effects.invert.value})`)
  return filters.length ? filters.join(' ') : 'none'
}
