import React, { useEffect, useState } from 'react'
import { Window, Events } from '@wailsio/runtime'
import { isWails } from '../wails/env.js'

/**
 * Minimise, maximise/restore and close for the frameless window.
 *
 * Only rendered inside the Wails webview: in a browser the tab already has
 * its own chrome and none of these calls would do anything.
 *
 * Close goes through `Window.Close()` rather than quitting directly, so it
 * takes the same path as the title bar's X used to: Go cancels the close and
 * emits `app:closeRequested`, and the editor asks about unsaved changes.
 */
export default function WindowControls() {
  const [maximised, setMaximised] = useState(false)
  const inWails = isWails()

  useEffect(() => {
    if (!inWails) return undefined
    let alive = true
    Window.IsMaximised().then((m) => { if (alive) setMaximised(!!m) }).catch(() => { })
    const offs = [
      Events.On('common:WindowMaximise', () => setMaximised(true)),
      Events.On('common:WindowUnMaximise', () => setMaximised(false)),
      Events.On('common:WindowRestore', () => setMaximised(false)),
    ]
    return () => { alive = false; offs.forEach((off) => { try { off() } catch { } }) }
  }, [inWails])

  if (!inWails) return null

  const call = (fn) => () => { try { fn().catch?.(() => { }) } catch { } }

  return (
    <div className="appbar__win" role="group" aria-label="Window">
      <button type="button" className="appbar__win-btn" aria-label="Minimise" title="Minimise"
        onClick={call(() => Window.Minimise())}>
        <span className="ms" aria-hidden="true">remove</span>
      </button>
      <button type="button" className="appbar__win-btn" aria-label={maximised ? 'Restore' : 'Maximise'} title={maximised ? 'Restore' : 'Maximise'}
        onClick={call(() => Window.ToggleMaximise())}>
        <span className="ms" aria-hidden="true">{maximised ? 'filter_none' : 'crop_square'}</span>
      </button>
      <button type="button" className="appbar__win-btn appbar__win-btn--close" aria-label="Close" title="Close"
        onClick={call(() => Window.Close())}>
        <span className="ms" aria-hidden="true">close</span>
      </button>
    </div>
  )
}

/**
 * Double-clicking the title bar toggles maximise on Windows. The Wails
 * runtime only does this itself on macOS, so the app bar wires it up here,
 * and only for the parts of the bar that are actually drag region: a
 * double-click on a menu title or a mode button must stay a double-click.
 */
export function toggleMaximiseFromDragRegion(e) {
  if (!isWails()) return
  if (e.button !== 0) return
  let draggable = false
  try { draggable = getComputedStyle(e.target).getPropertyValue('--wails-draggable').trim() === 'drag' } catch { }
  if (!draggable) return
  try { Window.ToggleMaximise().catch?.(() => { }) } catch { }
}
