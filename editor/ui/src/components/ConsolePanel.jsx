import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../store.js'
import { executeCommand, getCommandNames } from '../console/commands.js'

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
  const [history, setHistory] = useState([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [suggestion, setSuggestion] = useState('')
  const listRef = useRef(null)
  const inputRef = useRef(null)

  const items = useMemo(() => logs.slice(-300), [logs])
  const commandNames = useMemo(() => getCommandNames(), [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    if (consoleOpen && inputRef.current) {
      inputRef.current.focus()
      const v = inputRef.current.value
      inputRef.current.value = ''
      inputRef.current.value = v
    }
  }, [consoleOpen])

  // Update autocomplete suggestion as user types
  useEffect(() => {
    const trimmed = cmd.trimStart().toLowerCase()
    if (!trimmed) { setSuggestion(''); return }
    const match = commandNames.find(n => n.startsWith(trimmed) && n !== trimmed)
    setSuggestion(match || '')
  }, [cmd, commandNames])

  const runCommand = (text) => {
    const raw = String(text || '').trim()
    if (!raw) return
    addLog({ level: 'info', message: `> ${raw}` })
    setHistory(h => [...h.slice(-50), raw])
    setHistoryIdx(-1)
    const results = executeCommand(raw)
    for (const entry of results) {
      addLog(entry)
    }
  }

  const onKeyDown = (e) => {
    if (e.code === 'Backquote') {
      e.preventDefault()
      e.stopPropagation()
      toggleConsole()
      return
    }
    // Tab autocomplete
    if (e.key === 'Tab' && suggestion) {
      e.preventDefault()
      setCmd(suggestion + ' ')
      setSuggestion('')
      return
    }
    // Command history
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(next)
      setCmd(history[next])
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIdx < 0) return
      const next = historyIdx + 1
      if (next >= history.length) {
        setHistoryIdx(-1)
        setCmd('')
      } else {
        setHistoryIdx(next)
        setCmd(history[next])
      }
      return
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', height: '100%', background: '#0b0d12' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', color: '#c7cfdb' }}>
        <div style={{ fontWeight: 600 }}>Console</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ opacity: 0.7, fontSize: 12 }}>{items.length} messages</div>
          <button onClick={clearLogs}>Clear</button>
        </div>
      </div>
      <div ref={listRef} style={{ overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#b9c3d6' }}>
        {items.length === 0 && <div style={{ opacity: 0.7, padding: 8 }}>No logs yet. Type "help" for available commands.</div>}
        {items.map((l) => (
          <div key={l.id} style={{ display: 'flex', gap: 8, padding: '2px 8px' }}>
            <span style={{ opacity: 0.6 }}>{formatTime(l.time)}</span>
            <span style={{ color: colorForLevel(l.level), textTransform: 'uppercase', fontWeight: 600 }}>{l.level}</span>
            <span>{l.message}</span>
          </div>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); runCommand(cmd); setCmd('') }} style={{ padding: '6px 8px', borderTop: '1px solid #232636', display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          {/* Ghost text for autocomplete suggestion */}
          {suggestion && (
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              padding: '6px 8px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12, color: '#4a5674', pointerEvents: 'none',
              whiteSpace: 'pre',
            }}>
              {suggestion}
            </div>
          )}
          <input
            ref={inputRef}
            value={cmd}
            onChange={(e) => { setCmd(e.target.value); setHistoryIdx(-1) }}
            onKeyDown={onKeyDown}
            placeholder='Type a command (try "help")'
            style={{
              width: '100%', background: '#0f1115', color: '#c7cfdb',
              border: '1px solid #232636', borderRadius: 4, padding: '6px 8px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
              position: 'relative', zIndex: 1,
            }}
          />
        </div>
        <button type="submit">Run</button>
      </form>
    </div>
  )
}

function colorForLevel(level) {
  switch (level) {
    case 'error': return '#ff6b6b'
    case 'warn': return '#f2c744'
    default: return '#8bc3ff'
  }
}
