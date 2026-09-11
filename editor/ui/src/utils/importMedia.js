/**
 * The single media-import path.
 *
 * App's drag-and-drop handler and the Media Bin's file/folder pickers used to
 * carry near-identical copies of this loop, with slightly different extension
 * regexes. Both now call in here.
 */

import { useEditorStore } from '../store.js'
import { getVideoMetadata } from './videoUtils.js'
import { toFileUri } from '../media/uri.js'
import { isImportableFile, isVideoName, isModelName } from '../media/asset.js'

const DEFAULT_CLIP_SECONDS = 10

function isAbsolutePath(p) {
  return !!p && (p.startsWith('/') || /^[a-zA-Z]:[\/]/.test(p))
}

/**
 * Import a batch of `{ file?, path? }` entries into the media bin.
 * Reports progress through the store and is cancellable from the overlay.
 *
 * Files that cannot be imported used to be skipped in silence — the
 * progress overlay counted them and nothing ever said which ones did not
 * arrive. They are now collected and reported.
 *
 * @param {{file?: File, path?: string}[]} entries
 * @returns {Promise<{added: string[], skipped: {name: string, reason: string}[]}>}
 */
export async function importEntries(entries) {
  const list = (entries || []).filter(Boolean)
  if (!list.length) return { added: [], skipped: [] }

  const st = useEditorStore.getState()
  const added = []
  const skipped = []
  st.startImport(list.length)
  try {
    let i = 0
    for (const { file, path } of list) {
      if (useEditorStore.getState().importProgress?.cancelled) break

      const name = String(path || file?.name || 'media').split(/[\/]/).pop()
      useEditorStore.getState().updateImportProgress(i, name)
      i++

      // Yield so the progress overlay can paint
      await new Promise((r) => setTimeout(r, 0))

      if (!isImportableFile(name)) { skipped.push({ name, reason: 'unsupported file type' }); continue }

      let uri = null
      if (isAbsolutePath(path)) {
        uri = toFileUri(path)
      } else if (file) {
        // Browser fallback: an object URL is a lightweight reference, not a copy
        uri = URL.createObjectURL(file)
      } else if (path) {
        uri = toFileUri(path)
      }
      if (!uri) { skipped.push({ name, reason: 'could not resolve a path' }); continue }

      let duration = isModelName(name) ? 0 : DEFAULT_CLIP_SECONDS
      if (isVideoName(name)) {
        try {
          const meta = await getVideoMetadata(file || uri)
          if (meta?.duration) duration = meta.duration
        } catch (e) {
          console.warn('Failed to get video metadata', e)
          useEditorStore.getState().addLog({ level: 'warn', message: `Could not read duration of ${name}; using ${DEFAULT_CLIP_SECONDS}s` })
        }
      }

      const id = `clip-${Math.random().toString(36).slice(2, 8)}`
      useEditorStore.getState().addMediaClip({ id, name, uri, duration_seconds: duration })
      added.push(id)
    }
  } catch (e) {
    console.error(e)
    useEditorStore.getState().addLog({ level: 'error', message: `Import failed: ${e}` })
  } finally {
    useEditorStore.getState().finishImport()
  }

  reportImport(added, skipped)
  return { added, skipped }
}

/** Tell the user what arrived and what did not. */
function reportImport(added, skipped) {
  const st = useEditorStore.getState()
  if (!added.length && !skipped.length) return
  if (skipped.length) {
    const names = skipped.slice(0, 3).map((s) => s.name).join(', ')
    const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : ''
    st.addLog({
      level: 'warn',
      message: `Imported ${added.length}, skipped ${skipped.length}: ${names}${more}`,
    })
  } else {
    st.setStatus(`Imported ${added.length} file${added.length === 1 ? '' : 's'}`)
  }
}

/** Import absolute OS paths (Wails native file drop, file pickers). */
export function importPaths(paths) {
  return importEntries((paths || []).map((path) => ({ path })))
}

/** Import browser File objects (HTML drop in a plain browser). */
export function importFiles(files) {
  return importEntries(Array.from(files || []).map((file) => ({ file, path: file.path })))
}
