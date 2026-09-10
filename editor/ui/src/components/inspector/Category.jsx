import React from 'react'
import usePersistentState from '../../hooks/usePersistentState.js'

/**
 * A collapsible property group.
 *
 * Open state is persisted per title: it used to be component-local, so it
 * reset every time the selection changed type and the section unmounted.
 */
export default function Category({ title, children, defaultOpen = true, actions }) {
  const [open, setOpen] = usePersistentState(`inspector.category.${title}`, defaultOpen)

  return (
    <div className="category">
      <button
        type="button"
        className="category__header"
        aria-expanded={!!open}
        onClick={() => setOpen(!open)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ms category__chevron" aria-hidden="true">chevron_right</span>
          {title}
        </span>
        {actions && <span onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </button>
      {open && <div className="category__body">{children}</div>}
    </div>
  )
}
