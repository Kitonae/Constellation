import { create } from 'zustand'
import { parseProject } from './utils/parseProject.js'
import { setFileServerBaseUrl } from './utils/videoUtils.js'
import { setFileServerBase, toFileUri } from './media/uri.js'
import { createMediaSession } from './media/session.js'
import { createDocumentSync } from './document/documentSync.js'
import { buildProjectWrapper } from './utils/projectSerialize.js'
import { createUndoStore, withUndo } from './undo.js'
import {
  MIN_CLIP_DURATION,
  numOr,
  trackMedia,
  trackClipIds,
  clipStart,
  clipDuration,
  clipEnd,
  matchesClip,
  timelineEnd,
} from './utils/clipTime.js'
import { clipInstancesOf, findNode as findNodeIn } from './selectors.js'
import { GetFileServerPort, GetFileServerToken } from '@bindings/app.js'
import { isWails } from './wails/env.js'
import { readSettings, writeSettings, isValidSetting } from './settings.js'
import { applyTheme } from './theme.js'

// Initialize the file server base URL if running under Wails. This is the only
// place it happens — App.jsx used to repeat it on mount.
if (isWails()) {
  Promise.all([GetFileServerPort(), GetFileServerToken()]).then(([port, token]) => {
    if (port > 0) {
      const base = `http://localhost:${port}`
      setFileServerBaseUrl(base, token)
      // Store port for model URL resolution
      useEditorStore.setState({ _fileServerPort: port })
      // Also set the Media Foundation URI resolver's base
      setFileServerBase(base, token)
      queueLog('info', `Video sidecar active on port ${port}`)
    }
  }).catch(err => queueLog('error', `Sidecar error: ${err}`))
} else {
  queueLog('warn', 'Wails API not available')
}

export const useEditorStore = create(withUndo((set, get, api) => ({
  ...createUndoStore(set, get, api),
  _fileServerPort: 0,
  project: null,
  scene: null,
  time: 0,
  playing: false,
  importingMediaCount: 0,
  importingMediaCountUpdatedAt: 0,
  viewMode: '2d', // '2d' | '3d'
  showOutputOverlay: true,
  // Selection. Node, clip and media selections are mutually exclusive: the
  // setters below clear the other two, so the Inspector can never stack a
  // screen's sections on top of a clip's.
  selectedId: null,
  selectedClipId: null, // primary selected timeline item id
  selectedClipIds: [], // multi-select support for stage/timeline
  selectedMediaId: null, // selected media-bin asset
  selectedTrackIndex: null, // selected track index
  gizmoMode: 'translate',

  // --- Status, document identity and outputs ------------------------------
  // The status bar reads all of these. They used to be local App state that
  // was set and never rendered, so a failed save looked like nothing at all.
  statusMessage: null, // { text, level, time }
  setStatus: (text, level = 'info') => set({ statusMessage: { text: String(text ?? ''), level, time: Date.now() } }),
  documentName: '',
  setDocumentName: (name) => set({ documentName: String(name || '') }),

  // What the shell says about the open document: its file, its name and
  // whether it differs from what is on disk. The editor mirrors this rather
  // than deciding it, because only the shell knows what was written.
  documentState: null, // { path, fileName, name, dirty, version }
  setDocumentState: (next) => set(() => {
    if (!next) return {}
    return {
      documentState: next,
      // The title bar and the status bar name the file when there is one and
      // fall back to the show's own name for a show never saved.
      documentName: next.fileName || next.name || '',
    }
  }),
  // Recent shows, offered by the File menu. The shell keeps the list; it
  // survives restarts and drops files that have since moved.
  recentShows: [],
  setRecentShows: (list) => set({ recentShows: Array.isArray(list) ? list : [] }),

  // The reference the document is compared against to decide "dirty" when
  // there is no shell to ask -- plain-browser development and the UI tests.
  // A boolean flag would go stale because undo/redo bypass the middleware.
  _cleanRef: { project: null, scene: null },
  markClean: () => set((s) => ({ _cleanRef: { project: s.project, scene: s.scene } })),

  outputs: {}, // screenId -> { type, state, fps, error, name }
  setOutputStatus: (screenId, patch) => set((s) => ({
    outputs: { ...s.outputs, [screenId]: { ...(s.outputs[screenId] || {}), ...patch } },
  })),
  clearOutputStatus: (screenId) => set((s) => {
    if (!(screenId in s.outputs)) return {}
    const next = { ...s.outputs }
    delete next[screenId]
    return { outputs: next }
  }),
  // Gates the screen effect in App, so "Close All Displays" stays closed even
  // when the scene changes afterwards.
  outputsEnabled: true,
  setOutputsEnabled: (on) => set({ outputsEnabled: !!on }),
  // A request for App to tear down and re-open one screen's output. The Go
  // backend owns the renderer lifecycle; this only asks.
  screenReopenRequest: null,
  requestScreenReopen: (id) => set({ screenReopenRequest: { id, nonce: Date.now() } }),

  // --- Modal confirmation -------------------------------------------------
  // Any code path can `await askConfirm(...)`; ConfirmHost renders whatever
  // is pending. Replaces window.confirm, which in a webview is an unstyled
  // OS modal that returns focus nowhere.
  confirmRequest: null,
  askConfirm: (opts) => new Promise((resolve) => {
    set({ confirmRequest: { confirmLabel: 'OK', cancelLabel: 'Cancel', ...opts, resolve } })
  }),
  resolveConfirm: (result) => {
    const req = get().confirmRequest
    set({ confirmRequest: null })
    try { req?.resolve?.(!!result) } catch { }
  },

  // --- Panel layout (persisted by layout/persistLayout.js) ----------------
  layout: {
    mediaWidth: 300,
    inspectorWidth: 320,
    timelineHeight: 320,
    mediaCollapsed: false,
    inspectorCollapsed: false,
    timelineCollapsed: false,
  },
  setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...(typeof patch === 'function' ? patch(s.layout) : patch) } })),
  toggleLayoutPanel: (which) => set((s) => {
    const key = which === 'media' ? 'mediaCollapsed' : which === 'inspector' ? 'inspectorCollapsed' : 'timelineCollapsed'
    return { layout: { ...s.layout, [key]: !s.layout[key] } }
  }),

  // Keyboard-shortcut help overlay
  shortcutsHelpOpen: false,
  toggleShortcutsHelp: () => set((s) => ({ shortcutsHelpOpen: !s.shortcutsHelpOpen })),

  // Editor preferences. These describe the editor, not the show, so they are
  // read from local storage at startup, written straight back on change, and
  // deliberately kept out of the project and the undo stack.
  settings: readSettings(),
  setSetting: (key, value) => set((s) => {
    if (!isValidSetting(key, value)) {
      queueLog('warn', `Ignored unknown setting ${key}=${value}`)
      return {}
    }
    const settings = { ...s.settings, [key]: value }
    writeSettings(settings)
    if (key === 'theme') applyTheme(value)
    return { settings }
  }),
  settingsOpen: false,
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  // Console/logging state
  logs: [], // { id, level, message, time }
  consoleOpen: false,
  addLog: ({ level = 'info', message }) => set((s) => {
    const entry = {
      id: `log-${Math.random().toString(36).slice(2, 9)}`,
      level,
      message: String(message ?? ''),
      time: Date.now(),
    }
    const next = [...s.logs, entry]
    // keep last 500 entries
    const pruned = next.length > 500 ? next.slice(next.length - 500) : next
    // Anything that went wrong belongs on the status bar too — the console
    // drawer is hidden behind a keystroke most users never find. Done inside
    // this reducer so it stays one commit.
    const patch = { logs: pruned }
    if (level === 'warn' || level === 'error') {
      patch.statusMessage = { text: entry.message, level, time: entry.time }
    }
    return patch
  }),
  clearLogs: () => set({ logs: [] }),
  beginImport: () => set((s) => {
    const next = Math.max(0, (s.importingMediaCount || 0) + 1)
    console.debug('[import] begin ->', next)
    return { importingMediaCount: next, importingMediaCountUpdatedAt: Date.now() }
  }),
  endImport: () => set((s) => {
    const next = Math.max(0, (s.importingMediaCount || 0) - 1)
    console.debug('[import] end ->', next)
    return { importingMediaCount: next, importingMediaCountUpdatedAt: Date.now() }
  }),
  resetImportingIfStuck: () => set((s) => {
    if (s.importingMediaCount > 0 && Date.now() - (s.importingMediaCountUpdatedAt || 0) > 15000) {
      queueLog('warn', 'Import appeared stuck >15s; auto-reset')
      console.warn('[import] auto-reset stuck imports')
      return { importingMediaCount: 0, importProgress: null }
    }
    return {}
  }),
  // Detailed import progress
  importProgress: null, // { current, total, filename, cancelled }
  startImport: (total) => set({ importProgress: { current: 0, total, filename: '', cancelled: false } }),
  updateImportProgress: (current, filename) => set((s) => s.importProgress ? { importProgress: { ...s.importProgress, current, filename } } : {}),
  cancelImport: () => set((s) => s.importProgress ? { importProgress: { ...s.importProgress, cancelled: true } } : {}),
  finishImport: () => set({ importProgress: null }),
  toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),
  setViewMode: (mode) => set({ viewMode: (mode === '3d' || mode === 'output') ? mode : '2d' }),
  toggleViewMode: () => set((s) => ({ viewMode: s.viewMode === '2d' ? '3d' : '2d' })),
  toggleOutputOverlay: () => set((s) => ({ showOutputOverlay: !s.showOutputOverlay })),
  addScreenNode: ({ name, pixels, position, scale, screenType }) => set((s) => {
    const px = pixels || [1920, 1080]
    const scene = s.scene || { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
    const id = `screen-${Math.random().toString(36).slice(2, 8)}`
    const node = {
      id,
      name: name || `Screen ${scene.roots.length + 1}`,
      transform: {
        position: position || { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: scale || { x: 1, y: 1, z: 1 },
      },
      children: [],
      kind: { type: 'screen', screenType: screenType || 'web', pixels: [px[0] | 0, px[1] | 0], enabled: true },
    }
    const nextScene = { ...scene, roots: [...(scene.roots || []), node] }
    const proj = s.project || defaultProject(nextScene)
    return { scene: nextScene, project: proj, selectedId: id, _undoLabel: 'Add Screen' }
  }),
  loadProject: (json) => {
    const proj = parseProject(json)
    // Migrate legacy tracks (single media object -> array)
    if (proj.timeline?.tracks) {
      proj.timeline.tracks = proj.timeline.tracks.map(t => {
        if (t.media && !Array.isArray(t.media)) {
          return { ...t, media: [t.media] }
        }
        if (!t.media && !Array.isArray(t.media)) {
          return { ...t, media: [] }
        }
        return t
      })
    }
    // Replacing the document replaces the show. The transport used to keep
    // running against the old clock: the UI showed zero while the session
    // sat at 42 s and still playing, and the next tick and the next snapshot
    // both carried the old time to every output.
    resetTransport()
    set({ project: proj, scene: proj.scene, selectedId: null, selectedClipId: null, selectedClipIds: [], selectedMediaId: null, time: 0, _undoLabel: 'Load Project' })
    // Opening a document starts a new history. Undo used to walk back into
    // the *previous* document, and at startup one Ctrl+Z could restore the
    // null project the app was created from.
    resetHistory('Load Project')
    get().markClean()
  },
  newProject: () => {
    const scene = { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
    const proj = defaultProject(scene)
    resetTransport()
    set({ project: proj, scene: proj.scene, selectedId: null, selectedClipId: null, selectedClipIds: [], selectedMediaId: null, time: 0, _undoLabel: 'New Project' })
    resetHistory('New Project')
    get().markClean()
  },
  // Add a generic media clip to the project's media bin
  addMediaClip: ({ id, name, uri, duration_seconds, format }) => set((s) => {
    const clip = {
      id: id || `clip-${Math.random().toString(36).slice(2, 8)}`,
      name: name || 'Clip',
      uri,
      duration_seconds: duration_seconds ?? 10,
      added_at: Date.now(),
      ...(format ? { format } : {}),
    }
    const baseProj = s.project ?? defaultProject(s.scene)
    const nextProj = { ...baseProj, media: [...(baseProj.media ?? []), clip] }
    queueLog('info', `Imported media: ${clip.name}`)
    // If we had to create a default project, also ensure scene is set in store
    return s.project
      ? { project: nextProj, _undoLabel: 'Import Media' }
      : { project: nextProj, scene: baseProj.scene, _undoLabel: 'Import Media' }
  }),
  addTrack: () => set((s) => {
    const tl = s.project?.timeline
    if (!tl) return {}
    const tracks = [...(tl.tracks || []), { media: [] }]
    return { project: { ...s.project, timeline: { ...tl, tracks } }, _undoLabel: 'Add Track' }
  }),
  // Insert an existing clip onto the timeline.
  // Returns the new *timeline item* id so callers (e.g. Timeline's drop
  // handler) can select the thing they just created rather than the asset id.
  addClipToTimeline: ({ clipId, startAt, duration, targetNodeId, position, scale, trackIndex }) => {
    const s = get()
    if (!s.project) return null
    const clip = (s.project.media || []).find((m) => m.id === clipId)
    if (!clip) return null
    // Older imports stored models with zero duration. A newly placed source
    // still needs a visible interval, just like an image.
    const sourceDuration = numOr(clip.duration_seconds, 10)
    const dur = numOr(duration, sourceDuration > 0 ? sourceDuration : 10)
    const startTime = numOr(startAt, currentTime(s))
    // No per-screen association; leave target empty
    const tm = {
      id: `tl-${Math.random().toString(36).slice(2, 9)}`,
      target_node_id: '',
      clip_id: clipId,
      in_seconds: 0,
      out_seconds: dur,
      start_at_seconds: startTime,
      // new fields
      start: startTime,
      duration: dur,
      position: position ? { x: toInt(position.x, 0), y: toInt(position.y, 0) } : { x: 0, y: 0 },
      // 0 means use natural dimensions; renderer falls back to image width/height
      scale: scale ? { x: toInt(scale.x, 0), y: toInt(scale.y, 0) } : { x: 0, y: 0 },
      fade_in: 0,
      fade_out: 0,
    }
    const nextTimeline = s.project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, startTime + dur) }
    let tracks = [...(nextTimeline.tracks ?? [])]

    let finalTrackIndex = -1

    if (typeof trackIndex === 'number' && trackIndex >= 0) {
      // Explicit track target (e.g. Drag & Drop)
      finalTrackIndex = trackIndex
    } else if (typeof s.selectedTrackIndex === 'number' && s.selectedTrackIndex >= 0 && s.selectedTrackIndex < tracks.length) {
      // Use selected track if available
      finalTrackIndex = s.selectedTrackIndex
    } else {
      // Find first available track with space
      const start = tm.start
      const end = start + tm.duration
      for (let i = 0; i < tracks.length; i++) {
        const mediaList = trackMedia(tracks[i])
        let hasOverlap = false
        for (const m of mediaList) {
          const s2 = clipStart(m)
          const e2 = s2 + clipDuration(m)
          if (start < e2 && s2 < end) {
            hasOverlap = true
            break
          }
        }
        if (!hasOverlap) {
          finalTrackIndex = i
          break
        }
      }
    }

    if (finalTrackIndex >= 0 && finalTrackIndex < tracks.length) {
      // Add to existing track
      tracks[finalTrackIndex] = { ...tracks[finalTrackIndex], media: [...trackMedia(tracks[finalTrackIndex]), tm] }
    } else {
      // Append new track (or insert at specific index if provided but out of bounds)
      if (finalTrackIndex >= 0) {
        tracks.splice(finalTrackIndex, 0, { media: [tm] })
      } else {
        tracks.push({ media: [tm] })
      }
    }

    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, tm.start + tm.duration)
    queueLog('info', `Inserted clip '${clip.name}' at ${tm.start.toFixed(2)}s`)
    set({ project: { ...s.project, timeline: { ...nextTimeline, tracks, duration_seconds } }, _undoLabel: `Add ${clip.name} to Timeline` })
    return tm.id
  },
  // Add an image media clip and a timeline track targeting a screen
  // Accepts either a raw filePath (OS path) or a fully-resolved file URI.
  addImageToShow: ({ filePath, uri, name, duration = 10 }) => set((s) => {
    const baseProj = s.project ?? defaultProject(s.scene)
    const id = `img-${Math.random().toString(36).slice(2, 8)}`
    const clipUri = uri ? String(uri) : toFileUri(String(filePath))
    const clip = { id, name: name || id, uri: clipUri, duration_seconds: duration }
    // pick target screen: selected if it's a screen, otherwise first screen in scene
    // No per-screen association; leave target empty
    const target = ''
    const tm = {
      id: `tl-${Math.random().toString(36).slice(2, 9)}`,
      target_node_id: target ?? '',
      clip_id: id,
      in_seconds: 0,
      out_seconds: duration,
      start_at_seconds: s.time || 0,
      start: s.time || 0,
      duration,
      position: { x: 0, y: 0 },
      // 0 means use natural dimensions; renderer falls back to image width/height
      scale: { x: 0, y: 0 },
      fade_in: 0,
      fade_out: 0,
    }
    const nextTimeline = baseProj.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: Math.max(60, clipStart(tm) + duration) }
    const tracks = [...(nextTimeline.tracks ?? []), { media: [tm] }]
    const duration_seconds = Math.max(nextTimeline.duration_seconds ?? 0, clipStart(tm) + clipDuration(tm))
    queueLog('info', `Added image '${clip.name}' targeting ${tm.target_node_id || 'scene'} at ${tm.start_at_seconds.toFixed(2)}s`)
    const nextProj = {
      ...baseProj,
      media: [...(baseProj.media ?? []), clip],
      timeline: { ...(nextTimeline ?? {}), tracks, duration_seconds },
    }
    return s.project
      ? { project: nextProj, _undoLabel: `Add Image ${clip.name}` }
      : { project: nextProj, scene: baseProj.scene, _undoLabel: `Add Image ${clip.name}` }
  }),
  // Update a timeline clip's 2D transform parameters
  /**
   * Update one clip's 2D transform.
   *
   * The per-clip work lives in `applyClipPatch` so the multi-clip variant
   * (`updateClipsTransform`) applies exactly the same coercion and clamping.
   */
  updateClipTransform: ({ clipId, timelineId, label, ...patch }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).map((t) => ({
      ...t,
      media: trackMedia(t).map((m) => (m && matchesClip(m, timelineId, clipId) ? applyClipPatch(m, patch) : m)),
    }))
    return {
      project: { ...s.project, timeline: { ...(s.project.timeline || {}), tracks } },
      _undoLabel: label || labelForClipPatch(patch),
    }
  }),
  // Update a specific effect for a clip
  updateClipEffect: ({ timelineId, effect, value, enabled }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).map((t) => {
      const mediaList = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
      const nextMediaList = mediaList.map((m) => {
        if (!m || m.id !== timelineId) return m
        const prevEffects = m.effects || {}
        const prevEffect = prevEffects[effect] || {}
        const nextEffect = {
          value: value !== undefined ? numOr(value, prevEffect.value ?? 0) : numOr(prevEffect.value, 0),
          enabled: enabled !== undefined ? !!enabled : (prevEffect.enabled ?? false)
        }
        return { ...m, effects: { ...prevEffects, [effect]: nextEffect } }
      })
      return { ...t, media: nextMediaList }
    })
    return { project: { ...s.project, timeline: { ...(s.project.timeline || {}), tracks } }, _undoLabel: `Change ${effect}` }
  }),
  // Update timing for a clip (e.g., when dragging on timeline).
  // Only clamped to >= 0: the timeline renders well past `duration_seconds`,
  // so clamping to it used to make clips undraggable past 60 s.
  updateClipStart: ({ clipId, timelineId, startAt }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tl = s.project.timeline
    const tracks = (tl.tracks || []).map((t) => ({
      ...t,
      media: trackMedia(t).map((m) => {
        if (!m || !matchesClip(m, timelineId, clipId)) return m
        const nextStart = Math.max(0, numOr(startAt, clipStart(m)))
        return { ...m, start_at_seconds: nextStart, start: nextStart }
      }),
    }))
    return { project: { ...s.project, timeline: { ...tl, tracks, duration_seconds: timelineEnd(tracks, tl) } }, _undoLabel: 'Move Clip on Timeline' }
  }),
  // Update explicit duration for a clip (and legacy out_seconds)
  updateClipDuration: ({ clipId, timelineId, duration }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tl = s.project.timeline
    const nextDur = Math.max(0, numOr(duration, 0))
    const tracks = (tl.tracks || []).map((t) => ({
      ...t,
      media: trackMedia(t).map((m) => {
        if (!m || !matchesClip(m, timelineId, clipId)) return m
        return { ...m, duration: nextDur, out_seconds: numOr(m.in_seconds, 0) + nextDur }
      }),
    }))
    return { project: { ...s.project, timeline: { ...tl, tracks, duration_seconds: timelineEnd(tracks, tl) } }, _undoLabel: 'Resize Clip Duration' }
  }),
  /** Move one clip. Kept as a convenience over `moveClips`. */
  moveClip: (timelineId, patch = {}) => get().moveClips([{ id: timelineId, ...patch }]),
  reorderClip: (clipId, newIndex) => get().moveClip(clipId, { trackIndex: newIndex }),

  // --- Batched clip operations -------------------------------------------
  // Each of these is exactly one set() and therefore exactly one undo entry.
  // Dragging five clips used to write five times and need five Ctrl+Z.

  /**
   * Move several clips at once, horizontally and/or between tracks.
   * @param {{id:string,start?:number,trackIndex?:number}[]} patches
   */
  moveClips: (patches, label) => set((s) => {
    if (!s.project?.timeline?.tracks || !patches?.length) return {}
    const tl = s.project.timeline
    const byId = new Map(patches.filter((p) => p?.id).map((p) => [p.id, p]))
    if (!byId.size) return {}

    // Lift every moving clip out, remembering the track it came from.
    const lifted = new Map() // id -> { m, fromIndex }
    let tracks = (tl.tracks || []).map((t, i) => {
      const list = trackMedia(t)
      if (!list.some((m) => byId.has(m?.id))) return t
      const keep = []
      for (const m of list) {
        if (m && byId.has(m.id)) lifted.set(m.id, { m, fromIndex: i })
        else keep.push(m)
      }
      return { ...t, media: keep }
    })
    if (!lifted.size) return {}

    let crossedTracks = false
    for (const [id, entry] of lifted) {
      const patch = byId.get(id)
      let moved = entry.m
      if (patch.start !== undefined) {
        const nextStart = Math.max(0, numOr(patch.start, clipStart(entry.m)))
        moved = { ...moved, start: nextStart, start_at_seconds: nextStart }
      }
      const target = patch.trackIndex === undefined
        ? entry.fromIndex
        : Math.max(0, Math.min(tracks.length - 1, Math.round(numOr(patch.trackIndex, entry.fromIndex))))
      if (target !== entry.fromIndex) crossedTracks = true
      tracks[target] = { ...tracks[target], media: [...trackMedia(tracks[target]), moved] }
    }

    const auto = lifted.size > 1
      ? 'Move Clips'
      : (crossedTracks ? 'Move Clip to Track' : 'Move Clip on Timeline')
    return {
      project: { ...s.project, timeline: { ...tl, tracks, duration_seconds: timelineEnd(tracks, tl) } },
      _undoLabel: label || auto,
    }
  }),

  /**
   * Set a clip's start and duration together.
   *
   * A left-edge trim changes both, and doing that through updateClipStart
   * plus updateClipDuration produced two history entries for one gesture.
   */
  trimClip: (timelineId, { start, duration }) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tl = s.project.timeline
    const tracks = (tl.tracks || []).map((t) => ({
      ...t,
      media: trackMedia(t).map((m) => {
        if (!m || m.id !== timelineId) return m
        const nextDur = Math.max(MIN_CLIP_DURATION, numOr(duration, clipDuration(m)))
        const oldStart = clipStart(m)
        const nextStart = Math.max(0, numOr(start, oldStart))
        // Moving the left edge moves the source in-point with it: trimming
        // three seconds off the front means the clip now begins three
        // seconds into its media. Keeping the old in-point showed source
        // time zero at the new start and re-timed every frame after it.
        const inSec = Math.max(0, numOr(m.in_seconds, 0) + (nextStart - oldStart))
        return {
          ...m,
          start: nextStart,
          start_at_seconds: nextStart,
          duration: nextDur,
          in_seconds: inSec,
          out_seconds: inSec + nextDur,
        }
      }),
    }))
    return {
      project: { ...s.project, timeline: { ...tl, tracks, duration_seconds: timelineEnd(tracks, tl) } },
      _undoLabel: 'Trim Clip',
    }
  }),

  /** Remove several timeline items in one commit. */
  removeClips: (ids) => set((s) => {
    if (!s.project?.timeline?.tracks || !ids?.length) return {}
    const doomed = new Set(ids)
    const tracks = (s.project.timeline.tracks || []).map((t) => ({
      ...t,
      media: trackMedia(t).filter((m) => !doomed.has(m?.id)),
    }))
    const selectedClipIds = (s.selectedClipIds || []).filter((id) => !doomed.has(id))
    return {
      project: { ...s.project, timeline: { ...(s.project.timeline || {}), tracks } },
      selectedClipId: doomed.has(s.selectedClipId) ? (selectedClipIds[0] ?? null) : s.selectedClipId,
      selectedClipIds,
      _undoLabel: doomed.size > 1 ? ('Remove ' + doomed.size + ' Clips') : 'Remove Clip from Timeline',
    }
  }),

  /** Copy clips, each placed immediately after its original on the same track. */
  duplicateClips: (ids) => {
    const s = get()
    if (!s.project?.timeline?.tracks || !ids?.length) return []
    const wanted = new Set(ids)
    const newIds = []
    const tracks = s.project.timeline.tracks.map((t) => {
      const list = trackMedia(t)
      const extra = []
      for (const m of list) {
        if (!m || !wanted.has(m.id)) continue
        const id = 'tl-' + Math.random().toString(36).slice(2, 9)
        const start = clipEnd(m)
        newIds.push(id)
        extra.push({ ...m, id, start, start_at_seconds: start })
      }
      return extra.length ? { ...t, media: [...list, ...extra] } : t
    })
    if (!newIds.length) return []
    const tl = s.project.timeline
    set({
      project: { ...s.project, timeline: { ...tl, tracks, duration_seconds: timelineEnd(tracks, tl) } },
      selectedClipIds: newIds,
      selectedClipId: newIds[0],
      selectedId: null,
      selectedMediaId: null,
      _undoLabel: newIds.length > 1 ? ('Duplicate ' + newIds.length + ' Clips') : 'Duplicate Clip',
    })
    return newIds
  },

  /**
   * Cut a clip in two at `t`.
   *
   * The right half starts its source that much later, so a video keeps
   * playing the same frames across the cut. Fades stay on the outer edges.
   */
  splitClipAtTime: (timelineId, t) => {
    const s = get()
    if (!s.project?.timeline?.tracks) return null
    const at = numOr(t, 0)
    let newId = null
    const tracks = s.project.timeline.tracks.map((track) => {
      const list = trackMedia(track)
      const idx = list.findIndex((m) => m?.id === timelineId)
      if (idx === -1) return track
      const m = list[idx]
      const start = clipStart(m)
      const dur = clipDuration(m)
      const end = start + dur
      if (!(at > start + MIN_CLIP_DURATION && at < end - MIN_CLIP_DURATION)) return track
      const leftDur = at - start
      const rightDur = end - at
      const inSec = numOr(m.in_seconds, 0)
      const left = { ...m, duration: leftDur, out_seconds: inSec + leftDur, fade_out: 0 }
      newId = 'tl-' + Math.random().toString(36).slice(2, 9)
      const right = {
        ...m,
        id: newId,
        start: at,
        start_at_seconds: at,
        duration: rightDur,
        in_seconds: inSec + leftDur,
        out_seconds: inSec + leftDur + rightDur,
        fade_in: 0,
      }
      const next = [...list]
      next.splice(idx, 1, left, right)
      return { ...track, media: next }
    })
    if (!newId) return null
    const tl = s.project.timeline
    set({ project: { ...s.project, timeline: { ...tl, tracks } }, _undoLabel: 'Split Clip' })
    return newId
  },

  /** Apply the same transform patch to several clips in one commit. */
  updateClipsTransform: (ids, patch, label) => set((s) => {
    if (!s.project?.timeline?.tracks || !ids?.length) return {}
    const wanted = new Set(ids)
    const tracks = (s.project.timeline.tracks || []).map((t) => ({
      ...t,
      media: trackMedia(t).map((m) => (m && wanted.has(m.id) ? applyClipPatch(m, patch) : m)),
    }))
    return {
      project: { ...s.project, timeline: { ...(s.project.timeline || {}), tracks } },
      _undoLabel: label || (ids.length > 1 ? ('Edit ' + ids.length + ' Clips') : labelForClipPatch(patch)),
    }
  }),

  // --- Tracks --------------------------------------------------------------

  renameTrack: (index, name) => set((s) => {
    const tl = s.project?.timeline
    if (!tl?.tracks?.[index]) return {}
    const clean = String(name || '').trim()
    const tracks = tl.tracks.map((t, i) => (i === index ? { ...t, name: clean || undefined } : t))
    return { project: { ...s.project, timeline: { ...tl, tracks } }, _undoLabel: 'Rename Track' }
  }),

  removeTrack: (index) => set((s) => {
    const tl = s.project?.timeline
    if (!tl?.tracks?.length || index < 0 || index >= tl.tracks.length) return {}
    const doomed = new Set(trackClipIds(tl.tracks[index]))
    const tracks = tl.tracks.filter((_, i) => i !== index)
    const selectedClipIds = (s.selectedClipIds || []).filter((id) => !doomed.has(id))
    let nextTrackIndex = s.selectedTrackIndex
    if (nextTrackIndex === index) nextTrackIndex = null
    else if (typeof nextTrackIndex === 'number' && nextTrackIndex > index) nextTrackIndex -= 1
    return {
      project: { ...s.project, timeline: { ...tl, tracks } },
      selectedClipIds,
      selectedClipId: doomed.has(s.selectedClipId) ? (selectedClipIds[0] ?? null) : s.selectedClipId,
      selectedTrackIndex: nextTrackIndex,
      _undoLabel: 'Remove Track',
    }
  }),

  // --- Renaming and relinking ---------------------------------------------

  renameNode: (id, name) => set((s) => {
    if (!s.scene?.roots) return {}
    const clean = String(name || '').trim()
    if (!clean) return {}
    const node = findNodeIn(s.scene.roots, id)
    const kind = node?.kind?.type === 'model' ? 'Model' : 'Screen'
    return {
      scene: { ...s.scene, roots: s.scene.roots.map((n) => updateNode(n, id, (x) => ({ ...x, name: clean }))) },
      _undoLabel: 'Rename ' + kind,
    }
  }),

  /** Give one timeline item its own display name, overriding the asset's. */
  renameTimelineClip: (timelineId, label) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const clean = String(label || '').trim()
    const tracks = s.project.timeline.tracks.map((t) => ({
      ...t,
      media: trackMedia(t).map((m) => (m?.id === timelineId ? { ...m, label: clean || undefined } : m)),
    }))
    return { project: { ...s.project, timeline: { ...s.project.timeline, tracks } }, _undoLabel: 'Rename Clip' }
  }),

  renameMedia: (mediaId, name) => set((s) => {
    if (!s.project?.media) return {}
    const clean = String(name || '').trim()
    if (!clean) return {}
    return {
      project: { ...s.project, media: s.project.media.map((m) => (m.id === mediaId ? { ...m, name: clean } : m)) },
      _undoLabel: 'Rename Media',
    }
  }),

  /**
   * Point an asset at a new file, keeping its id.
   *
   * Every timeline instance references the asset by id, so a relink repairs
   * all of them at once - which is the point of relinking over re-importing.
   */
  relinkMedia: (mediaId, opts) => set((s) => {
    const uri = opts?.uri
    if (!s.project?.media || !uri) return {}
    return {
      project: {
        ...s.project,
        media: s.project.media.map((m) => (m.id === mediaId
          ? {
            ...m,
            uri,
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.duration_seconds !== undefined ? { duration_seconds: opts.duration_seconds } : {}),
          }
          : m)),
      },
      _undoLabel: 'Relink Media',
    }
  }),

  duplicateMedia: (mediaId) => set((s) => {
    const src = (s.project?.media || []).find((m) => m.id === mediaId)
    if (!src) return {}
    const copy = { ...src, id: 'clip-' + Math.random().toString(36).slice(2, 8), name: src.name + ' copy', added_at: Date.now() }
    return { project: { ...s.project, media: [...s.project.media, copy] }, _undoLabel: 'Duplicate Media' }
  }),

  // Transport is owned by the MediaSession / PresentationClock. These actions
  // only forward; `playing` and `time` are mirrored back by the subscription
  // installed in getMediaSession() below.
  play: () => {
    queueLog('info', 'Local: play')
    try { getMediaSession().play() } catch { set({ playing: true }) }
  },
  pause: () => {
    queueLog('info', 'Local: pause')
    try { getMediaSession().pause() } catch { set({ playing: false }) }
  },
  stop: () => {
    queueLog('info', 'Local: stop')
    try {
      const ms = getMediaSession()
      ms.stop()
      // session.stop() early-returns when the clock is already stopped, so a
      // clock that was seeked while paused would keep its old time and the
      // playhead would not come home. Seek explicitly in that case; the
      // clock's onStop/onSeek then moves every playhead for us.
      if (ms.getTime() !== 0) ms.seek(0)
    } catch { set({ playing: false, time: 0 }) }
    set({ time: 0 })
  },
  seek: (t) => {
    const next = Math.max(0, numOr(t, 0))
    set({ time: next })
    try { getMediaSession().seek(next) } catch {}
  },
  // Selecting one kind of thing clears the others. Clearing one kind leaves
  // the rest alone, so the viewport's two-call "clear everything" still works.
  setSelected: (id) => set(id
    ? { selectedId: id, selectedClipId: null, selectedClipIds: [], selectedMediaId: null }
    : { selectedId: null }),
  setSelectedClip: (clipId) => set(clipId
    ? { selectedClipId: clipId, selectedClipIds: [clipId], selectedId: null, selectedMediaId: null }
    : { selectedClipId: null, selectedClipIds: [] }),
  setSelectedClips: (clipIds) => {
    const ids = Array.isArray(clipIds) ? clipIds.filter(Boolean) : []
    set(ids.length
      ? { selectedClipIds: ids, selectedClipId: ids[0], selectedId: null, selectedMediaId: null }
      : { selectedClipIds: [], selectedClipId: null })
  },
  setSelectedMedia: (id) => set(id
    ? { selectedMediaId: id, selectedId: null, selectedClipId: null, selectedClipIds: [] }
    : { selectedMediaId: null }),
  clearSelection: () => set({ selectedId: null, selectedClipId: null, selectedClipIds: [], selectedMediaId: null }),
  /** Select every timeline item in the project. */
  selectAllClips: () => {
    const ids = allClipIdsOf(get().project)
    get().setSelectedClips(ids)
  },
  /** Select every clip on one track. */
  selectClipsInTrack: (index) => {
    const t = get().project?.timeline?.tracks?.[index]
    if (!t) return
    get().setSelectedClips(trackClipIds(t))
  },
  setSelectedTrackIndex: (index) => set({ selectedTrackIndex: index }),
  setGizmoMode: (mode) => set({ gizmoMode: mode }),
  updateNodeTransform: (id, next, label = 'Move Screen') => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => ({
        ...node,
        transform: {
          position: next.position ?? node.transform.position,
          rotation: next.rotation ?? node.transform.rotation,
          scale: next.scale ?? node.transform.scale,
        }
      })))
    },
    _undoLabel: label,
  })),
  // Remove a clip instance from the timeline by timeline item id
  removeClip: (clipId) => set((s) => {
    if (!s.project?.timeline?.tracks) return {}
    const tracks = (s.project.timeline.tracks || []).map((t) => {
      const mediaList = Array.isArray(t.media) ? t.media : (t.media ? [t.media] : [])
      return { ...t, media: mediaList.filter((m) => m.id !== clipId) }
    })
    const nextTl = { ...(s.project.timeline || {}), tracks }
    return { project: { ...s.project, timeline: nextTl }, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId, _undoLabel: 'Remove Clip from Timeline' }
  }),
  // Remove a media clip from the bin and any timeline references
  removeMediaClip: (clipId) => set((s) => {
    if (!s.project) return {}
    const nextMedia = (s.project.media || []).filter((m) => m.id !== clipId)
    // Every timeline instance of the asset goes with it, so any selection
    // pointing at one of those instances has to go too.
    const doomed = new Set(clipInstancesOf(s.project, clipId).map((m) => m.id))
    let nextTl = s.project.timeline || null
    if (nextTl?.tracks?.length) {
      const tracks = nextTl.tracks.map((t) => ({
        ...t,
        media: trackMedia(t).filter((m) => m.clip_id !== clipId),
      }))
      nextTl = { ...nextTl, tracks }
    }
    const nextProject = { ...s.project, media: nextMedia, ...(nextTl ? { timeline: nextTl } : {}) }
    const selectedClipIds = (s.selectedClipIds || []).filter((id) => !doomed.has(id))
    return {
      project: nextProject,
      selectedClipId: doomed.has(s.selectedClipId) ? (selectedClipIds[0] ?? null) : s.selectedClipId,
      selectedClipIds,
      selectedMediaId: s.selectedMediaId === clipId ? null : s.selectedMediaId,
      _undoLabel: 'Remove Media',
    }
  }),
  updateScreenPixels: (id, pixels) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
        if (node.kind?.type === 'screen') {
          return { ...node, kind: { ...node.kind, pixels: [pixels[0] | 0, pixels[1] | 0] } }
        }
        return node
      }))
    },
    _undoLabel: `Resize Screen to ${pixels[0]}x${pixels[1]}`,
  })),
  /**
   * Place an output window on the desktop, or unplace it with null.
   *
   * `patch` is `{ x, y, borderless }`, or `{ output, pixels }` when the
   * resolution changes with it (filling a display). Coordinates are physical
   * pixels of Windows' virtual screen; see output/placement.js.
   */
  updateScreenOutput: (id, patch) => set((s) => {
    const next = patch === null ? null : (patch.output || patch)
    const output = next ? { x: Math.round(next.x) | 0, y: Math.round(next.y) | 0, borderless: !!next.borderless } : null
    const pixels = patch?.pixels ? [patch.pixels[0] | 0, patch.pixels[1] | 0] : null
    return {
      scene: {
        ...s.scene,
        roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
          if (node.kind?.type !== 'screen') return node
          const kind = { ...node.kind }
          if (output) kind.output = output
          else delete kind.output
          if (pixels) kind.pixels = pixels
          return { ...node, kind }
        })),
      },
      _undoLabel: output ? (pixels ? 'Fill Display' : 'Place Output') : 'Unplace Output',
    }
  }),
  updateScreenType: (id, screenType) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
        if (node.kind?.type === 'screen') {
          return { ...node, kind: { ...node.kind, screenType } }
        }
        return node
      }))
    },
    _undoLabel: `Change Screen Type to ${screenType}`,
  })),
  updateScreenEnabled: (id, enabled) => set((s) => ({
    scene: {
      ...s.scene,
      roots: s.scene.roots.map((n) => updateNode(n, id, (node) => {
        if (node.kind?.type === 'screen') {
          return { ...node, kind: { ...node.kind, enabled: !!enabled } }
        }
        return node
      }))
    },
    _undoLabel: enabled ? 'Enable Screen' : 'Disable Screen',
  })),
  addModelNode: ({ name, uri, format, position, scale }) => set((s) => {
    const scene = s.scene || { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
    const id = `model-${Math.random().toString(36).slice(2, 8)}`
    const node = {
      id,
      name: name || 'Model',
      transform: {
        position: position || { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: scale || { x: 1, y: 1, z: 1 },
      },
      children: [],
      kind: { type: 'model', uri, ...(format ? { format } : {}) },
    }
    const nextScene = { ...scene, roots: [...(scene.roots || []), node] }
    const proj = s.project || defaultProject(nextScene)
    queueLog('info', `Added 3D model '${node.name}' to scene`)
    return { scene: nextScene, project: proj, selectedId: id, _undoLabel: `Add Model ${name || 'Model'}` }
  }),
  removeScreenNode: (id) => set((s) => {
    if (!s.scene?.roots) return {}
    function removeNodeRec(node, targetId) {
      if (node.id === targetId) return null
      const children = (node.children || [])
        .map((c) => removeNodeRec(c, targetId))
        .filter(Boolean)
      return { ...node, children }
    }
    const roots = (s.scene.roots || [])
      .map((n) => removeNodeRec(n, id))
      .filter(Boolean)
    return { scene: { ...s.scene, roots }, selectedId: s.selectedId === id ? null : s.selectedId, _undoLabel: 'Remove Screen' }
  }),
})))
window.useEditorStore = useEditorStore

/**
 * Start a fresh undo history at the current document.
 *
 * Called when a document is created or opened: those are not edits to the
 * old document, they replace it, and history that crosses that boundary can
 * only restore something the user cannot see.
 */
function resetHistory(label) {
  useEditorStore.setState({ _undoStack: [], _redoStack: [], _undoLabel: null, _currentLabel: label })
}

// Helper to enqueue a log entry without needing a store setter in scope
function queueLog(level, message) {
  try {
    const fn = useEditorStore.getState().addLog
    if (fn) fn({ level, message })
  } catch { }
}

// --- shared coercion / legacy-shape helpers ---

/**
 * The playhead position to use for "insert here" actions.
 *
 * `state.time` is only a ~10 Hz mirror of the PresentationClock, so read the
 * clock directly when it exists and fall back to the mirror otherwise.
 */
function currentTime(state) {
  try { return numOr(getMediaSession().getTime(), numOr(state?.time, 0)) } catch { }
  return numOr(state?.time, 0)
}

/**
 * Apply a transform patch to one clip.
 *
 * Shared by the single- and multi-clip actions so both coerce and clamp
 * identically. Every numeric field goes through numOr: a half-typed value
 * from an Inspector field must never land NaN in the document, which used to
 * make a clip vanish or close an output window.
 *
 * `positionDelta` nudges rather than sets, which is what a multi-selection
 * edit needs (each clip keeps its own offset).
 */
function applyClipPatch(m, patch) {
  const { position, positionDelta, scale, opacity, blur, fade_in, fade_out } = patch || {}

  let nextPos = m.position ? { x: toInt(m.position.x, 0), y: toInt(m.position.y, 0) } : { x: 0, y: 0 }
  if (position) {
    nextPos = { x: toInt(position.x, nextPos.x), y: toInt(position.y, nextPos.y) }
  }
  if (positionDelta) {
    nextPos = {
      x: toInt(nextPos.x + numOr(positionDelta.dx, 0), nextPos.x),
      y: toInt(nextPos.y + numOr(positionDelta.dy, 0), nextPos.y),
    }
  }

  const nextScale = scale
    ? { x: toInt(scale.x, m.scale?.x ?? 0), y: toInt(scale.y, m.scale?.y ?? 0) }
    : (m.scale ? { x: toInt(m.scale.x, 0), y: toInt(m.scale.y, 0) } : { x: 0, y: 0 })

  const nextOpacity = (opacity !== undefined)
    ? Math.max(0, Math.min(1, numOr(opacity, m.opacity ?? 1)))
    : numOr(m.opacity, 1)
  const nextBlur = (blur !== undefined)
    ? Math.max(0, numOr(blur, m.blur ?? 0))
    : numOr(m.blur, 0)
  const nextFadeIn = (fade_in !== undefined)
    ? Math.max(0, numOr(fade_in, m.fade_in ?? 0))
    : numOr(m.fade_in, 0)
  const nextFadeOut = (fade_out !== undefined)
    ? Math.max(0, numOr(fade_out, m.fade_out ?? 0))
    : numOr(m.fade_out, 0)

  return { ...m, position: nextPos, scale: nextScale, opacity: nextOpacity, blur: nextBlur, fade_in: nextFadeIn, fade_out: nextFadeOut }
}

/** History label inferred from which field a transform patch touches. */
function labelForClipPatch(patch) {
  if (!patch) return 'Edit Clip'
  if (patch.position || patch.positionDelta) return 'Move Clip'
  if (patch.scale) return 'Resize Clip'
  if (patch.opacity !== undefined) return 'Change Opacity'
  if (patch.fade_in !== undefined || patch.fade_out !== undefined) return 'Change Fade'
  if (patch.blur !== undefined) return 'Change Blur'
  return 'Edit Clip'
}

/** Every timeline item id in a project. */
function allClipIdsOf(project) {
  const out = []
  for (const t of project?.timeline?.tracks || []) {
    for (const m of trackMedia(t)) if (m?.id) out.push(m.id)
  }
  return out
}

// Integer coercion helper for pixel-based values
function toInt(val, fallback = 0) {
  const n = Number(val)
  if (!Number.isFinite(n)) return Number.isFinite(fallback) ? Math.round(Number(fallback)) : 0
  return Math.round(n)
}

function defaultProject(scene) {
  const baseScene = scene ?? { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] }
  return {
    id: 'untitled',
    name: 'Untitled',
    scene: baseScene,
    media: [],
    timeline: { id: 'tl', name: 'Timeline', tracks: [{ media: [] }], events: [], duration_seconds: 60 },
  }
}

function updateNode(node, id, fn) {
  if (node.id === id) return fn(node)
  if (!node.children?.length) return node
  return { ...node, children: node.children.map((c) => updateNode(c, id, fn)) }
}

/**
 * Stop and rewind the authoritative clock, so a document change does not
 * inherit the previous show's position or playing state.
 *
 * stop() alone is not enough: a session that has only ever been scrubbed is
 * still `idle`, and stop() ignores that state while the clock holds the
 * scrubbed time. Seeking to zero afterwards covers it.
 */
function resetTransport() {
  const session = getMediaSession()
  try { session.stop() } catch { }
  try { session.seek(0) } catch { }
}

// --- Media Session singleton ---
// The session is created lazily (after the store exists) and wired to sync
// transport state back into zustand so all existing components keep working.

let _mediaSession = null

/**
 * Get (or create) the global MediaSession instance.
 * @returns {object} MediaSession
 */
export function getMediaSession() {
  if (!_mediaSession) {
    _mediaSession = createMediaSession({
      // The single source of truth handed to every sink.
      getSnapshot: () => {
        const s = useEditorStore.getState()
        if (!s.project || !s.scene) return null
        return {
          project: s.project,
          scene: s.scene,
          time: _mediaSession ? _mediaSession.getTime() : (s.time || 0),
          playing: s.playing,
        }
      },
      uiUpdateInterval: 100,
    })

    // Mirror clock time into zustand at the session's UI rate. Components that
    // need per-frame time subscribe to the clock directly instead.
    _mediaSession.subscribe({
      onTimeUpdate(time) {
        useEditorStore.setState({ time })
      },
      onStateChange(newState) {
        const patch = { playing: newState === 'playing' }
        if (newState === 'stopped') patch.time = 0
        useEditorStore.setState(patch)
      },
    })
  }
  return _mediaSession
}

/**
 * Serialize the open document the way it is stored and sent: the on-disk
 * project wrapper. One function, so the shell, the renderers and the
 * round-trip test all see the same bytes.
 */
export function serializeDocument(state = useEditorStore.getState()) {
  if (!state?.project || !state?.scene) return null
  return JSON.stringify(buildProjectWrapper(state.project, state.scene))
}

// --- Document sync singleton ---

let _documentSync = null

/**
 * Get (or create) the bridge to the shell's document ownership.
 *
 * Created lazily for the same reason the session is: it needs the store to
 * exist, and it must not reach for Wails bindings in a plain browser.
 */
export function getDocumentSync() {
  if (!_documentSync) {
    _documentSync = createDocumentSync({
      serialize: () => serializeDocument(),
      onState: (st) => useEditorStore.getState().setDocumentState(st),
      onError: (message) => queueLog('error', message),
    })
  }
  return _documentSync
}
