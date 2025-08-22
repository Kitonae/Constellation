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
import { openDisplayWindow, closeDisplayWindow } from './display/displayManager.js'

export default function App() {
  const fileRef = useRef(null)
  const { loadProject, playing, play, pause, time, selectedId, setSelected, gizmoMode, setGizmoMode, project, scene, addImageToShow, toggleConsole, addLog, viewMode, setViewMode, showOutputOverlay, toggleOutputOverlay, addScreenNode } = useEditorStore()
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
      // Delete selected timeline clip with Delete key
      if (e.key === 'Delete') {
        const t = e.target
        const tag = (t?.tagName || '').toLowerCase()
        const isEditable = t?.isContentEditable || tag === 'input' || tag === 'textarea'
        if (isEditable) return
        const { selectedClipId, removeClip } = useEditorStore.getState()
        if (selectedClipId) {
          e.preventDefault()
          removeClip(selectedClipId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleConsole])

  // Open/close display windows based on enabled screens
  useEffect(() => {
    const roots = scene?.roots || []
    for (const n of roots) {
      if (n.kind?.type === 'screen') {
        const enabled = (n.kind?.enabled ?? true)
        const px = n.kind?.pixels?.[0] || 0
        const py = n.kind?.pixels?.[1] || 0
        if (enabled && px > 0 && py > 0) {
          openDisplayWindow(n.id, px, py)
        } else {
          closeDisplayWindow(n.id)
        }
      }
    }
  }, [scene])

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
          onAddScreen={() => {
            const name = window.prompt('Screen name?', 'Screen') || 'Screen'
            const wStr = window.prompt('Pixels width?', '1920') || '1920'
            const hStr = window.prompt('Pixels height?', '1080') || '1080'
            const w = Math.max(1, parseInt(wStr, 10) || 1920)
            const h = Math.max(1, parseInt(hStr, 10) || 1080)
            addScreenNode({ name, pixels: [w, h] })
          }}
          onSaveShow={async () => {
            try {
              const wrapper = buildProjectWrapper(project, scene)
              if (!window.__TAURI__) { alert('Saving requires Tauri environment'); return }
              const { save } = await import('@tauri-apps/api/dialog')
              const { writeTextFile } = await import('@tauri-apps/api/fs')
              const path = await save({
                title: 'Save Show',
                defaultPath: 'show.json',
                filters: [{ name: 'JSON', extensions: ['json'] }]
              })
              if (!path) return
              await writeTextFile(path, JSON.stringify(wrapper, null, 2))
              setStatus('Saved: ' + path)
              addLog({ level: 'info', message: 'Saved show to ' + path })
            } catch (e) {
              setStatus('Save failed: ' + e)
              addLog({ level: 'error', message: 'Save failed: ' + e })
            }
          }}
          viewMode={viewMode}
          setViewMode={setViewMode}
          gizmoMode={gizmoMode}
          setGizmoMode={setGizmoMode}
          onDeselect={() => setSelected(null)}
          addr={addr}
          setAddr={setAddr}
          showOutputOverlay={showOutputOverlay}
          toggleOutputOverlay={toggleOutputOverlay}
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
