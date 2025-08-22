import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import DisplayWindow from './components/DisplayWindow.jsx'

const params = new URLSearchParams(window.location.search)
const isDisplay = params.get('display') === '1'
const root = createRoot(document.getElementById('root'))
root.render(isDisplay ? <DisplayWindow /> : <App />)
