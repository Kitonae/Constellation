// Console command registry — maps text commands to editor actions

import { useEditorStore, getMediaSession } from '../store.js'
import {
  getTimelineTracks,
  getTrackItems,
  getTimelineItemStart,
  getTimelineItemDuration,
  getTimelineItemAssetId,
} from '../project/projectCodec.js'

/**
 * Execute a console command. Returns { level, message } log entries.
 * @param {string} raw - raw command text
 * @returns {{ level: string, message: string }[]}
 */
export function executeCommand(raw) {
  const text = String(raw || '').trim()
  if (!text) return []

  const parts = text.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)
  const st = useEditorStore.getState()

  const handler = COMMANDS[cmd]
  if (!handler) {
    return [{ level: 'warn', message: `Unknown command: ${text}. Type "help" for a list.` }]
  }

  try {
    const result = handler(st, args, text)
    if (!result) return []
    if (typeof result === 'string') return [{ level: 'info', message: result }]
    if (Array.isArray(result)) return result
    return [result]
  } catch (e) {
    return [{ level: 'error', message: `Error: ${e.message || e}` }]
  }
}

// --- Command implementations ---

const COMMANDS = {
  // Transport
  play: (st) => { st.play(); return 'Playing' },
  pause: (st) => { st.pause(); return 'Paused' },
  stop: (st) => { st.stop(); return 'Stopped (time reset to 0)' },
  seek: (st, args) => {
    const t = parseFloat(args[0])
    if (!Number.isFinite(t) || t < 0) return { level: 'warn', message: 'Usage: seek <seconds>' }
    st.seek(t)
    return `Seeked to ${t.toFixed(2)}s`
  },
  rate: (st, args) => {
    const r = parseFloat(args[0])
    if (!Number.isFinite(r) || r <= 0) return { level: 'warn', message: 'Usage: rate <multiplier> (e.g. 0.5, 1, 2)' }
    try { getMediaSession().setRate(r) } catch {}
    return `Playback rate set to ${r}x`
  },

  // Project
  new: (st) => { st.newProject(); return 'New project created' },
  undo: (st) => { st.undo(); return 'Undo' },
  redo: (st) => { st.redo(); return 'Redo' },

  // Timeline
  'add-track': (st) => { st.addTrack(); return 'Track added' },
  'remove-clip': (st) => {
    if (!st.selectedClipId) return { level: 'warn', message: 'No clip selected' }
    const id = st.selectedClipId
    st.removeClip(id)
    return `Removed clip ${id} from timeline`
  },
  'remove-media': (st) => {
    if (!st.selectedClipId) return { level: 'warn', message: 'No clip selected' }
    // Find the media asset ID from the selected timeline item
    const tl = st.project?.timeline
    if (!tl) return { level: 'warn', message: 'No timeline' }
    let assetId = null
    for (const track of getTimelineTracks(tl)) {
      for (const item of getTrackItems(track)) {
        if (item.id === st.selectedClipId) {
          assetId = getTimelineItemAssetId(item)
          break
        }
      }
      if (assetId) break
    }
    if (!assetId) return { level: 'warn', message: 'Could not find media for selected clip' }
    st.removeMediaClip(assetId)
    return `Removed media ${assetId} from bin and timeline`
  },

  // Scene
  'add-screen': (st, args) => {
    const screenType = (args[0] === 'renderer') ? 'renderer' : 'web'
    let pixels = [1920, 1080]
    if (args.length >= 2) {
      const match = String(args[args.length - 1]).match(/^(\d+)x(\d+)$/i)
      if (match) pixels = [parseInt(match[1], 10), parseInt(match[2], 10)]
    }
    st.addScreenNode({ pixels, screenType })
    return `Added ${screenType} screen (${pixels[0]}x${pixels[1]})`
  },
  'remove-screen': (st) => {
    if (!st.selectedId) return { level: 'warn', message: 'No screen selected' }
    const node = findNodeInScene(st.scene, st.selectedId)
    if (!node || node.kind?.type !== 'screen') return { level: 'warn', message: 'Selected node is not a screen' }
    st.removeScreenNode(st.selectedId)
    return `Removed screen ${st.selectedId}`
  },
  'enable-screen': (st) => {
    if (!st.selectedId) return { level: 'warn', message: 'No screen selected' }
    st.updateScreenEnabled(st.selectedId, true)
    return `Enabled screen ${st.selectedId}`
  },
  'disable-screen': (st) => {
    if (!st.selectedId) return { level: 'warn', message: 'No screen selected' }
    st.updateScreenEnabled(st.selectedId, false)
    return `Disabled screen ${st.selectedId}`
  },
  'set-resolution': (st, args) => {
    if (!st.selectedId) return { level: 'warn', message: 'No screen selected' }
    const match = String(args[0] || '').match(/^(\d+)x(\d+)$/i)
    if (!match) return { level: 'warn', message: 'Usage: set-resolution <W>x<H> (e.g. 1920x1080)' }
    const px = [parseInt(match[1], 10), parseInt(match[2], 10)]
    st.updateScreenPixels(st.selectedId, px)
    return `Set resolution to ${px[0]}x${px[1]}`
  },
  'set-screen-type': (st, args) => {
    if (!st.selectedId) return { level: 'warn', message: 'No screen selected' }
    const type = args[0] === 'renderer' ? 'renderer' : 'web'
    st.updateScreenType(st.selectedId, type)
    return `Set screen type to ${type}`
  },

  // View
  view: (st, args) => {
    const mode = args[0]?.toLowerCase()
    if (!mode || !['2d', '3d'].includes(mode)) return { level: 'warn', message: 'Usage: view 2d|3d' }
    st.setViewMode(mode)
    return `View mode: ${mode}`
  },
  overlay: (st) => {
    st.toggleOutputOverlay()
    return `Output overlay toggled`
  },
  gizmo: (st, args) => {
    const mode = args[0]?.toLowerCase()
    if (!mode || !['translate', 'rotate', 'scale'].includes(mode)) return { level: 'warn', message: 'Usage: gizmo translate|rotate|scale' }
    st.setGizmoMode(mode)
    return `Gizmo mode: ${mode}`
  },

  // Info / System
  clear: () => {
    useEditorStore.getState().clearLogs()
    return null // clearLogs wipes the log, no message needed
  },
  time: (st) => `Current time: ${st.time.toFixed(3)}s (${st.playing ? 'playing' : 'paused'})`,
  status: (st) => {
    const lines = []
    lines.push({ level: 'info', message: `Project: ${st.project?.name || '(none)'}` })
    lines.push({ level: 'info', message: `Time: ${st.time.toFixed(3)}s | ${st.playing ? 'Playing' : 'Paused'}` })
    const tracks = getTimelineTracks(st.project?.timeline)
    const clipCount = tracks.reduce((n, t) => n + getTrackItems(t).length, 0)
    lines.push({ level: 'info', message: `Timeline: ${tracks.length} tracks, ${clipCount} clips` })
    lines.push({ level: 'info', message: `Media bin: ${(st.project?.media || []).length} assets` })
    const screens = (st.scene?.roots || []).filter(n => n.kind?.type === 'screen')
    lines.push({ level: 'info', message: `Screens: ${screens.length}` })
    return lines
  },
  'list-media': (st) => {
    const media = st.project?.media || []
    if (!media.length) return 'Media bin is empty'
    return media.map(m => ({ level: 'info', message: `  ${m.id}  ${m.name || '(unnamed)'}  ${m.uri ? m.uri.slice(0, 60) : ''}` }))
  },
  'list-screens': (st) => {
    const screens = (st.scene?.roots || []).filter(n => n.kind?.type === 'screen')
    if (!screens.length) return 'No screens in scene'
    return screens.map(n => {
      const px = n.kind?.pixels || [0, 0]
      const type = n.kind?.screenType || 'web'
      const enabled = n.kind?.enabled !== false
      return { level: 'info', message: `  ${n.id}  ${n.name || ''}  ${px[0]}x${px[1]}  ${type}  ${enabled ? 'ON' : 'OFF'}` }
    })
  },
  'list-tracks': (st) => {
    const tracks = getTimelineTracks(st.project?.timeline)
    if (!tracks.length) return 'No tracks'
    return tracks.map((t, i) => {
      const items = getTrackItems(t)
      const clips = items.map(m => {
        const asset = (st.project?.media || []).find(a => a.id === getTimelineItemAssetId(m))
        return asset?.name || getTimelineItemAssetId(m)
      }).join(', ')
      return { level: 'info', message: `  Track ${i + 1}: ${items.length} clip(s)${clips ? ' — ' + clips : ''}` }
    })
  },
  'list-clips': (st) => {
    const tracks = getTimelineTracks(st.project?.timeline)
    const all = []
    for (const t of tracks) {
      for (const m of getTrackItems(t)) {
        const asset = (st.project?.media || []).find(a => a.id === getTimelineItemAssetId(m))
        const sel = m.id === st.selectedClipId ? ' *' : ''
        all.push({ level: 'info', message: `  ${m.id}  ${asset?.name || '?'}  ${getTimelineItemStart(m).toFixed(2)}s–${(getTimelineItemStart(m) + getTimelineItemDuration(m)).toFixed(2)}s${sel}` })
      }
    }
    return all.length ? all : 'No clips on timeline'
  },

  help: () => {
    return [
      { level: 'info', message: '— Transport —' },
      { level: 'info', message: '  play, pause, stop, seek <s>, rate <x>' },
      { level: 'info', message: '— Project —' },
      { level: 'info', message: '  new, undo, redo' },
      { level: 'info', message: '— Timeline —' },
      { level: 'info', message: '  add-track, remove-clip, remove-media' },
      { level: 'info', message: '— Scene —' },
      { level: 'info', message: '  add-screen [web|renderer] [WxH], remove-screen' },
      { level: 'info', message: '  enable-screen, disable-screen' },
      { level: 'info', message: '  set-resolution <WxH>, set-screen-type web|renderer' },
      { level: 'info', message: '— View —' },
      { level: 'info', message: '  view 2d|3d, overlay, gizmo translate|rotate|scale' },
      { level: 'info', message: '— Info —' },
      { level: 'info', message: '  status, time, list-media, list-screens, list-tracks, list-clips' },
      { level: 'info', message: '— System —' },
      { level: 'info', message: '  clear, help' },
    ]
  },
}

/** Get sorted command names for autocomplete */
export function getCommandNames() {
  return Object.keys(COMMANDS).sort()
}

function findNodeInScene(scene, id) {
  const stack = [...(scene?.roots || [])]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.id === id) return n
    if (n.children?.length) stack.push(...n.children)
  }
  return null
}
