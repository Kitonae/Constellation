import React from 'react'

/** Width of a trim grab zone, and the narrowest clip that still shows them. */
export const HANDLE_W = 7

/**
 * One clip bar on the timeline.
 *
 * Extracted from the Timeline's render loop so the trim handles have
 * somewhere to live. The handles stop propagation and capture the pointer
 * themselves, so grabbing an edge trims rather than starting a move.
 */
export default React.memo(function TimelineClip({
  id,
  label,
  left,
  width,
  top = 0,
  height,
  isSelected,
  isOverlapping,
  isDragging,
  fadeInWidth,
  fadeOutWidth,
  title,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
  onTrimStart,
}) {
  const showHandles = width > HANDLE_W * 3

  return (
    <div
      data-clip={id}
      className={`tl-clip${isSelected ? ' is-selected' : ''}${isOverlapping ? ' is-overlapping' : ''}`}
      style={{
        left,
        top,
        width,
        height,
        zIndex: isDragging ? 100 : 1,
        transition: isDragging ? 'none' : 'top 0.15s ease',
      }}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
    >
      {fadeInWidth > 0 && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: fadeInWidth,
          background: 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.1), rgba(255,255,255,0.1) 5px, transparent 5px, transparent 10px)',
          pointerEvents: 'none', zIndex: 2,
        }} />
      )}
      {fadeOutWidth > 0 && (
        <div style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: fadeOutWidth,
          background: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.1), rgba(255,255,255,0.1) 5px, transparent 5px, transparent 10px)',
          pointerEvents: 'none', zIndex: 2,
        }} />
      )}

      <span className="tl-clip__label">{label}</span>

      {isOverlapping && (
        <div style={{
          position: 'absolute', right: 4, top: 0, bottom: 0, display: 'flex',
          alignItems: 'center', color: 'var(--error)', fontWeight: 'bold', pointerEvents: 'none', zIndex: 3,
        }}>!</div>
      )}

      {showHandles && (
        <>
          <div
            className="tl-clip-handle"
            data-trim="start"
            style={{ left: 0 }}
            title="Trim start"
            onPointerDown={(e) => { e.stopPropagation(); onTrimStart?.(id, 'start', e) }}
          />
          <div
            className="tl-clip-handle"
            data-trim="end"
            style={{ right: 0 }}
            title="Trim end"
            onPointerDown={(e) => { e.stopPropagation(); onTrimStart?.(id, 'end', e) }}
          />
        </>
      )}
    </div>
  )
})
