import React from 'react'

/**
 * The keyframes live in styles.css: this component used to inject a `<style>`
 * tag into its own output, so every mounted spinner added another copy.
 */
export default function Spinner({ size = 16, color = 'var(--accent)', stroke = 3, label = null }) {
  const s = Math.max(8, size)
  const r = (s - stroke) / 2
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} className="spinner" style={{ display: 'block' }}>
        <circle cx={s / 2} cy={s / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${Math.PI * r} ${Math.PI * r}`} />
      </svg>
      {label ? <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span> : null}
    </div>
  )
}
