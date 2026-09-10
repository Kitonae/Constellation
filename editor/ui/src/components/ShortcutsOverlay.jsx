import React from 'react'
import Modal from './Modal.jsx'
import { useEditorStore } from '../store.js'
import { shortcutsByCategory } from '../shortcuts.js'

/**
 * The keyboard reference, generated from the same table the key handler and
 * the menu accelerators read. There was previously nowhere in the app that
 * listed a shortcut.
 */
export default function ShortcutsOverlay() {
  const open = useEditorStore((s) => s.shortcutsHelpOpen)
  const toggle = useEditorStore((s) => s.toggleShortcutsHelp)
  if (!open) return null

  return (
    <Modal
      open
      title="Keyboard Shortcuts"
      onClose={toggle}
      width={560}
      actions={<button type="button" className="btn btn--primary" onClick={toggle}>Close</button>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 24px' }}>
        {shortcutsByCategory().map(({ category, items }) => (
          <section key={category}>
            <h3 style={{ margin: '0 0 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
              {category}
            </h3>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', alignItems: 'center' }}>
              {items.map((s) => (
                <React.Fragment key={s.id}>
                  <dt><span className="kbd">{s.keys}</span></dt>
                  <dd style={{ margin: 0, fontSize: 12 }}>{s.label}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}
