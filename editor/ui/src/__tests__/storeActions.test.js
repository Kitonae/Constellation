import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore } from '../store.js'
import { selectDirty, selectSelectionSummary, clipInstancesOf } from '../selectors.js'

const st = () => useEditorStore.getState()

/** A project with two tracks and three clips from two assets. */
function seed() {
  st().newProject()
  useEditorStore.setState({
    project: {
      id: 'p', name: 'Test', scene: st().scene,
      media: [
        { id: 'a1', name: 'one.png', uri: 'file:///c:/one.png', duration_seconds: 10 },
        { id: 'a2', name: 'two.mp4', uri: 'file:///c:/two.mp4', duration_seconds: 5 },
      ],
      timeline: {
        id: 'tl', name: 'Timeline', events: [], duration_seconds: 60,
        tracks: [
          { media: [
            { id: 'c1', clip_id: 'a1', start: 0, duration: 2, in_seconds: 0, out_seconds: 2 },
            { id: 'c2', clip_id: 'a1', start: 5, duration: 3, in_seconds: 0, out_seconds: 3 },
          ] },
          { media: [
            { id: 'c3', clip_id: 'a2', start: 1, duration: 4, in_seconds: 0, out_seconds: 4 },
          ] },
        ],
      },
    },
  })
  st().markClean()
  // Undo entries created by seeding are not interesting to these tests.
  useEditorStore.setState({ _undoStack: [], _redoStack: [], _currentLabel: 'Initial State' })
}

const findClip = (id) => {
  for (const t of st().project.timeline.tracks) {
    const m = t.media.find((x) => x.id === id)
    if (m) return m
  }
  return null
}
const trackOf = (id) => st().project.timeline.tracks.findIndex((t) => t.media.some((m) => m.id === id))
const undoDepth = () => st()._undoStack.length

beforeEach(seed)

describe('selection is mutually exclusive', () => {
  // The Inspector used to be able to show a screen's sections and a clip's
  // sections stacked in one column, because nothing cleared the other.
  it('selecting a clip clears the node selection', () => {
    st().setSelected('screen-1')
    st().setSelectedClip('c1')
    expect(st().selectedId).toBeNull()
    expect(st().selectedClipId).toBe('c1')
  })

  it('selecting a node clears clip and media selection', () => {
    st().setSelectedClips(['c1', 'c2'])
    st().setSelectedMedia('a1')
    st().setSelected('screen-1')
    expect(st().selectedClipIds).toEqual([])
    expect(st().selectedMediaId).toBeNull()
  })

  it('clearing one kind leaves the others alone', () => {
    st().setSelected('screen-1')
    st().setSelectedClip(null)
    expect(st().selectedId).toBe('screen-1')
  })

  it('summarises what is selected', () => {
    st().setSelectedClips(['c1', 'c2'])
    const s = selectSelectionSummary(useEditorStore.getState())
    expect(s.kind).toBe('clips')
    expect(s.count).toBe(2)
    expect(s.label).toBe('2 clips selected')
  })

  it('selects every clip in the project', () => {
    st().selectAllClips()
    expect(st().selectedClipIds.sort()).toEqual(['c1', 'c2', 'c3'])
  })

  it('selects every clip on one track', () => {
    st().selectClipsInTrack(0)
    expect(st().selectedClipIds.sort()).toEqual(['c1', 'c2'])
  })
})

describe('batched clip actions produce one undo entry each', () => {
  it('moveClips moves several clips at once', () => {
    st().moveClips([{ id: 'c1', start: 10 }, { id: 'c2', start: 20 }])
    expect(findClip('c1').start).toBe(10)
    expect(findClip('c2').start).toBe(20)
    expect(undoDepth()).toBe(1)
  })

  it('moveClips carries a clip to another track', () => {
    st().moveClips([{ id: 'c1', trackIndex: 1 }])
    expect(trackOf('c1')).toBe(1)
    expect(undoDepth()).toBe(1)
  })

  it('moveClips keeps the legacy start field in sync', () => {
    st().moveClips([{ id: 'c1', start: 7 }])
    expect(findClip('c1').start_at_seconds).toBe(7)
  })

  it('removeClips deletes several and prunes the selection', () => {
    st().setSelectedClips(['c1', 'c2'])
    st().removeClips(['c1', 'c2'])
    expect(findClip('c1')).toBeNull()
    expect(st().selectedClipIds).toEqual([])
    expect(undoDepth()).toBe(1)
  })

  it('updateClipsTransform applies one patch to many clips', () => {
    st().updateClipsTransform(['c1', 'c2'], { opacity: 0.5 }, 'Edit 2 Clips')
    expect(findClip('c1').opacity).toBe(0.5)
    expect(findClip('c2').opacity).toBe(0.5)
    expect(undoDepth()).toBe(1)
    expect(st()._currentLabel).toBe('Edit 2 Clips')
  })

  it('positionDelta nudges rather than setting, so clips keep their spacing', () => {
    st().updateClipsTransform(['c1', 'c3'], { positionDelta: { dx: 10, dy: -5 } }, 'Nudge')
    expect(findClip('c1').position).toEqual({ x: 10, y: -5 })
    expect(findClip('c3').position).toEqual({ x: 10, y: -5 })
  })

  it('duplicateClips places copies after their originals and selects them', () => {
    const ids = st().duplicateClips(['c1'])
    expect(ids).toHaveLength(1)
    const copy = findClip(ids[0])
    expect(copy.start).toBe(2) // original ends at 2
    expect(copy.clip_id).toBe('a1')
    expect(st().selectedClipIds).toEqual(ids)
    expect(undoDepth()).toBe(1)
  })
})

describe('trimClip', () => {
  it('sets start and duration together', () => {
    st().trimClip('c2', { start: 6, duration: 2 })   // c2 started at 5
    const c = findClip('c2')
    expect(c.start).toBe(6)
    expect(c.duration).toBe(2)
    // The left edge moved one second later, so the source in-point did too.
    expect(c.in_seconds).toBe(1)
    expect(c.out_seconds).toBe(3) // in_seconds 1 + duration
    expect(undoDepth()).toBe(1)
  })

  it('never produces a clip shorter than the minimum', () => {
    st().trimClip('c1', { start: 0, duration: 0 })
    expect(findClip('c1').duration).toBeGreaterThan(0)
  })

  it('never moves a clip before zero', () => {
    st().trimClip('c1', { start: -5, duration: 2 })
    expect(findClip('c1').start).toBe(0)
  })

  // Trimming the left edge moves the source in-point with it. It used to keep
  // in_seconds at zero, so the new first frame was still the media's first
  // frame and every frame after it was three seconds early.
  it('moves the source in-point with a left-edge trim', () => {
    st().trimClip('c3', { start: 4, duration: 1 })   // c3 spanned 1..5
    const c = findClip('c3')
    expect(c.start).toBe(4)
    expect(c.in_seconds).toBe(3)
    expect(c.out_seconds).toBe(4)
  })

  it('leaves the in-point alone when only the duration changes', () => {
    st().trimClip('c3', { start: 1, duration: 2 })
    expect(findClip('c3').in_seconds).toBe(0)
    expect(findClip('c3').out_seconds).toBe(2)
  })
})

describe('splitClipAtTime', () => {
  it('cuts a clip in two and advances the right half’s source', () => {
    const newId = st().splitClipAtTime('c3', 3) // c3 spans 1..5
    expect(newId).toBeTruthy()
    const left = findClip('c3')
    const right = findClip(newId)
    expect(left.duration).toBe(2)
    expect(right.start).toBe(3)
    expect(right.duration).toBe(2)
    // The right half continues the same media rather than restarting it.
    expect(right.in_seconds).toBe(2)
    expect(undoDepth()).toBe(1)
  })

  it('puts fades on the outer edges only', () => {
    st().updateClipTransform({ timelineId: 'c3', fade_in: 0.5, fade_out: 0.5 })
    const newId = st().splitClipAtTime('c3', 3)
    expect(findClip('c3').fade_out).toBe(0)
    expect(findClip(newId).fade_in).toBe(0)
    expect(findClip('c3').fade_in).toBe(0.5)
  })

  it('refuses to split outside the clip', () => {
    expect(st().splitClipAtTime('c3', 99)).toBeNull()
    expect(st().splitClipAtTime('c3', 0)).toBeNull()
  })
})

describe('tracks', () => {
  it('renames a track', () => {
    st().renameTrack(0, '  Backdrop  ')
    expect(st().project.timeline.tracks[0].name).toBe('Backdrop')
  })

  it('removes a track and everything on it', () => {
    st().setSelectedClips(['c1', 'c3'])
    st().removeTrack(0)
    expect(st().project.timeline.tracks).toHaveLength(1)
    expect(st().selectedClipIds).toEqual(['c3'])
    expect(undoDepth()).toBe(1)
  })

  it('shifts the selected track index when an earlier track goes', () => {
    st().setSelectedTrackIndex(1)
    st().removeTrack(0)
    expect(st().selectedTrackIndex).toBe(0)
  })

  it('clears the selected track index when that track goes', () => {
    st().setSelectedTrackIndex(0)
    st().removeTrack(0)
    expect(st().selectedTrackIndex).toBeNull()
  })
})

describe('media assets', () => {
  it('counts the timeline instances of an asset', () => {
    expect(clipInstancesOf(st().project, 'a1')).toHaveLength(2)
    expect(clipInstancesOf(st().project, 'a2')).toHaveLength(1)
  })

  it('removing an asset removes its clips and their selection', () => {
    st().setSelectedClips(['c1', 'c3'])
    st().removeMediaClip('a1')
    expect(st().project.media.map((m) => m.id)).toEqual(['a2'])
    expect(findClip('c1')).toBeNull()
    expect(findClip('c3')).not.toBeNull()
    expect(st().selectedClipIds).toEqual(['c3'])
  })

  it('relinking keeps the id so every instance follows', () => {
    st().relinkMedia('a1', { uri: 'file:///c:/moved.png' })
    expect(st().project.media.find((m) => m.id === 'a1').uri).toBe('file:///c:/moved.png')
    expect(clipInstancesOf(st().project, 'a1')).toHaveLength(2)
  })

  it('renames an asset', () => {
    st().renameMedia('a1', 'Backdrop')
    expect(st().project.media.find((m) => m.id === 'a1').name).toBe('Backdrop')
  })

  it('gives a timeline clip its own label', () => {
    st().renameTimelineClip('c1', 'Intro')
    expect(findClip('c1').label).toBe('Intro')
  })
})

describe('undo batching', () => {
  it('collapses many writes into one history entry', () => {
    st().beginUndoBatch('Scrub Opacity')
    for (let i = 1; i <= 5; i++) st().updateClipTransform({ timelineId: 'c1', opacity: i / 10 })
    st().endUndoBatch()
    expect(undoDepth()).toBe(1)
    expect(st()._currentLabel).toBe('Scrub Opacity')
    expect(findClip('c1').opacity).toBeCloseTo(0.5)
  })

  it('cancel restores the document and adds no history', () => {
    const before = findClip('c1').opacity ?? 1
    st().beginUndoBatch('Scrub Opacity')
    st().updateClipTransform({ timelineId: 'c1', opacity: 0.2 })
    st().endUndoBatch({ cancel: true })
    expect(undoDepth()).toBe(0)
    expect(findClip('c1').opacity ?? 1).toBe(before)
  })

  it('adds nothing when the batch changed nothing', () => {
    st().beginUndoBatch('No-op')
    st().endUndoBatch()
    expect(undoDepth()).toBe(0)
  })
})

describe('redoTo', () => {
  it('jumps forward several steps in one commit', () => {
    st().moveClips([{ id: 'c1', start: 1 }])
    st().moveClips([{ id: 'c1', start: 2 }])
    st().moveClips([{ id: 'c1', start: 3 }])
    st().undo(); st().undo(); st().undo()
    expect(findClip('c1').start).toBe(0)
    expect(st()._redoStack).toHaveLength(3)

    st().redoTo(0) // all the way forward
    expect(findClip('c1').start).toBe(3)
    expect(st()._redoStack).toHaveLength(0)
  })

  it('can stop part way', () => {
    st().moveClips([{ id: 'c1', start: 1 }])
    st().moveClips([{ id: 'c1', start: 2 }])
    st().undo(); st().undo()
    st().redoTo(1) // redo only the first of the two
    expect(findClip('c1').start).toBe(1)
    expect(st()._redoStack).toHaveLength(1)
  })
})

describe('dirty tracking', () => {
  it('a fresh project is clean', () => {
    expect(selectDirty(useEditorStore.getState())).toBe(false)
  })

  it('an edit makes it dirty', () => {
    st().moveClips([{ id: 'c1', start: 4 }])
    expect(selectDirty(useEditorStore.getState())).toBe(true)
  })

  // Snapshots are shallow refs, so undoing back to the saved state restores
  // the exact object the clean reference points at.
  it('undoing back to the saved state makes it clean again', () => {
    st().moveClips([{ id: 'c1', start: 4 }])
    st().undo()
    expect(selectDirty(useEditorStore.getState())).toBe(false)
  })

  it('saving marks the current state clean', () => {
    st().moveClips([{ id: 'c1', start: 4 }])
    st().markClean()
    expect(selectDirty(useEditorStore.getState())).toBe(false)
  })
})

describe('undo prunes dangling selections', () => {
  it('drops a media selection whose asset is gone', () => {
    st().setSelectedMedia('a1')
    st().removeMediaClip('a1')
    expect(st().selectedMediaId).toBeNull()
    // And it does not come back pointing at nothing after a redo round-trip.
    st().undo()
    st().redo()
    expect(st().selectedMediaId).toBeNull()
  })

  it('drops clip selections that no longer exist', () => {
    st().removeClips(['c1'])
    useEditorStore.setState({ selectedClipIds: ['c1'], selectedClipId: 'c1' })
    st().undo()
    st().redo()
    expect(st().selectedClipIds).not.toContain('c1')
  })
})
