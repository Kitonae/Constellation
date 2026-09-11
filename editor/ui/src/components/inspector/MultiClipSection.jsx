import React, { useMemo, useState } from 'react'
import { useEditorStore } from '../../store.js'
import Category from './Category.jsx'
import PropertyRow from './PropertyRow.jsx'
import NumberInput from './NumberInput.jsx'
import { FIELD } from './constants.js'
import { findTimelineItem, assetOf } from '../../selectors.js'

/**
 * Batch editing for a multi-clip selection.
 *
 * A marquee over five clips used to show the Inspector for whichever one
 * happened to be first, with no indication the other four were selected.
 * Fields that differ across the selection render as an em dash and only
 * write when you actually type a value.
 */
export default function MultiClipSection({ ids }) {
  const project = useEditorStore((s) => s.project)
  const updateClipsTransform = useEditorStore((s) => s.updateClipsTransform)
  const [nudge, setNudge] = useState({ dx: 0, dy: 0 })

  const items = useMemo(
    () => ids.map((id) => findTimelineItem(project, id)?.tm).filter(Boolean),
    [project, ids],
  )

  /** One value if every clip agrees, otherwise null for "mixed". */
  const common = (read) => {
    if (!items.length) return null
    const first = read(items[0])
    return items.every((m) => read(m) === first) ? first : null
  }

  const opacity = common((m) => m.opacity ?? 1)
  const fadeIn = common((m) => m.fade_in ?? 0)
  const fadeOut = common((m) => m.fade_out ?? 0)

  const apply = (patch, label) => updateClipsTransform(ids, patch, label)

  return (
    <>
      <Category title={`${ids.length} Clips Selected`}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 120, overflow: 'auto' }}>
          {items.map((m) => (
            <div key={m.id} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {m.label || assetOf(project, m)?.name || m.clip_id}
            </div>
          ))}
        </div>
      </Category>

      <Category title="Transform">
        {/* Relative, not absolute: the clips are at different places and
            setting them all to one position would stack them. */}
        <PropertyRow label="Nudge Position" hint="Offsets every selected clip by this much">
          <NumberInput prefix="ΔX" {...FIELD.clipPosition} value={nudge.dx}
            onChange={(v) => { setNudge({ dx: 0, dy: 0 }); apply({ positionDelta: { dx: v, dy: 0 } }, `Move ${ids.length} Clips`) }} />
          <NumberInput prefix="ΔY" {...FIELD.clipPosition} value={nudge.dy}
            onChange={(v) => { setNudge({ dx: 0, dy: 0 }); apply({ positionDelta: { dx: 0, dy: v } }, `Move ${ids.length} Clips`) }} />
        </PropertyRow>
      </Category>

      <Category title="Timing">
        <PropertyRow label="Fade In / Out">
          <NumberInput prefix="In" {...FIELD.clipFade} value={fadeIn ?? 0} mixed={fadeIn === null}
            onChange={(v) => apply({ fade_in: v }, `Change Fade on ${ids.length} Clips`)} />
          <NumberInput prefix="Out" {...FIELD.clipFade} value={fadeOut ?? 0} mixed={fadeOut === null}
            onChange={(v) => apply({ fade_out: v }, `Change Fade on ${ids.length} Clips`)} />
        </PropertyRow>
      </Category>

      <Category title="Appearance">
        <PropertyRow label="Opacity">
          <NumberInput {...FIELD.opacity} value={opacity ?? 1} mixed={opacity === null}
            onChange={(v) => apply({ opacity: v }, `Change Opacity on ${ids.length} Clips`)} />
        </PropertyRow>
      </Category>
    </>
  )
}
