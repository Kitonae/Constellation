import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../../store.js'

const SCRUB_THRESHOLD_PX = 2

/**
 * A numeric property field.
 *
 * Edits a local draft string and commits on blur or Enter. A fully
 * controlled version once called parseFloat on every keystroke, so clearing
 * the field or typing a lone minus sign wrote NaN straight into the
 * document: a clip start became NaN and the clip vanished, and a resolution
 * field transiently became 0, which closed the output window. It also
 * produced one undo entry and one snapshot push per character.
 *
 * Added since: a prefix (X/Y/W/H) and a unit inside the field, so paired
 * inputs are no longer two identical boxes under one shared label; and
 * drag-to-scrub on the prefix, wrapped in an undo batch so a whole drag is
 * one history entry.
 *
 * It is a text input rather than `type=number` to make room for the
 * adornments, so Arrow key stepping is implemented here.
 */
export default function NumberInput({
  value,
  onChange,
  step = 0.1,
  min,
  max,
  prefix,
  unit,
  displayScale = 1,
  mixed = false,
  scrubLabel,
  disabled = false,
  style,
}) {
  const toDisplay = (v) => (Number.isFinite(Number(v)) ? Number(v) * displayScale : 0)
  const fromDisplay = (v) => v / displayScale

  const format = (v) => {
    const n = toDisplay(v)
    // Trim float noise from the scale conversion without truncating input.
    return String(Math.round(n * 1e6) / 1e6)
  }

  const [text, setText] = useState(() => (mixed ? '' : format(value)))
  const focused = useRef(false)
  const scrubRef = useRef(null)

  useEffect(() => {
    if (!focused.current && !scrubRef.current) setText(mixed ? '' : format(value))
    // `format` closes over displayScale only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, mixed, displayScale])

  const clampValue = (n) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))

  const commit = () => {
    const n = parseFloat(text)
    if (!Number.isFinite(n)) { setText(mixed ? '' : format(value)); return }
    const clamped = clampValue(n)
    setText(String(clamped))
    const next = fromDisplay(clamped)
    if (next !== value) onChange(next)
  }

  const bump = (dir, e) => {
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
    const base = Number.isFinite(parseFloat(text)) ? parseFloat(text) : toDisplay(value)
    const next = clampValue(base + dir * step * displayScale * mult)
    setText(String(Math.round(next * 1e6) / 1e6))
    onChange(fromDisplay(next))
  }

  // --- Drag-to-scrub on the prefix ---------------------------------------

  const onScrubDown = (e) => {
    if (disabled) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
    scrubRef.current = { x: e.clientX, startValue: toDisplay(value), moved: false }
    // One history entry for the whole drag, not one per pointermove.
    useEditorStore.getState().beginUndoBatch(scrubLabel || 'Edit')
  }

  const onScrubMove = (e) => {
    const s = scrubRef.current
    if (!s) return
    const dx = e.clientX - s.x
    if (!s.moved && Math.abs(dx) < SCRUB_THRESHOLD_PX) return
    s.moved = true
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
    const next = clampValue(s.startValue + dx * step * displayScale * mult)
    setText(String(Math.round(next * 1e6) / 1e6))
    onChange(fromDisplay(next))
  }

  const endScrub = (e, cancel = false) => {
    const s = scrubRef.current
    if (!s) return
    scrubRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { }
    useEditorStore.getState().endUndoBatch({ cancel })
    if (cancel) setText(mixed ? '' : format(value))
  }

  return (
    <div className="num-field" style={style}>
      {prefix && (
        <span
          className="num-field__prefix"
          title={`${prefix} — drag to change, Shift for ×10, Alt for ×0.1`}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={(e) => endScrub(e)}
          onPointerCancel={(e) => endScrub(e, true)}
        >
          {prefix}
        </span>
      )}
      <input
        className="num-field__input"
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={mixed ? '—' : undefined}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur() }
          else if (e.key === 'Escape') { setText(mixed ? '' : format(value)); e.currentTarget.blur() }
          // The text input has no native spinner, so stepping lives here.
          else if (e.key === 'ArrowUp') { e.preventDefault(); bump(1, e) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1, e) }
        }}
      />
      {unit && <span className="num-field__unit">{unit}</span>}
    </div>
  )
}
