import React, { useEffect, useRef, useState } from 'react'
import Modal from './Modal.jsx'

/**
 * Save dialog. Now on the shared Modal, which gives it real dialog
 * semantics, a focus trap, an Escape that works from anywhere inside it
 * rather than only from the text field, and a z-index that puts it above the
 * console drawer instead of underneath.
 */
export default function SaveShowDialog({ open, onClose, onSave, defaultName }) {
  const [filename, setFilename] = useState(defaultName || 'show')
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) setFilename(defaultName || 'show')
  }, [open, defaultName])

  const handleSave = () => {
    onSave(filename.trim() || 'show')
    onClose()
  }

  return (
    <Modal
      open={open}
      title="Save Show"
      onClose={onClose}
      width={420}
      initialFocusRef={inputRef}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={handleSave}>Save</button>
        </>
      }
    >
      <label htmlFor="save-show-name" style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>
        Filename
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          id="save-show-name"
          ref={inputRef}
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
          style={{ flex: 1, padding: '8px 12px', fontSize: 14 }}
        />
        <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>.json</span>
      </div>
    </Modal>
  )
}
