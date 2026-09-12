import React, { useCallback, useMemo, useState } from 'react'
import { useEditorStore } from '../store.js'
import { openMediaFiles, openMediaFolder } from '../utils/fileDialogs.js'
import { importEntries, importFiles } from '../utils/importMedia.js'
import { relinkAsset, revealAsset } from '../utils/relinkMedia.js'
import { clipInstancesOf, findTimelineItem } from '../selectors.js'
import usePersistentState from '../hooks/usePersistentState.js'
import ContextMenu from './ContextMenu.jsx'
import MediaBinToolbar from './mediabin/MediaBinToolbar.jsx'
import MediaRow from './mediabin/MediaRow.jsx'
import useMediaBinView from './mediabin/useMediaBinView.js'
import { isWails } from '../wails/env.js'
import { baseName } from '../media/asset.js'

const DEFAULT_VIEW = { query: '', sort: 'added', kinds: [] }

/**
 * The media library.
 *
 * Gained selection, search, sorting, kind filters, rename, relink and a real
 * missing-file indicator. Previously it was an unordered list with no way to
 * find anything and no way to tell a moved file from a thumbnail failure.
 */
export default React.memo(function MediaBin() {
  const media = useEditorStore((s) => s.project?.media)
  const project = useEditorStore((s) => s.project)
  const selectedMediaId = useEditorStore((s) => s.selectedMediaId)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const setSelectedMedia = useEditorStore((s) => s.setSelectedMedia)
  const setSelectedClips = useEditorStore((s) => s.setSelectedClips)

  const [view, setView] = usePersistentState('mediabin.view', DEFAULT_VIEW)
  const [menu, setMenu] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  // The row that is currently being renamed inline. Set by the context menu
  // and by F2; the row clears it when the edit ends.
  const [renamingId, setRenamingId] = useState(null)

  const list = useMediaBinView(media || [], view)

  // Which assets the current clip selection points at, so the bin can show
  // where a selected clip came from.
  const linkedAssetIds = useMemo(() => {
    const out = new Set()
    for (const id of selectedClipIds || []) {
      const found = findTimelineItem(project, id)
      if (found?.tm?.clip_id) out.add(found.tm.clip_id)
    }
    return out
  }, [project, selectedClipIds])

  const useCounts = useMemo(() => {
    const counts = new Map()
    for (const t of project?.timeline?.tracks || []) {
      const items = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
      for (const m of items) {
        if (m?.clip_id) counts.set(m.clip_id, (counts.get(m.clip_id) || 0) + 1)
      }
    }
    return counts
  }, [project])

  const onImportFiles = useCallback(async () => { await importEntries(await openMediaFiles()) }, [])
  const onImportFolder = useCallback(async () => { await importEntries(await openMediaFolder()) }, [])

  const insertAsset = useCallback((asset) => {
    const st = useEditorStore.getState()
    const id = st.addClipToTimeline({ clipId: asset.id, startAt: st.time })
    if (id) st.setSelectedClips([id])
  }, [])

  const removeAsset = useCallback(async (asset) => {
    const st = useEditorStore.getState()
    const uses = clipInstancesOf(st.project, asset.id).length
    const ok = await st.askConfirm({
      title: 'Remove Media',
      message: uses
        ? `Remove "${baseName(asset.name)}"?\n${uses} timeline clip${uses === 1 ? '' : 's'} using it will also be removed.`
        : `Remove "${baseName(asset.name)}" from the media bin?`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    useEditorStore.getState().removeMediaClip(asset.id)
  }, [])

  const menuItems = useCallback((asset) => {
    const st = useEditorStore.getState()
    const canReveal = isWails()
    if (!asset) {
      return [
        { label: 'Add Files…', icon: 'upload_file', onClick: onImportFiles },
        { label: 'Add Folder…', icon: 'folder_open', onClick: onImportFolder },
      ]
    }
    const uses = clipInstancesOf(st.project, asset.id).length
    return [
      { label: 'Insert at Playhead', icon: 'add', onClick: () => insertAsset(asset) },
      ...(uses ? [{ label: `Select ${uses} Clip${uses === 1 ? '' : 's'}`, icon: 'select_all', onClick: () => setSelectedClips(clipInstancesOf(st.project, asset.id).map((m) => m.id)) }] : []),
      { separator: true },
      { label: 'Rename', icon: 'edit', onClick: () => setRenamingId(asset.id) },
      { label: 'Relink…', icon: 'link', onClick: () => relinkAsset(asset.id) },
      ...(canReveal ? [{ label: 'Reveal in Explorer', icon: 'folder_open', onClick: () => revealAsset(asset) }] : []),
      { label: 'Duplicate', icon: 'content_copy', onClick: () => st.duplicateMedia(asset.id) },
      ...(asset._kind === 'model' ? [{ label: 'Add as Stage Geometry', icon: 'view_in_ar', onClick: () => st.addModelNode({ name: asset.name, uri: asset.uri, format: asset.format }) }] : []),
      { separator: true },
      { label: 'Add Files…', icon: 'upload_file', onClick: onImportFiles },
      { label: 'Add Folder…', icon: 'folder_open', onClick: onImportFolder },
      { separator: true },
      { label: 'Remove', icon: 'delete', danger: true, onClick: () => removeAsset(asset) },
    ]
  }, [onImportFiles, onImportFolder, insertAsset, removeAsset, setSelectedClips])

  const total = media?.length || 0

  // The bin is mostly a staging area, so what matters first is which sources
  // the show actually uses. Split on the use count the rows already carry
  // rather than introducing any new state.
  const groups = useMemo(() => {
    const onTimeline = list.filter((m) => (useCounts.get(m.id) || 0) > 0)
    const unused = list.filter((m) => !(useCounts.get(m.id) || 0))
    return [
      { id: 'on-timeline', label: 'On timeline', items: onTimeline },
      { id: 'unused', label: 'Unused', items: unused },
    ]
  }, [list, useCounts])

  return (
    <div
      className={`media-bin${dragOver ? ' is-drop-target' : ''}`}
      onContextMenu={(e) => {
        if (e.target.closest('.media-row')) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, asset: null })
      }}
      // Plain-browser development only: under Wails the native drop handler
      // in App does the import, and this just draws the highlight.
      onDragEnter={(e) => { if (e.dataTransfer?.types?.includes('Files')) setDragOver(true) }}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }}
      onDrop={(e) => {
        setDragOver(false)
        if (isWails()) return // native path handles it
        if (!e.dataTransfer?.files?.length) return
        e.preventDefault()
        e.stopPropagation()
        importFiles(e.dataTransfer.files)
      }}
    >
      <MediaBinToolbar
        view={view}
        setView={setView}
        count={list.length}
        total={total}
        onAddNew={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4, asset: null })
        }}
      />

      <div className="media-bin__list">
        {!total && <div style={{ opacity: 0.6, fontSize: 12, padding: 4 }}>No media yet. Drop files here or use Add New.</div>}
        {!!total && !list.length && <div style={{ opacity: 0.6, fontSize: 12, padding: 4 }}>No media matches this filter.</div>}
        {groups.map((g) => (
          <React.Fragment key={g.id}>
            {g.items.length > 0 && (
              <div className="media-bin__group">
                <span className="media-bin__group-label">{g.label}</span>
                <span className="media-bin__group-rule" />
                <span className="media-bin__group-count">{g.items.length}</span>
              </div>
            )}
            {g.items.map((m) => (
            <MediaRow
              key={m.id}
              asset={m}
              kind={m._kind}
              selected={selectedMediaId === m.id}
              linked={linkedAssetIds.has(m.id)}
              uses={useCounts.get(m.id) || 0}
              renaming={renamingId === m.id}
              onSelect={() => setSelectedMedia(m.id)}
              onInsert={() => insertAsset(m)}
              onRenameStart={() => setRenamingId(m.id)}
              onRenameEnd={(name) => {
                setRenamingId(null)
                if (name != null) useEditorStore.getState().renameMedia(m.id, name)
              }}
              onRelink={() => relinkAsset(m.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setSelectedMedia(m.id)
                setMenu({ x: e.clientX, y: e.clientY, asset: m })
              }}
            />
            ))}
          </React.Fragment>
        ))}
      </div>

      <ContextMenu
        open={!!menu}
        x={menu?.x || 0}
        y={menu?.y || 0}
        items={menu ? menuItems(menu.asset) : []}
        onClose={() => setMenu(null)}
      />
    </div>
  )
})
