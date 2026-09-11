import React from 'react'

/**
 * The app's only icon button.
 *
 * Uses the bundled Material Symbols font (class `ms`) rather than the unicode
 * glyphs the toolbars used to mix in, and defined at module scope so React
 * does not remount every button on each parent render.
 *
 * `onMouseDown` deliberately prevents default: a transport button that keeps
 * focus would also receive the Space key and toggle playback twice.
 */
const IconButton = React.forwardRef(function IconButton(
  { icon, label, onClick, active = false, disabled = false, size = 24, className = '', style, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
      className={`btn btn--icon${active ? ' is-active' : ''}${className ? ' ' + className : ''}`}
      style={{ '--size': `${size}px`, ...style }}
      {...rest}
    >
      <span className="ms" aria-hidden="true">{icon}</span>
    </button>
  )
})

export default IconButton
