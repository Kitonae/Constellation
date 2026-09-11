import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore } from '../store.js'
import { buildProjectWrapper } from '../utils/projectSerialize.js'
import { parseProject } from '../utils/parseProject.js'
import { migrateTimeline } from '../media/timeline.js'
import { computeRenderList } from '../media/renderer.js'

/**
 * Regression tests for the bug where File > Open lost every timeline clip:
 * `parseProject` migrated the document into the new Track/Clip model while
 * every editor consumer still read the legacy `tracks[].media[]` shape, so the
 * clips were orphaned on load.
 */

const legacyProject = {
  project: {
    id: 'p1',
    name: 'Legacy Show',
    scene: {
      id: 'scene',
      name: 'Scene',
      roots: [
        {
          id: 'screen-a',
          name: 'Screen A',
          transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
          children: [],
          kind: { type: 'screen', screenType: 'web', pixels: [1920, 1080], enabled: true },
        },
      ],
    },
    media: [
      { id: 'm1', name: 'clip.mp4', uri: 'file:///C:/media/clip.mp4', duration_seconds: 42 },
    ],
    timeline: {
      id: 'tl',
      name: 'Timeline',
      events: [],
      duration_seconds: 60,
      tracks: [
        {
          media: [
            {
              id: 'tl-1',
              clip_id: 'm1',
              target_node_id: '',
              in_seconds: 0,
              out_seconds: 42,
              start_at_seconds: 5,
              start: 5,
              duration: 42,
              position: { x: 0, y: 0 },
              scale: { x: 0, y: 0 },
              fade_in: 0,
              fade_out: 0,
            },
          ],
        },
      ],
    },
  },
}

describe('parseProject', () => {
  it('keeps the legacy timeline shape the editor reads', () => {
    const parsed = parseProject(legacyProject)
    const track = parsed.timeline.tracks[0]
    expect(Array.isArray(track.media)).toBe(true)
    expect(track.media).toHaveLength(1)
    expect(track.media[0].id).toBe('tl-1')
    expect(parsed.timeline.duration_seconds).toBe(60)
    expect(parsed.media[0].duration_seconds).toBe(42)
  })

  it('preserves the scene screen nodes', () => {
    const parsed = parseProject(legacyProject)
    expect(parsed.scene.roots).toHaveLength(1)
    expect(parsed.scene.roots[0].kind).toEqual({
      type: 'screen', screenType: 'web', pixels: [1920, 1080], enabled: true,
    })
  })
})

describe('save / load round trip', () => {
  beforeEach(() => {
    useEditorStore.getState().newProject()
  })

  it('returns identical tracks after buildProjectWrapper -> loadProject', () => {
    const store = useEditorStore.getState()
    store.addMediaClip({ id: 'm1', name: 'clip.mp4', uri: 'file:///C:/media/clip.mp4', duration_seconds: 42 })
    const itemId = useEditorStore.getState().addClipToTimeline({ clipId: 'm1', startAt: 3 })
    expect(itemId).toBeTruthy()

    const before = useEditorStore.getState().project
    const wrapper = buildProjectWrapper(before, useEditorStore.getState().scene)

    // Round trip through JSON the way Save Show / Open Show does
    useEditorStore.getState().loadProject(JSON.parse(JSON.stringify(wrapper)))
    const after = useEditorStore.getState().project

    expect(after.timeline.tracks).toEqual(before.timeline.tracks)
    expect(after.media).toEqual(before.media)
    expect(after.timeline.duration_seconds).toBe(before.timeline.duration_seconds)
  })

  it('loads a legacy project with its clips intact', () => {
    useEditorStore.getState().loadProject(legacyProject)
    const p = useEditorStore.getState().project
    const items = p.timeline.tracks.flatMap((t) => t.media)
    expect(items).toHaveLength(1)
    expect(items[0].clip_id).toBe('m1')
    expect(p.media[0].duration_seconds).toBe(42)
  })

  it('renders the loaded clip at a time inside its span', () => {
    useEditorStore.getState().loadProject(legacyProject)
    const p = useEditorStore.getState().project
    const items = computeRenderList(p.timeline, p.media, 10)
    expect(items).toHaveLength(1)
    expect(items[0].assetId).toBe('m1')
  })
})

describe('migrateTimeline', () => {
  it('is idempotent', () => {
    const once = migrateTimeline(legacyProject.project.timeline)
    const twice = migrateTimeline(once)
    expect(twice).toEqual(once)
  })

  it('produces one clip per legacy timeline item', () => {
    const migrated = migrateTimeline(legacyProject.project.timeline)
    expect(migrated.tracks[0].clips).toHaveLength(1)
    expect(migrated.tracks[0].clips[0].assetId).toBe('m1')
  })
})
