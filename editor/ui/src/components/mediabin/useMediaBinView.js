import { useMemo } from 'react'
import { assetKind } from '../../media/kind.js'
import { baseName } from '../../media/asset.js'

/**
 * Filter and sort the media list for display.
 *
 * The bin used to render `project.media` in raw insertion order with no
 * search, filter or sort, so finding one asset among fifty meant scrolling.
 */
export default function useMediaBinView(media, view) {
  return useMemo(() => {
    const q = (view.query || '').trim().toLowerCase()
    const kinds = view.kinds || []

    let out = media.map((m) => ({ ...m, _kind: assetKind(m) }))

    if (q) out = out.filter((m) => (baseName(m.name) || m.name || m.id).toLowerCase().includes(q))
    if (kinds.length) out = out.filter((m) => kinds.includes(m._kind))

    const sorted = [...out]
    if (view.sort === 'name') {
      sorted.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    } else if (view.sort === 'type') {
      sorted.sort((a, b) => a._kind.localeCompare(b._kind) || (a.name || '').localeCompare(b.name || ''))
    } else {
      // Newest first. Assets imported before `added_at` existed fall back to
      // their position in the array, which is the same ordering.
      sorted.sort((a, b) => (b.added_at || 0) - (a.added_at || 0))
    }
    return sorted
  }, [media, view.query, view.sort, view.kinds])
}
