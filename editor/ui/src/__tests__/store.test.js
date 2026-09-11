import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore } from '../store.js'

/** Every timeline item across all tracks, in track order. */
function items() {
  const p = useEditorStore.getState().project
  return (p?.timeline?.tracks ?? []).flatMap((t) => (Array.isArray(t.media) ? t.media : []))
}

function findItem(id) {
  return items().find((m) => m.id === id)
}

function addClip({ startAt = 0, duration = 10 } = {}) {
  const st = useEditorStore.getState()
  st.addMediaClip({ id: 'asset-1', name: 'a.png', uri: 'file:///a.png', duration_seconds: duration })
  return useEditorStore.getState().addClipToTimeline({ clipId: 'asset-1', startAt })
}

describe('store clip actions', () => {
  beforeEach(() => {
    useEditorStore.getState().newProject()
  })

  it('addClipToTimeline returns the timeline item id, not the asset id', () => {
    const id = addClip()
    expect(id).toMatch(/^tl-/)
    expect(findItem(id)).toBeTruthy()
  })

  it('addClipToTimeline returns null for an unknown asset', () => {
    expect(useEditorStore.getState().addClipToTimeline({ clipId: 'nope' })).toBeNull()
  })

  it('lets a clip be moved past the stored timeline duration', () => {
    const id = addClip()
    // The default timeline is 60 s but the ruler renders far past it.
    useEditorStore.getState().updateClipStart({ timelineId: id, startAt: 250 })
    expect(findItem(id).start).toBe(250)
    expect(findItem(id).start_at_seconds).toBe(250)
  })

  it('clamps a negative start to zero', () => {
    const id = addClip()
    useEditorStore.getState().updateClipStart({ timelineId: id, startAt: -5 })
    expect(findItem(id).start).toBe(0)
  })

  it('never writes NaN into the document', () => {
    const id = addClip()
    const st = useEditorStore.getState()
    st.updateClipStart({ timelineId: id, startAt: NaN })
    st.updateClipDuration({ timelineId: id, duration: NaN })
    st.updateClipTransform({ timelineId: id, opacity: NaN, fade_in: NaN, fade_out: NaN, blur: NaN })
    const m = findItem(id)
    for (const v of [m.start, m.start_at_seconds, m.duration, m.opacity, m.fade_in, m.fade_out, m.blur]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('moveClip commits a horizontal move and a track change as one undo entry', () => {
    const id = addClip()
    useEditorStore.getState().addTrack()
    const undoBefore = useEditorStore.getState().undoStackSize()

    useEditorStore.getState().moveClip(id, { start: 12, trackIndex: 1 })

    expect(useEditorStore.getState().undoStackSize()).toBe(undoBefore + 1)
    const tracks = useEditorStore.getState().project.timeline.tracks
    expect(tracks[0].media).toHaveLength(0)
    expect(tracks[1].media[0].id).toBe(id)
    expect(tracks[1].media[0].start).toBe(12)
  })

  it('grows the timeline duration to cover the furthest clip', () => {
    const id = addClip({ duration: 10 })
    useEditorStore.getState().updateClipStart({ timelineId: id, startAt: 120 })
    expect(useEditorStore.getState().project.timeline.duration_seconds).toBeGreaterThanOrEqual(130)
  })
})

describe('undo / redo', () => {
  beforeEach(() => {
    useEditorStore.getState().newProject()
  })

  it('restores the document', () => {
    const id = addClip()
    expect(items()).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(items()).toHaveLength(0)
    useEditorStore.getState().redo()
    expect(items()).toHaveLength(1)
    expect(findItem(id)).toBeTruthy()
  })

  it('clears a selection that the restored document no longer contains', () => {
    const id = addClip()
    useEditorStore.getState().setSelectedClip(id)
    expect(useEditorStore.getState().selectedClipId).toBe(id)

    useEditorStore.getState().undo() // the clip is gone again
    expect(useEditorStore.getState().selectedClipId).toBeNull()
    expect(useEditorStore.getState().selectedClipIds).toEqual([])
  })

  it('keeps a selection that survives the restore', () => {
    const id = addClip()
    useEditorStore.getState().updateClipStart({ timelineId: id, startAt: 4 })
    useEditorStore.getState().setSelectedClip(id)

    useEditorStore.getState().undo() // undoes the move, not the insert
    expect(useEditorStore.getState().selectedClipId).toBe(id)
  })
})
