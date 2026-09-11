import React, { useRef, useState } from 'react'

/**
 * A draggable pane divider.
 *
 * Replaces three near-identical blocks of pointer-capture maths in App, each
 * an invisible 6px strip positioned outside its panel. This one is a real
 * element in the flex row, has a visible line, responds to the keyboard, and
 * reports itself to assistive tech as a separator.
 *
 * `invert` is for the right-hand pane, where dragging left must *increase*
 * the width.
 */
export default function Splitter({
  orientation = 'vertical',
  value,
  min = 0,
  max = Infinity,
  invert = false,
  onChange,
  onDoubleClick,
  label,
  step = 10,
  largeStep = 50,
}) {
  const dragRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const vertical = orientation === 'vertical'

  const clamp = (v) => Math.max(min, Math.min(max, v))

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    dragRef.current = { start: vertical ? e.clientX : e.clientY, startValue: value }
    setDragging(true)
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const delta = (vertical ? e.clientX : e.clientY) - d.start
    onChange?.(clamp(d.startValue + (invert ? -delta : delta)))
    e.preventDefault()
  }

  const endDrag = (e) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
  }

  const onKeyDown = (e) => {
    const amount = e.shiftKey ? largeStep : step
    const back = vertical ? 'ArrowLeft' : 'ArrowUp'
    const fwd = vertical ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back) { e.preventDefault(); onChange?.(clamp(value + (invert ? amount : -amount))) }
    else if (e.key === fwd) { e.preventDefault(); onChange?.(clamp(value + (invert ? -amount : amount))) }
    else if (e.key === 'Home') { e.preventDefault(); onChange?.(min) }
    else if (e.key === 'End') { e.preventDefault(); onChange?.(Math.min(max, 1e6)) }
    else if (e.key === 'Enter') { e.preventDefault(); onDoubleClick?.() }
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Number.isFinite(max) ? Math.round(max) : undefined}
      title={`${label} — drag to resize, double-click to collapse`}
      className={`splitter splitter--${vertical ? 'v' : 'h'}${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  )
}
