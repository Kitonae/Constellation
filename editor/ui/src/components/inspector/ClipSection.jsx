import React, { useState } from 'react'
import { useEditorStore } from '../../store.js'
import Category from './Category.jsx'
import PropertyRow, { InfoRow, TextInput } from './PropertyRow.jsx'
import NumberInput from './NumberInput.jsx'
import { FIELD, EFFECT_RANGES } from './constants.js'
import useMediaNaturalSize from '../../hooks/useMediaNaturalSize.js'
import { assetKind, KIND_LABEL, isTimeBased } from '../../media/kind.js'
import { fromFileUri } from '../../media/uri.js'
import { clipStart, clipDuration } from '../../utils/clipTime.js'
import { formatDuration } from '../../utils/timeFormat.js'

/** Properties of a single selected timeline clip. */
export default function ClipSection({ tm, asset }) {
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)
  const renameTimelineClip = useEditorStore((s) => s.renameTimelineClip)
  const setSelectedMedia = useEditorStore((s) => s.setSelectedMedia)
  const [keepAR, setKeepAR] = useState(true)

  const kind = assetKind(asset?.uri || asset?.name || '')
  // Probing now understands video, so Size no longer reads 0 for one.
  const natural = useMediaNaturalSize(asset?.uri, kind)

  // A stored scale of 0 means "use the natural size", so the Size fields and
  // the aspect lock must resolve through it before doing any maths.
  const effectiveW = tm.scale?.x > 0 ? tm.scale.x : (natural?.w ?? 0)
  const effectiveH = tm.scale?.y > 0 ? tm.scale.y : (natural?.h ?? 0)

  const setSize = (w, h) => updateClipTransform({ timelineId: tm.id, scale: { x: w, y: h }, label: 'Resize Clip' })

  return (
    <>
      <Category title="Clip">
        <PropertyRow label="Name">
          <TextInput
            value={tm.label || ''}
            placeholder={asset?.name || tm.clip_id}
            onCommit={(v) => renameTimelineClip(tm.id, v)}
          />
        </PropertyRow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <InfoRow label="Source" value={asset?.name || tm.clip_id} />
          <InfoRow label="Type" value={KIND_LABEL[kind]} />
          {natural && <InfoRow label="Natural" value={`${natural.w} × ${natural.h} px`} />}
          {isTimeBased(kind) && asset?.duration_seconds != null && (
            <InfoRow label="Media" value={formatDuration(asset.duration_seconds)} />
          )}
          <InfoRow label="Path" value={asset?.uri ? fromFileUri(asset.uri) : '—'} title={asset?.uri} />
        </div>
        {asset && (
          <button type="button" className="btn btn--ghost" style={{ alignSelf: 'flex-start', fontSize: 11 }}
            onClick={() => setSelectedMedia(asset.id)}>
            Show in Media Bin
          </button>
        )}
      </Category>

      <Category title="Transform">
        <PropertyRow label="Position">
          <NumberInput prefix="X" {...FIELD.clipPosition} value={tm.position?.x ?? 0} scrubLabel="Move Clip"
            onChange={(v) => updateClipTransform({ timelineId: tm.id, position: { x: Math.round(v) }, label: 'Move Clip' })} />
          <NumberInput prefix="Y" {...FIELD.clipPosition} value={tm.position?.y ?? 0} scrubLabel="Move Clip"
            onChange={(v) => updateClipTransform({ timelineId: tm.id, position: { y: Math.round(v) }, label: 'Move Clip' })} />
        </PropertyRow>

        <PropertyRow label="Size">
          <NumberInput prefix="W" {...FIELD.clipSize} value={effectiveW} scrubLabel="Resize Clip"
            onChange={(v) => {
              const w = Math.max(1, Math.round(v))
              const ratio = effectiveW > 0 ? effectiveH / effectiveW : 1
              setSize(w, keepAR ? Math.max(1, Math.round(w * ratio)) : effectiveH)
            }} />
          <NumberInput prefix="H" {...FIELD.clipSize} value={effectiveH} scrubLabel="Resize Clip"
            onChange={(v) => {
              const h = Math.max(1, Math.round(v))
              const ratio = effectiveH > 0 ? effectiveW / effectiveH : 1
              setSize(keepAR ? Math.max(1, Math.round(h * ratio)) : effectiveW, h)
            }} />
        </PropertyRow>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={`btn${keepAR ? ' btn--primary' : ''}`}
            style={{ flex: 1, fontSize: 11 }}
            aria-pressed={keepAR}
            onClick={() => setKeepAR(!keepAR)}
          >
            {keepAR ? 'Aspect: Locked' : 'Aspect: Free'}
          </button>
          <button
            type="button"
            className="btn"
            style={{ fontSize: 11 }}
            disabled={!natural}
            title={natural ? 'Reset to the media’s own dimensions' : 'Natural size unknown for this media'}
            onClick={() => natural && setSize(natural.w, natural.h)}
          >
            Reset Size
          </button>
        </div>
      </Category>

      <Category title="Timing">
        <PropertyRow label="Start / Duration">
          <NumberInput prefix="S" {...FIELD.clipStart} value={clipStart(tm)} scrubLabel="Move Clip on Timeline"
            onChange={(v) => useEditorStore.getState().updateClipStart({ timelineId: tm.id, startAt: v })} />
          <NumberInput prefix="D" {...FIELD.clipDuration} value={clipDuration(tm)} scrubLabel="Resize Clip Duration"
            onChange={(v) => useEditorStore.getState().updateClipDuration({ timelineId: tm.id, duration: v })} />
        </PropertyRow>
        <PropertyRow label="Fade In / Out">
          <NumberInput prefix="In" {...FIELD.clipFade} max={clipDuration(tm)} value={tm.fade_in ?? 0} scrubLabel="Change Fade"
            onChange={(v) => updateClipTransform({ timelineId: tm.id, fade_in: v })} />
          <NumberInput prefix="Out" {...FIELD.clipFade} max={clipDuration(tm)} value={tm.fade_out ?? 0} scrubLabel="Change Fade"
            onChange={(v) => updateClipTransform({ timelineId: tm.id, fade_out: v })} />
        </PropertyRow>
      </Category>

      <Category title="Appearance">
        <PropertyRow label="Opacity">
          <NumberInput {...FIELD.opacity} value={tm.opacity ?? 1} scrubLabel="Change Opacity"
            onChange={(v) => updateClipTransform({ timelineId: tm.id, opacity: v })} />
        </PropertyRow>
      </Category>

      <Category title="Effects" defaultOpen={false}>
        <div style={{ display: 'grid', gap: 10 }}>
          {Object.entries(EFFECT_RANGES).map(([effect, cfg]) => (
            <EffectControl key={effect} effect={effect} cfg={cfg} media={tm} />
          ))}
        </div>
      </Category>
    </>
  )
}

const EFFECT_LABEL = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturate: 'Saturation',
  grayscale: 'Grayscale',
  sepia: 'Sepia',
  'hue-rotate': 'Hue Rotate',
  invert: 'Invert',
  blur: 'Blur',
}

function EffectControl({ effect, cfg, media }) {
  const updateClipEffect = useEditorStore((s) => s.updateClipEffect)
  const data = media.effects?.[effect] || {}
  const enabled = data.enabled ?? false
  const value = data.value ?? cfg.defaultValue

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1, minWidth: 0 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            const on = e.target.checked
            const patch = { enabled: on }
            if (on && cfg.toggleOnly) patch.value = 1
            updateClipEffect({ timelineId: media.id, effect, ...patch })
          }}
        />
        <span style={{ opacity: enabled ? 1 : 0.7 }}>{EFFECT_LABEL[effect] || effect}</span>
      </label>
      {!cfg.toggleOnly && (
        <div style={{ width: 84, opacity: enabled ? 1 : 0.5 }}>
          <NumberInput
            step={cfg.step}
            min={cfg.min}
            max={cfg.max}
            unit={cfg.unit}
            value={value}
            disabled={!enabled}
            scrubLabel={`Change ${effect}`}
            onChange={(v) => updateClipEffect({ timelineId: media.id, effect, value: v })}
          />
        </div>
      )}
    </div>
  )
}
