import React from 'react'

export default function Spinner({ size = 16, color = '#6aa0ff', stroke = 3, label = null }) {
  const s = Math.max(8, size)
  const r = (s - stroke) / 2
  return (
    <div style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ animation: 'spin 1s linear infinite', display:'block' }}>
        <circle cx={s/2} cy={s/2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${Math.PI * r} ${Math.PI * r}`} />
      </svg>
      {label ? <span style={{ fontSize:12, color:'#b9c3d6' }}>{label}</span> : null}
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

