import React, { useEffect, useRef, useState } from 'react'
import MediaThumb from '../MediaThumb.jsx'
import IconButton from '../IconButton.jsx'
import useFileExists from '../../hooks/useFileExists.js'
import useMediaNaturalSize from '../../hooks/useMediaNaturalSize.js'
import { KIND_ICON, isTimeBased, hasNaturalSize } from '../../media/kind.js'
import { formatDuration } from '../../utils/timeFormat.js'
import { setDragClipId, clearDragClipId } from '../../utils/dragPayload.js'

/** One asset in the media bin. */
export default function MediaRow({
  asset, kind, selected, linked, uses, renaming,
  onSelect, onInsert, onContextMenu, onRenameStart, onRenameEnd, onRelink,
}) {
  const exists = useFileExists(asset.uri)
  const missing = exists === false
  // Do not probe dimensions for a file that is not there.
  const natural = useMediaNaturalSize(missing ? null : asset.uri, kind)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)
  const editing = !!renaming

  // Renaming is driven from the bin (context menu, F2, double-click) so the
  // menu can start an edit on a row it does not own.
  useEffect(() => {
    if (!editing) return
    setDraft(asset.name || '')
    inputRef.current?.select()
  }, [editing, asset.name])

  const commitRename = () => onRenameEnd(draft)
  const cancelRename = () => onRenameEnd(null)

  const meta = []
  if (isTimeBased(kind) && asset.duration_seconds) meta.push(formatDuration(asset.duration_seconds))
  if (hasNaturalSize(kind) && natural) meta.push(`${natural.w}×${natural.h}`)
  if (uses > 0) meta.push(`×${uses}`)

  return (
    <div
      className={`media-row${selected ? ' is-selected' : ''}${linked ? ' is-linked' : ''}${missing ? ' is-missing' : ''}`}
      draggable={!editing}
      onClick={onSelect}
      onDoubleClick={onRenameStart}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'F2') { e.preventDefault(); onRenameStart() }
      }}
      onContextMenu={onContextMenu}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-constellation-clip-id', asset.id)
        e.dataTransfer.setData('text/plain', asset.id)
        e.dataTransfer.effectAllowed = 'copyMove'
        // dataTransfer is unreadable during dragover, so the drop targets
        // read the id from here to size their ghost.
        setDragClipId(asset.id)
      }}
      onDragEnd={clearDragClipId}
      title={asset.uri}
    >
      <MediaThumb uri={asset.uri} alt={asset.name || asset.id} size={44} kind={kind} missing={missing} />

      <div className="media-row__body">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') cancelRename()
            }}
            style={{ width: '100%', fontSize: 12, padding: '2px 4px' }}
          />
        ) : (
          <>
            <div className="media-row__name">
              <span className="ms" style={{ fontSize: 12, verticalAlign: '-2px', marginRight: 4, color: 'var(--text-muted)' }} aria-hidden="true">
                {KIND_ICON[kind]}
              </span>
              {asset.name || asset.id}
            </div>
            <div className="media-row__meta">
              {missing ? (
                <button
                  type="button"
                  className="media-row__missing btn btn--ghost"
                  style={{ padding: 0, fontSize: 11, gap: 4 }}
                  onClick={(e) => { e.stopPropagation(); onRelink() }}
                  title="File is missing — click to relink"
                >
                  <span className="ms" style={{ fontSize: 12 }} aria-hidden="true">link_off</span>
                  Missing — relink
                </button>
              ) : (
                meta.map((m, i) => <span key={i}>{m}</span>)
              )}
            </div>
          </>
        )}
      </div>

      <IconButton
        icon="add"
        label="Insert at playhead"
        size={26}
        onClick={(e) => { e.stopPropagation(); onInsert() }}
      />
    </div>
  )
}
