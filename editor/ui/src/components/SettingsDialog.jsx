import React from 'react'
import Modal from './Modal.jsx'
import { useEditorStore } from '../store.js'
import { SETTINGS_SCHEMA } from '../settings.js'

/**
 * Editor preferences.
 *
 * Rendered from SETTINGS_SCHEMA rather than from hand-written markup, so a
 * new setting appears here as soon as it is declared — there is no second
 * list to keep in step.
 *
 * Changes apply immediately and persist; there is no OK/Cancel because every
 * setting here is a view preference you can see the effect of behind the
 * dialog and flip straight back.
 */
export default function SettingsDialog() {
  const open = useEditorStore((s) => s.settingsOpen)
  const toggleSettings = useEditorStore((s) => s.toggleSettings)
  const settings = useEditorStore((s) => s.settings)
  const setSetting = useEditorStore((s) => s.setSetting)

  if (!open) return null

  return (
    <Modal open={open} title="Settings" onClose={toggleSettings} width={420}>
      <div className="settings">
        {Object.entries(SETTINGS_SCHEMA).map(([key, spec]) => (
          <div className="settings__row" key={key}>
            <div className="settings__label">
              <span className="settings__name">{spec.label}</span>
              {spec.description && <span className="settings__hint">{spec.description}</span>}
            </div>
            <div className="settings__control" role="group" aria-label={spec.label}>
              {spec.options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={'settings__choice' + (settings[key] === opt.value ? ' is-active' : '')}
                  aria-pressed={settings[key] === opt.value}
                  onClick={() => setSetting(key, opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
