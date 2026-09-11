/**
 * Repointing an asset at a moved file, and finding it on disk.
 *
 * Relinking keeps the asset id, so every timeline instance follows at once.
 * Re-importing would create a second asset and leave the clips pointing at
 * the broken one.
 */

import { useEditorStore } from '../store.js'
import { openMediaFiles } from './fileDialogs.js'
import { toFileUri, fromFileUri } from '../media/uri.js'
import { invalidateFileExists } from './fileExists.js'
import { invalidateNaturalSize } from '../media/naturalSize.js'
import { getVideoMetadata } from './videoUtils.js'
import { assetKind } from '../media/kind.js'
import { RevealInExplorer } from '@bindings/app.js'
import { isWails } from '../wails/env.js'

/** Ask for a replacement file and point the asset at it. */
export async function relinkAsset(mediaId) {
  const st = useEditorStore.getState()
  const asset = (st.project?.media || []).find((m) => m.id === mediaId)
  if (!asset) return false

  const picked = await openMediaFiles()
  const first = Array.isArray(picked) ? picked[0] : null
  if (!first) return false

  const path = typeof first === 'string' ? first : (first.path || first.uri)
  if (!path) return false
  const uri = path.startsWith('file:') || path.startsWith('http') ? path : toFileUri(path)

  let duration_seconds
  if (assetKind(uri) === 'video') {
    try {
      const meta = await getVideoMetadata(uri)
      if (meta?.duration) duration_seconds = meta.duration
    } catch { /* keep the existing duration */ }
  }

  invalidateFileExists(asset.uri)
  invalidateNaturalSize(asset.uri)
  useEditorStore.getState().relinkMedia(mediaId, { uri, duration_seconds })
  useEditorStore.getState().setStatus(`Relinked "${asset.name}"`)
  return true
}

/** Show the asset's file in the OS file browser. */
export async function revealAsset(asset) {
  if (!isWails() || !asset?.uri) return
  try {
    await RevealInExplorer(fromFileUri(asset.uri))
  } catch (e) {
    useEditorStore.getState().addLog({ level: 'warn', message: `Could not reveal file: ${e}` })
  }
}
