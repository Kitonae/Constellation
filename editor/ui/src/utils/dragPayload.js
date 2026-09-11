/**
 * The clip id behind an in-flight HTML drag.
 *
 * `dataTransfer.getData()` returns an empty string during `dragover` in
 * Chromium (only `drop` may read it), so the timeline could not know which
 * asset was being dragged and therefore could not draw a ghost of the right
 * duration. The drag source parks the id here as well.
 */

let current = null

export function setDragClipId(id) { current = id || null }
export function getDragClipId() { return current }
export function clearDragClipId() { current = null }
