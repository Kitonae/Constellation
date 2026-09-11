import React from 'react'
import IconButton from '../IconButton.jsx'
import { ratioForZoom } from './constants.js'

/**
 * The stage's floating toolbar.
 *
 * Note the labels are suffixed with "(Stage)": the timeline has its own
 * Zoom In / Zoom Out buttons, and two controls with the same accessible name
 * would be ambiguous to both screen readers and tests.
 */
export default function ViewportToolbar({
  tool, setTool, zoom, onZoomIn, onZoomOut, onZoom100, onFrameAll, onFrameSelected, hasSelection,
}) {
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8, zIndex: 'var(--z-hud)' }}>
      <div style={{ display: 'flex', gap: 2 }}>
        <IconButton icon="arrow_selector_tool" label="Select tool" size={28} active={tool === 'select'} onClick={() => setTool('select')} />
        <IconButton icon="pan_tool" label="Pan tool" size={28} active={tool === 'hand'} onClick={() => setTool('hand')} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <IconButton icon="zoom_out" label="Zoom Out (Stage)" size={28} onClick={onZoomOut} />
        <IconButton icon="zoom_in" label="Zoom In (Stage)" size={28} onClick={onZoomIn} />
        {/* A real percentage: media pixels per screen pixel. */}
        <button
          type="button"
          className="btn"
          title="Zoom to 100%"
          onClick={onZoom100}
          style={{ minWidth: 54, padding: '5px 6px', fontSize: 11, fontFamily: 'var(--font-mono)' }}
        >
          {Math.round(ratioForZoom(zoom) * 100)}%
        </button>
      </div>

      <div style={{ display: 'flex', gap: 2 }}>
        <IconButton icon="fit_screen" label="Frame All (F)" size={28} onClick={onFrameAll} />
        <IconButton icon="center_focus_strong" label="Frame Selected (Shift+F)" size={28} disabled={!hasSelection} onClick={onFrameSelected} />
      </div>
    </div>
  )
}
