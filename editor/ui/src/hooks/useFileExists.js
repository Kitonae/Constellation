import { useEffect, useState } from 'react'
import { checkFileExists, peekFileExists } from '../utils/fileExists.js'

/**
 * Does the asset's file still exist? `true`, `false`, or `null` for unknown.
 *
 * `enabled` lets a list skip the probe for rows that are scrolled out or
 * already known-bad.
 */
export default function useFileExists(uri, enabled = true) {
  const [exists, setExists] = useState(() => peekFileExists(uri))

  useEffect(() => {
    let cancelled = false
    const cached = peekFileExists(uri)
    setExists(cached)
    if (!uri || !enabled || cached !== null) return
    checkFileExists(uri).then((res) => { if (!cancelled) setExists(res) })
    return () => { cancelled = true }
  }, [uri, enabled])

  return exists
}
