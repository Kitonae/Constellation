// Is the app running inside the Wails webview, or in a plain browser?
//
// Every backend call site used to double as its own capability check
// (`window.go?.main?.App?.X`), which degraded gracefully when the app was
// opened in a browser — `vite dev` on 5173, the Playwright suite, and the
// display windows. Wails v3 bindings are ES imports, so the import always
// resolves and the call fails at runtime instead. This is the explicit check
// that takes over that job.
//
// Note `window._wails` is NOT the signal to use: @wailsio/runtime creates it
// (`window._wails = window._wails || {}`) as an import side effect in any DOM,
// browser included. What actually distinguishes a webview is the presence of a
// native message transport, which is the same test the runtime itself applies
// before deciding it is in "browser preview" mode.
export function isWails() {
  if (typeof window === 'undefined') return false
  try {
    // Windows WebView2
    if (window.chrome?.webview?.postMessage) return true
    // macOS / iOS WKWebView
    if (window.webkit?.messageHandlers?.external?.postMessage) return true
    // Android WebView
    if (window.wails?.invoke) return true
  } catch { /* cross-origin or locked-down window */ }
  return false
}

export default isWails
