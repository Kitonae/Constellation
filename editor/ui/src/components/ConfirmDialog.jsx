import React, { useRef } from 'react'
import Modal from './Modal.jsx'
import { useEditorStore } from '../store.js'

/**
 * The styled replacement for `window.confirm`.
 *
 * A native confirm in a Wails webview is an unstyled OS modal that steals
 * focus and gives it back nowhere. It was also inconsistent: New Show and
 * Quit asked, while deleting a clip or a media asset (which also deletes
 * every timeline instance) happened silently.
 */
export function ConfirmDialog({ open, title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger, onConfirm, onCancel }) {
  const cancelRef = useRef(null)
  const confirmRef = useRef(null)

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      // A destructive prompt opens with Cancel focused: Enter should not
      // delete anything the user has not read.
      initialFocusRef={danger ? cancelRef : confirmRef}
      actions={
        <>
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{message}</div>
    </Modal>
  )
}

/**
 * Renders whatever `askConfirm()` is currently waiting on.
 *
 * Mounted once by App, so any code path — including ones that are not React
 * components — can `await askConfirm(...)` and get a real dialog.
 */
export default function ConfirmHost() {
  const req = useEditorStore((s) => s.confirmRequest)
  const resolveConfirm = useEditorStore((s) => s.resolveConfirm)
  if (!req) return null
  return (
    <ConfirmDialog
      open
      title={req.title}
      message={req.message}
      confirmLabel={req.confirmLabel}
      cancelLabel={req.cancelLabel}
      danger={req.danger}
      onConfirm={() => resolveConfirm(true)}
      onCancel={() => resolveConfirm(false)}
    />
  )
}
