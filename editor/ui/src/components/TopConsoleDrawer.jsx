import React from 'react'
import { useEditorStore } from '../store.js'
import ConsolePanel from './ConsolePanel.jsx'

export default function TopConsoleDrawer(){
  const open = useEditorStore((s) => s.consoleOpen)

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '32vh',
        maxHeight: '50vh',
        transform: open ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 160ms ease-in-out',
        background: '#0b0d12',
        borderBottom: '1px solid #232636',
        boxShadow: '0 6px 16px rgba(0,0,0,0.5)',
        zIndex: 1000,
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <ConsolePanel />
    </div>
  )
}
