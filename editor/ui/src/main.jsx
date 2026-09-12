// Signal's two faces, bundled rather than fetched from Google Fonts: the
// desktop shell has to render correctly with no network.
import '@fontsource/barlow-semi-condensed/400.css'
import '@fontsource/barlow-semi-condensed/500.css'
import '@fontsource/barlow-semi-condensed/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import 'material-symbols/rounded.css'
import './styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import DisplayWindow from './components/DisplayWindow.jsx'
import { readSettings } from './settings.js'
import { applyTheme } from './theme.js'
import { setFileServerBase } from './media/uri.js'

// Apply the saved theme before the first paint. Doing this in a React effect
// instead would render one frame in the default palette and then swap.
applyTheme(readSettings().theme)

const params = new URLSearchParams(window.location.search)
const isDisplay = params.get('display') === '1'

// An output window is a plain browser page: the store's Wails-only startup,
// which asks Go for the sidecar port, never runs here, so the file resolver
// started with an empty base and every local image and video resolved to
// nothing. The page was served by the sidecar, so that origin is the base,
// and the editor put the session token in the URL.
if (isDisplay && /^https?:/.test(window.location.origin)) {
  setFileServerBase(window.location.origin, params.get('token') || '')
}

const root = createRoot(document.getElementById('root'))
root.render(isDisplay ? <DisplayWindow /> : <App />)

