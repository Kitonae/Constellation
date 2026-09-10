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

// Wails: handle requests from Go to open display windows
try {
  const rt = (typeof window !== 'undefined') ? (window.runtime || null) : null
  if (rt && typeof rt.EventsOn === 'function') {
    rt.EventsOn('display:open', (payload) => {
      try {
        const sid = payload && payload.screenId
        const w = Math.max(100, (payload && payload.width) | 0)
        const h = Math.max(100, (payload && payload.height) | 0)
        if (!sid) return
        const url = `/?display=1&screenId=${encodeURIComponent(sid)}&w=${w}&h=${h}`
        window.open(url, `display-${sid}`, `width=${w},height=${h},resizable=yes`)
      } catch {}
    })
  }
} catch {}
