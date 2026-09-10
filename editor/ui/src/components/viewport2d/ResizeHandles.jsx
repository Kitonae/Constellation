import React from 'react'
import { HANDLES, cursorFor, handleOffset } from '../../utils/resizeRect.js'

/**
 * The eight grab squares around the selected clip.
 *
 * Clips only. A screen's `pixels` is an integer output resolution bound to a
 * physical or NDI output, so free-hand dragging one would silently produce
 * something like 1913x1077; screens are sized from the Inspector's preset
 * list instead.
 *
 * The squares are a constant size on screen because the stage is scrolled
 * rather than CSS-scaled, so they stay grabbable at any zoom.
 */
export default function ResizeHandles({ rect, onStart }) {
  if (!rect) return null
  return (
    <>
      {HANDLES.map((h) => {
        const { fx, fy } = handleOffset(h)
        return (
          <div
            key={h}
            className="v2d-handle"
            data-handle={h}
            style={{
              left: rect.left + rect.width * fx,
              top: rect.top + rect.height * fy,
              cursor: cursorFor(h),
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { }
              onStart(h, e)
            }}
          />
        )
      })}
    </>
  )
}
