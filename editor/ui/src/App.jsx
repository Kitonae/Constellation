import React, { useRef, useState } from 'react'
import { useEditorStore } from './store.js'
import Viewport from './components/Viewport.jsx'
import Timeline from './components/Timeline.jsx'
import MediaBin from './components/MediaBin.jsx'
import Inspector from './components/Inspector.jsx'
import { openImageDialog } from './utils/tauriCompat.js'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, playing, play, pause, time, selectedId, setSelected, gizmoMode, setGizmoMode, project, scene, addImageToShow } = useEditorStore()
  const [fileName, setFileName] = useState('')
  const [addr, setAddr] = useState('http://127.0.0.1:50051')
  const [status, setStatus] = useState('')

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
        <div className="toolbar">
          <input type="file" accept="application/json" onChange={onFile} ref={fileRef} />
          <button onClick={onAddImage}>Add Image</button>
          <button onClick={playing ? pause : play}>{playing ? 'Pause' : 'Play'}</button>
          <div style={{marginLeft:'8px'}}>Time: {time.toFixed(2)}s</div>
          <div style={{marginLeft:'12px', display:'flex', gap:6}}>
            <button onClick={() => setGizmoMode('translate')} style={{opacity: gizmoMode==='translate'?1:0.6}}>Move</button>
            <button onClick={() => setGizmoMode('rotate')} style={{opacity: gizmoMode==='rotate'?1:0.6}}>Rotate</button>
            <button onClick={() => setGizmoMode('scale')} style={{opacity: gizmoMode==='scale'?1:0.6}}>Scale</button>
          </div>
          <button style={{marginLeft:'8px'}} onClick={() => setSelected(null)}>Deselect</button>
          {selectedId && <div style={{marginLeft:'8px', opacity:0.8}}>Selected: {selectedId}</div>}
          {fileName && <div style={{marginLeft:'12px', opacity:0.7}}>{fileName}</div>}
          <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:6}}>
            <input value={addr} onChange={(e)=>setAddr(e.target.value)} style={{ width: 220, background:'#0f1115', color:'#e6e6e6', border:'1px solid #232636', borderRadius:4, padding:'4px 6px' }} />
            <button onClick={async ()=>{
              try {
                const wrapper = buildProjectWrapper(project, scene)
                const message = await window.__TAURI__.invoke('apply_project', { addr, projectJson: JSON.stringify(wrapper) })
                setStatus('Applied: ' + message)
              } catch (e) {
                setStatus('Apply failed: ' + e)
              }
            }}>Apply to Display</button>
            <button onClick={async ()=>{ try { const msg = await window.__TAURI__.invoke('play', { addr }); setStatus('Play: '+msg) } catch(e){ setStatus('Play failed: '+e) } }}>Play</button>
            <button onClick={async ()=>{ try { const msg = await window.__TAURI__.invoke('pause', { addr }); setStatus('Pause: '+msg) } catch(e){ setStatus('Pause failed: '+e) } }}>Pause</button>
            <button onClick={async ()=>{ try { const msg = await window.__TAURI__.invoke('stop', { addr }); setStatus('Stop: '+msg) } catch(e){ setStatus('Stop failed: '+e) } }}>Stop</button>
          </div>
        </div>
        {status && <div style={{marginTop:6, fontSize:12, opacity:0.8}}>{status}</div>}
      </header>
      <main>
        <div className="panel"><Viewport /></div>
        <div className="panel" style={{ display:'grid', gridTemplateRows:'1fr auto' }}>
          <div style={{ overflow:'auto' }}><Inspector /></div>
          <div style={{ borderTop:'1px solid #232636' }}><MediaBin /></div>
        </div>
      </main>
      <footer className="panel timeline"><Timeline /></footer>
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
  } catch (e) {
    console.error(e)
    alert('Failed to add image: ' + e)
  }
}
