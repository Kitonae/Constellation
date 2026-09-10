import React, { useEffect, useRef, useState } from 'react'

/**
 * One row in the timeline's label column.
 *
 * Tracks used to be an unnameable, unremovable `Track N` — `addTrack` had no
 * counterpart in the store, so a track added by mistake was permanent.
 */
export default function TrackHeader({
  index,
  name,
  clipCount,
  selected,
  height,
  onSelect,
  onRename,
  onContextMenu,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const display = name || `Track ${index + 1}`

  const begin = () => { setDraft(name || ''); setEditing(true) }
  const commit = () => { setEditing(false); onRename?.(draft) }

  return (
    <div
      className={`tl-track-header${selected ? ' is-selected' : ''}`}
      style={{ height }}
      onClick={() => onSelect?.()}
      onDoubleClick={begin}
      onContextMenu={onContextMenu}
      title={`${display} — ${clipCount} clip${clipCount === 1 ? '' : 's'}. Double-click to rename.`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          onClick={(e) => e.stopPropagation()}
          placeholder={`Track ${index + 1}`}
          style={{ flex: 1, minWidth: 0, padding: '2px 4px', fontSize: 12 }}
        />
      ) : (
        <>
          <span className="tl-track-header__name">{display}</span>
          {clipCount > 0 && <span className="tl-track-header__count">{clipCount}</span>}
        </>
      )}
    </div>
  )
}
