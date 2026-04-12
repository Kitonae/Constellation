// Shared log helper for slices that need to enqueue log entries
// without a direct reference to the store setter.
//
// The store reference is injected after creation via setStoreRef().

let _storeRef = null

export function setStoreRef(store) {
  _storeRef = store
}

export function queueLog(level, message) {
  try {
    const fn = _storeRef?.getState()?.addLog
    if (fn) fn({ level, message })
  } catch { }
}
