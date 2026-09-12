/**
 * Derived reads over the store.
 *
 * Pure functions of state, so they work both inside `set()` callbacks and as
 * zustand selectors. Anything a component would otherwise re-derive with a
 * nested loop belongs here.
 */

import { trackMedia, clipStart, clipDuration } from './utils/clipTime.js'

/** Depth-first node lookup. */
export function findNode(roots, id) {
  if (!id) return null
  const stack = [...(roots || [])]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.id === id) return n
    if (n.children?.length) stack.push(...n.children)
  }
  return null
}

/** The scene node behind `selectedId`. */
export function selectedNode(s) {
  return findNode(s?.scene?.roots, s?.selectedId)
}

/** A timeline item plus which track it sits on. */
export function findTimelineItem(project, timelineId) {
  if (!timelineId) return null
  const tracks = project?.timeline?.tracks || []
  for (let i = 0; i < tracks.length; i++) {
    for (const m of trackMedia(tracks[i])) {
      if (m?.id === timelineId) return { tm: m, trackIndex: i }
    }
  }
  return null
}

/** The media asset a timeline item points at. */
export function assetOf(project, tm) {
  if (!tm?.clip_id) return null
  return (project?.media || []).find((m) => m.id === tm.clip_id) || null
}

/** Media asset by id. */
export function findAsset(project, mediaId) {
  if (!mediaId) return null
  return (project?.media || []).find((m) => m.id === mediaId) || null
}

/** Every timeline item that references a media asset. */
export function clipInstancesOf(project, mediaId) {
  if (!mediaId) return []
  const out = []
  for (const t of project?.timeline?.tracks || []) {
    for (const m of trackMedia(t)) {
      if (m?.clip_id === mediaId) out.push(m)
    }
  }
  return out
}

/** Every timeline item id in the project. */
export function allClipIds(project) {
  const out = []
  for (const t of project?.timeline?.tracks || []) {
    for (const m of trackMedia(t)) if (m?.id) out.push(m.id)
  }
  return out
}

/** Bounds of a timeline item, for framing and snapping. */
export function clipBounds(tm) {
  return { start: clipStart(tm), end: clipStart(tm) + clipDuration(tm) }
}

/**
 * What is selected, in one object.
 *
 * Node, clip and media selections are mutually exclusive (the store's setters
 * enforce it), so this collapses to a single kind. The status bar, the
 * Inspector's section dispatch and the Delete shortcut all read this instead
 * of re-checking three fields in three different orders.
 *
 * The result is memoized on the state slices it reads. As a zustand selector
 * it is called on every store write - including the clock's 10Hz time mirror
 * - and a fresh object each time would re-render every subscriber at that
 * rate.
 *
 * @returns {{kind:'none'|'node'|'clips'|'media', ids:string[], count:number, label:string}}
 */
let _summaryCache = { deps: null, value: { kind: 'none', ids: [], count: 0, label: 'No selection' } }

export function selectSelectionSummary(s) {
  const deps = [s?.selectedId, s?.selectedClipId, s?.selectedClipIds, s?.selectedMediaId, s?.project, s?.scene]
  const prev = _summaryCache.deps
  if (prev && prev.every((d, i) => d === deps[i])) return _summaryCache.value

  const value = computeSelectionSummary(s)
  _summaryCache = { deps, value }
  return value
}

function computeSelectionSummary(s) {
  const node = selectedNode(s)
  if (node) {
    return { kind: 'node', ids: [node.id], count: 1, label: node.name || node.id }
  }
  const clipIds = s?.selectedClipIds?.length
    ? s.selectedClipIds
    : (s?.selectedClipId ? [s.selectedClipId] : [])
  if (clipIds.length) {
    if (clipIds.length > 1) {
      return { kind: 'clips', ids: clipIds, count: clipIds.length, label: `${clipIds.length} clips selected` }
    }
    const found = findTimelineItem(s?.project, clipIds[0])
    const asset = found ? assetOf(s?.project, found.tm) : null
    const name = found?.tm?.label || asset?.name || clipIds[0]
    return { kind: 'clips', ids: clipIds, count: 1, label: name }
  }
  if (s?.selectedMediaId) {
    const asset = findAsset(s.project, s.selectedMediaId)
    return { kind: 'media', ids: [s.selectedMediaId], count: 1, label: asset?.name || s.selectedMediaId }
  }
  return { kind: 'none', ids: [], count: 0, label: 'No selection' }
}

/**
 * Has the document changed since it was last saved or opened?
 *
 * The shell compares the document's content against what it last wrote to
 * disk, so its answer is the one that matches the file. It also survives the
 * cases a local flag could not: undoing back to the saved state reads clean
 * again, and a Save As to a new file clears the dot.
 *
 * Without a shell — plain-browser development and the UI tests — this falls
 * back to comparing references against the snapshot taken at the last clean
 * point. A flag would go stale there, because undo and redo bypass the undo
 * middleware; shallow refs do not.
 */
export function selectDirty(s) {
  if (!s?.project) return false
  if (s.documentState) return !!s.documentState.dirty
  const ref = s._cleanRef || {}
  return s.project !== ref.project || s.scene !== ref.scene
}

/**
 * Counts for the status bar's output indicator.
 *
 * Memoized on the outputs map for the same reason as the selection summary:
 * it is read as a zustand selector on every store write.
 */
let _outputCache = { deps: null, value: { total: 0, open: 0, bad: 0 } }

export function selectOutputSummary(s) {
  const outputs = s?.outputs || {}
  if (_outputCache.deps === outputs) return _outputCache.value
  const entries = Object.values(outputs)
  let open = 0
  let bad = 0
  for (const o of entries) {
    if (o?.state === 'open' || o?.state === 'ready') open++
    if (o?.state === 'error' || o?.state === 'blocked') bad++
  }
  const value = { total: entries.length, open, bad }
  _outputCache = { deps: outputs, value }
  return value
}
