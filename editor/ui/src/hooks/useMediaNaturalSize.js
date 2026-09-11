import { useEffect, useState } from 'react'
import { getNaturalSize, peekNaturalSize } from '../media/naturalSize.js'

/**
 * Natural pixel size of one asset, or null while unknown.
 *
 * Seeded from the cache so a re-selection of an already-probed asset renders
 * its size on the first frame instead of flashing empty.
 */
export default function useMediaNaturalSize(uri, kindHint) {
  const [size, setSize] = useState(() => peekNaturalSize(uri))

  useEffect(() => {
    let cancelled = false
    const cached = peekNaturalSize(uri)
    setSize(cached)
    if (!uri || cached) return
    getNaturalSize(uri, kindHint).then((res) => { if (!cancelled) setSize(res) })
    return () => { cancelled = true }
  }, [uri, kindHint])

  return size
}
