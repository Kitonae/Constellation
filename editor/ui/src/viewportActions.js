/**
 * Small registry so the single keyboard shortcut layer in App can invoke
 * viewport-local commands without Viewport2D installing its own window
 * listeners (frontend audit item 3).
 *
 * Viewport2D assigns handlers on mount and clears them on unmount.
 */
export const viewportActions = {
  /** @type {null | (() => void)} */
  frameAll: null,
}
