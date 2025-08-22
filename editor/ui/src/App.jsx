import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from './store.js'
import Viewport3D from './components/Viewport.jsx'
import Viewport2D from './components/Viewport2D.jsx'
import Timeline from './components/Timeline.jsx'
import MediaBin from './components/MediaBin.jsx'
import Inspector from './components/Inspector.jsx'
import { openImageDialog } from './utils/tauriCompat.js'
import TopConsoleDrawer from './components/TopConsoleDrawer.jsx'
import GlobalTicker from './components/GlobalTicker.jsx'
import MenuBar from './components/MenuBar.jsx'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, playing, play, pause, time, selectedId, setSelected, gizmoMode, setGizmoMode, project, scene, addImageToShow, toggleConsole, addLog, viewMode, setViewMode } = useEditorStore()
  const [fileName, setFileName] = useState('')
  const [addr, setAddr] = useState('http://127.0.0.1:50051')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const onKey = (e) => {
      // Toggle console on backquote/tilde key
      if (e.code === 'Backquote') {
        const t = e.target
        // ignore when typing in inputs/textareas/contenteditable
        const tag = (t?.tagName || '').toLowerCase()
        const isEditable = t?.isContentEditable || tag === 'input' || tag === 'textarea'
        if (isEditable) return
        e.preventDefault()
        toggleConsole()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleConsole])

  const onFile = async (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const text = await f.text()
    try {
      const data = JSON.parse(text)
      loadProject(data)
    } catch (err) {
      alert('Invalid JSON: ' + err)
    }
  }

  return (
    <div className="layout">
      <header>
        <MenuBar
          onOpenProject={() => fileRef.current?.click()}
          onAddImage={onAddImage}
          viewMode={viewMode}
          setViewMode={setViewMode}
          gizmoMode={gizmoMode}
          setGizmoMode={setGizmoMode}
          onDeselect={() => setSelected(null)}
          addr={addr}
          setAddr={setAddr}
          onApply={async ()=>{
            try {
              const wrapper = buildProjectWrapper(project, scene)
              const message = await window.__TAURI__.invoke('apply_project', { addr, projectJson: JSON.stringify(wrapper) })
              setStatus('Applied: ' + message)
              addLog({ level:'info', message:`Applied project to ${addr}: ${message}` })
            } catch (e) {
              setStatus('Apply failed: ' + e)
              addLog({ level:'error', message:`Apply failed: ${e}` })
            }
          }}
          onRemotePlay={async ()=>{ try { const msg = await window.__TAURI__.invoke('play', { addr }); setStatus('Play: '+msg) } catch(e){ setStatus('Play failed: '+e) } }}
          onRemotePause={async ()=>{ try { const msg = await window.__TAURI__.invoke('pause', { addr }); setStatus('Pause: '+msg) } catch(e){ setStatus('Pause failed: '+e) } }}
          onRemoteStop={async ()=>{ try { const msg = await window.__TAURI__.invoke('stop', { addr }); setStatus('Stop: '+msg) } catch(e){ setStatus('Stop failed: '+e) } }}
        />
        <input type="file" accept="application/json" onChange={onFile} ref={fileRef} style={{ display: 'none' }} />
        <div style={{marginTop:6, fontSize:12, opacity:0.8, display:'flex', gap:12}}>
          {selectedId && <div>Selected: {selectedId}</div>}
          {fileName && <div style={{opacity:0.7}}>{fileName}</div>}
          {status && <div style={{marginLeft:'auto'}}>{status}</div>}
        </div>
      </header>
      <main>
        <div className="panel">{viewMode === '2d' ? <Viewport2D /> : <Viewport3D />}</div>
        <div className="panel" style={{ display:'grid', gridTemplateRows:'1fr auto' }}>
          <div style={{ overflow:'auto' }}><Inspector /></div>
          <div style={{ borderTop:'1px solid #232636' }}><MediaBin /></div>
        </div>
      </main>
      <footer className="panel timeline"><Timeline /></footer>
      <TopConsoleDrawer />
      <GlobalTicker />
    </div>
  )
}

function buildProjectWrapper(project, scene){
  if(!project || !scene){ throw new Error('No project loaded') }
  // Reconstruct a JSON payload similar to examples/scene.example.json
  return {
    project: {
      id: project.id,
      name: project.name,
      scene: scene,
      media: project.media ?? [],
      timeline: project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: 60 }
    }
  }
}

async function onAddImage() {
  try {
    // Use Tauri dialog to get a file path for the image
    const filePath = await openImageDialog()
    if (!filePath) return
    // Infer name from path
    const name = String(filePath).split(/[\\\/]/).pop()
    // Dispatch into store
    useEditorStore.getState().addImageToShow({ filePath, name, duration: 10 })
    useEditorStore.getState().addLog({ level:'info', message:`Added image: ${name}` })
  } catch (e) {
    console.error(e)
    useEditorStore.getState().addLog({ level:'error', message:`Failed to add image: ${e}` })
    alert('Failed to add image: ' + e)
  }
}
