import React from 'react'
import { useEditorStore } from '../../store.js'
import Category from './Category.jsx'
import PropertyRow, { InfoRow, TextInput } from './PropertyRow.jsx'
import useMediaNaturalSize from '../../hooks/useMediaNaturalSize.js'
import useFileExists from '../../hooks/useFileExists.js'
import { assetKind, KIND_LABEL, isTimeBased } from '../../media/kind.js'
import { fromFileUri } from '../../media/uri.js'
import { formatDuration } from '../../utils/timeFormat.js'
import { clipInstancesOf } from '../../selectors.js'
import { relinkAsset, revealAsset } from '../../utils/relinkMedia.js'
import { isWails } from '../../wails/env.js'

/** Properties of an asset selected in the Media Bin. */
export default function MediaAssetSection({ asset }) {
  const project = useEditorStore((s) => s.project)
  const renameMedia = useEditorStore((s) => s.renameMedia)
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips)
  const kind = assetKind(asset.uri || asset.name || '')
  const natural = useMediaNaturalSize(asset.uri, kind)
  const exists = useFileExists(asset.uri)
  const uses = clipInstancesOf(project, asset.id)
  const canReveal = isWails()

  return (
    <Category title="Media">
      <PropertyRow label="Name">
        <TextInput value={asset.name || ''} placeholder={asset.id} onCommit={(v) => renameMedia(asset.id, v)} />
      </PropertyRow>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <InfoRow label="Type" value={KIND_LABEL[kind]} />
        {natural && <InfoRow label="Size" value={`${natural.w} × ${natural.h} px`} />}
        {isTimeBased(kind) && <InfoRow label="Duration" value={formatDuration(asset.duration_seconds)} />}
        <InfoRow label="Used by" value={`${uses.length} timeline clip${uses.length === 1 ? '' : 's'}`} />
        <InfoRow label="Path" value={asset.uri ? fromFileUri(asset.uri) : '—'} title={asset.uri} />
      </div>

      {exists === false && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--error)' }}>
          <span className="ms" aria-hidden="true">link_off</span>
          File is missing
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" style={{ fontSize: 11 }} onClick={() => relinkAsset(asset.id)}>
          Relink…
        </button>
        {canReveal && (
          <button type="button" className="btn" style={{ fontSize: 11 }} onClick={() => revealAsset(asset)}>
            Reveal in Explorer
          </button>
        )}
        {uses.length > 0 && (
          <button type="button" className="btn btn--ghost" style={{ fontSize: 11 }}
            onClick={() => setSelectedClips(uses.map((m) => m.id))}>
            Select {uses.length} clip{uses.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </Category>
  )
}
