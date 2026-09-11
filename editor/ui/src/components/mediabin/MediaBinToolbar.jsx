import React from 'react'
import { KIND_ICON, KIND_LABEL } from '../../media/kind.js'

const KINDS = ['image', 'video', 'audio', 'model']

/** Search, sort and kind filters for the media bin. */
export default function MediaBinToolbar({ view, setView, onAddNew, count, total }) {
  const toggleKind = (k) => {
    const set = new Set(view.kinds || [])
    if (set.has(k)) set.delete(k); else set.add(k)
    setView({ ...view, kinds: [...set] })
  }

  return (
    <div className="media-bin__toolbar">
      <div className="panel__head">
        <span className="panel__title">Sources</span>
        <span className="panel__count">
          {count === total ? total : `${count} / ${total}`}
        </span>
        <button
          type="button"
          className="btn btn--ghost panel__head-action"
          title="Add New"
          aria-label="Add New"
          onClick={onAddNew}
        >
          Add
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="search"
          value={view.query || ''}
          placeholder="Search…"
          aria-label="Search media"
          onChange={(e) => setView({ ...view, query: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          style={{ flex: 1, minWidth: 0 }}
        />
        <select
          value={view.sort || 'added'}
          aria-label="Sort media"
          title="Sort"
          onChange={(e) => setView({ ...view, sort: e.target.value })}
          style={{ width: 'auto', fontSize: 11 }}
        >
          <option value="added">Newest</option>
          <option value="name">Name</option>
          <option value="type">Type</option>
        </select>
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`chip${view.kinds?.includes(k) ? ' is-active' : ''}`}
            aria-pressed={view.kinds?.includes(k) || false}
            title={`Show only ${KIND_LABEL[k]}`}
            onClick={() => toggleKind(k)}
          >
            <span className="ms" style={{ fontSize: 11, verticalAlign: '-1px', marginRight: 3 }} aria-hidden="true">{KIND_ICON[k]}</span>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
    </div>
  )
}
