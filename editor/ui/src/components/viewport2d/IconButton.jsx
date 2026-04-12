import React from 'react'

export function IconButton({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        width: 32,
        height: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? '#2a3148' : 'transparent',
        color: active ? '#6aa0ff' : '#c7cfdb',
        border: 'none',
        cursor: 'pointer',
        outline: 'none',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#1c202b' }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}
