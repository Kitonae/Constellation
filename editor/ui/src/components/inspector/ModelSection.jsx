import React from 'react'
import { useEditorStore } from '../../store.js'
import Category from './Category.jsx'
import PropertyRow, { InfoRow, TextInput } from './PropertyRow.jsx'
import { fromFileUri } from '../../media/uri.js'

/** Properties of a 3D model node in the scene. */
export default function ModelSection({ node }) {
  const renameNode = useEditorStore((s) => s.renameNode)
  const uri = node.kind?.uri
  return (
    <Category title="Model">
      <PropertyRow label="Name">
        <TextInput value={node.name || ''} placeholder={node.id} onCommit={(v) => renameNode(node.id, v)} />
      </PropertyRow>
      <InfoRow label="File" value={uri ? fromFileUri(uri) : '—'} title={uri} />
    </Category>
  )
}
