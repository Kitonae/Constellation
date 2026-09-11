import { useCallback, useEffect, useRef, useState } from 'react'

const PREFIX = 'constellation.editor.'

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}

function write(key, value) {
  try { window.localStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* private mode, quota */ }
}

/**
 * `useState` that survives a restart.
 *
 * Every read and write is guarded: under Wails the origin differs between
 * `wails://` and the dev server, and storage can be unavailable entirely.
 * A failure just means the fallback is used, never a crash.
 */
export default function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => read(key, initial))
  const keyRef = useRef(key)

  useEffect(() => {
    if (keyRef.current === key) return
    keyRef.current = key
    setValue(read(key, initial))
    // `initial` is intentionally not a dependency: callers pass literals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const set = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next
      write(keyRef.current, resolved)
      return resolved
    })
  }, [])

  return [value, set]
}

export { read as readPersisted, write as writePersisted }
