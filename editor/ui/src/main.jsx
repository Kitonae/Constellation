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

const params = new URLSearchParams(window.location.search)
const isDisplay = params.get('display') === '1'
const root = createRoot(document.getElementById('root'))
root.render(isDisplay ? <DisplayWindow /> : <App />)

