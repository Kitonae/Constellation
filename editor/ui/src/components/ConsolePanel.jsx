import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../store.js'

function formatTime(ts) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export default function ConsolePanel() {
  const logs = useEditorStore((s) => s.logs)
  const clearLogs = useEditorStore((s) => s.clearLogs)
  const addLog = useEditorStore((s) => s.addLog)
  const toggleConsole = useEditorStore((s) => s.toggleConsole)
  const consoleOpen = useEditorStore((s) => s.consoleOpen)
  const [cmd, setCmd] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)

  const items = useMemo(() => logs.slice(-300), [logs])

  useEffect(() => {
    // autoscroll to bottom on new logs
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    // focus input when console opens
    if (consoleOpen && inputRef.current) {
      inputRef.current.focus()
      // move caret to end
      const v = inputRef.current.value
      inputRef.current.value = ''
      inputRef.current.value = v
    }
  }, [consoleOpen])

  const runCommand = (text) => {
    const raw = String(text || '').trim()
    if (!raw) return
    const input = raw.toLowerCase()
    addLog({ level: 'info', message: `> ${raw}` })
    const st = useEditorStore.getState()
    if (input === 'play') {
      st.play(); addLog({ level: 'info', message: 'Playing' })
    } else if (input === 'pause') {
      st.pause(); addLog({ level: 'info', message: 'Paused' })
    } else if (input === 'stop') {
      st.pause(); st.seek(0); addLog({ level: 'info', message: 'Stopped' })
    } else if (input === 'clear') {
      clearLogs()
    } else {
      addLog({ level: 'warn', message: `Unknown command: ${raw}` })
    }
  }

  return (
    <div style={{ display:'grid', gridTemplateRows:'auto 1fr auto', height:'100%', background:'#0b0d12' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 8px', color:'#c7cfdb' }}>
        <div style={{ fontWeight:600 }}>Console</div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ opacity:0.7, fontSize:12 }}>{items.length} messages</div>
          <button onClick={clearLogs}>Clear</button>
        </div>
      </div>
      <div ref={listRef} style={{ overflow:'auto', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12, color:'#b9c3d6' }}>
        {items.length === 0 && <div style={{ opacity:0.7, padding:8 }}>No logs yet.</div>}
        {items.map((l) => (
          <div key={l.id} style={{ display:'flex', gap:8, padding:'2px 8px' }}>
            <span style={{ opacity:0.6 }}>{formatTime(l.time)}</span>
            <span style={{ color: colorForLevel(l.level), textTransform:'uppercase', fontWeight:600 }}>{l.level}</span>
            <span>{l.message}</span>
          </div>
        ))}
      </div>
      <form onSubmit={(e)=>{ e.preventDefault(); runCommand(cmd); setCmd('') }} style={{ padding:'6px 8px', borderTop:'1px solid #232636', display:'flex', gap:8 }}>
        <input
          ref={inputRef}
          value={cmd}
          onChange={(e)=>setCmd(e.target.value)}
          onKeyDown={(e)=>{
            if (e.code === 'Backquote') {
              // Close console and ignore the character
              e.preventDefault();
              e.stopPropagation();
              toggleConsole();
            }
          }}
          placeholder="Type a command: play, pause, stop (or clear)"
          style={{ flex:1, background:'#0f1115', color:'#c7cfdb', border:'1px solid #232636', borderRadius:4, padding:'6px 8px', fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize:12 }}
        />
        <button type="submit">Run</button>
      </form>
    </div>
  )
}

function colorForLevel(level){
  switch(level){
    case 'error': return '#ff6b6b'
    case 'warn': return '#f2c744'
    default: return '#8bc3ff'
  }
}
