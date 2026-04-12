import { describe, expect, it } from 'vitest'
import {
  createDefaultProject,
  createImportedMediaAsset,
  createTimelineItemRecord,
  createProjectDocument,
  ensureTimelineRecord,
  findMediaAssetByTimelineItem,
  findTimelineItemById,
  getNonOverlappingTrackItems,
  getMediaDurationSeconds,
  getTimelineItemAssetId,
  getTimelineItemDuration,
  getTimelineItemStart,
  loadProjectDocument,
  normalizeTimeline,
  removeTimelineItemById,
  removeTimelineItemsByAssetId,
  updateTimelineItems,
} from '../project/projectCodec.js'

describe('projectCodec', () => {
  it('loads wrapper documents into normalized runtime state', () => {
    const doc = {
      project: {
        id: 'show-1',
        name: 'Example Show',
        scene: {
          id: 'scene-1',
          name: 'Main Scene',
          roots: [{
            id: 'screen-a',
            name: 'Screen A',
            transform: {
              position: { x: 10, y: 20, z: 0 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              scale: { x: 1, y: 1, z: 1 },
            },
            screen: { pixels_x: 1920, pixels_y: 1080, enabled: true },
          }],
        },
        media: [
          { id: 'clip-1', name: 'Image 1', uri: 'file:///C:/show/image.png', duration_seconds: 10 },
          { id: 'clip-2', name: 'Video 1', uri: 'file:///C:/show/video.mp4', duration_seconds: 12.5 },
        ],
        timeline: {
          id: 'timeline-1',
          name: 'Timeline',
          duration_seconds: 15,
          events: [{ id: 'marker-1', time: 1.5 }],
          tracks: [{
            media: [{
              id: 'timeline-item-1',
              clip_id: 'clip-2',
              start_at_seconds: 3,
              in_seconds: 1,
              out_seconds: 9,
              position: { x: 100, y: -50 },
              scale: { x: 640, y: 360 },
              opacity: 0.5,
              fade_in: 1,
              fade_out: 2,
              effects: { brightness: { value: 1.25, enabled: true } },
            }],
          }],
        },
      },
    }

    const project = loadProjectDocument(doc)

    expect(project.id).toBe('show-1')
    expect(project.scene.roots[0].kind).toEqual({
      type: 'screen',
      screenType: 'web',
      pixels: [1920, 1080],
      enabled: true,
    })
    expect(project.timeline.duration_seconds).toBe(15)
    expect(project.timeline.events).toEqual([{ id: 'marker-1', time: 1.5 }])
    expect(project.timeline.tracks[0].media[0]).toMatchObject({
      id: 'timeline-item-1',
      clip_id: 'clip-2',
      start: 3,
      start_at_seconds: 3,
      duration: 8,
      in_seconds: 1,
      out_seconds: 9,
      position: { x: 100, y: -50 },
      scale: { x: 640, y: 360 },
      opacity: 0.5,
      fade_in: 1,
      fade_out: 2,
    })
    expect(project.timeline.tracks[0].media[0].effects).toEqual({
      brightness: { value: 1.25, enabled: true },
    })
  })

  it('exports normalized projects back to a legacy-compatible wrapper', () => {
    const project = {
      id: 'show-2',
      name: 'Round Trip',
      scene: {
        id: 'scene-2',
        name: 'Scene Two',
        materials: [],
        meshes: [],
        roots: [{
          id: 'screen-b',
          name: 'Screen B',
          transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
          },
          children: [],
          kind: { type: 'screen', screenType: 'renderer', pixels: [1280, 720], enabled: false },
        }],
      },
      media: [
        { id: 'asset-video', type: 'video', name: 'Video', uri: 'file:///C:/show/video.mp4', duration: 9.25 },
      ],
      timeline: {
        id: 'timeline-2',
        name: 'Timeline',
        duration: 11,
        markers: [{ id: 'marker-2', time: 2 }],
        tracks: [{
          id: 'track-1',
          clips: [{
            id: 'clip-placement-1',
            assetId: 'asset-video',
            sourceIn: 1.5,
            sourceOut: 6.5,
            start: 2.25,
            duration: 5,
            transform: { x: 10, y: 20, width: 1920, height: 1080, rotation: 0 },
            opacity: 0.75,
            fadeIn: 0.25,
            fadeOut: 0.5,
            effects: [{ type: 'blur', value: 4, enabled: true }],
          }],
        }],
      },
    }

    const wrapper = createProjectDocument(project)

    expect(wrapper.project.media[0]).toMatchObject({
      id: 'asset-video',
      duration_seconds: 9.25,
      duration: 9.25,
    })
    expect(wrapper.project.timeline).toMatchObject({
      duration_seconds: 11,
      events: [{ id: 'marker-2', time: 2 }],
    })
    expect(wrapper.project.timeline.tracks[0].media[0]).toMatchObject({
      id: 'clip-placement-1',
      clip_id: 'asset-video',
      in_seconds: 1.5,
      out_seconds: 6.5,
      start: 2.25,
      start_at_seconds: 2.25,
      duration: 5,
      position: { x: 10, y: 20 },
      scale: { x: 1920, y: 1080 },
      opacity: 0.75,
      fade_in: 0.25,
      fade_out: 0.5,
      effects: { blur: { value: 4, enabled: true } },
    })
  })

  it('preserves explicit shorter timeline durations while defaulting empty timelines to 60 seconds', () => {
    expect(normalizeTimeline({ id: 't1', name: 'Short', duration_seconds: 12, tracks: [{ media: [] }] }).duration_seconds).toBe(12)
    expect(createDefaultProject().timeline.duration_seconds).toBe(60)
  })

  it('derives display durations for runtime media rows', () => {
    expect(getMediaDurationSeconds({ id: 'video-1', type: 'video', uri: 'file:///video.mp4', duration: 8.5 })).toBe(8.5)
    expect(getMediaDurationSeconds({ id: 'image-1', type: 'image', uri: 'file:///image.png' })).toBe(10)
    expect(getMediaDurationSeconds({ id: 'model-1', name: 'model.glb', uri: 'file:///model.glb' })).toBe(0)
  })

  it('creates imported assets and timeline item records through codec helpers', () => {
    const asset = createImportedMediaAsset({ id: 'clip-3', name: 'Photo', uri: 'file:///C:/show/photo.png', durationSeconds: 10 })
    const item = createTimelineItemRecord({
      id: 'timeline-item-3',
      assetId: asset.id,
      startAt: 4.5,
      duration: 6,
      position: { x: 12, y: -8 },
      scale: { x: 300, y: 200 },
      fadeIn: 0.5,
      fadeOut: 1,
    })

    expect(asset).toMatchObject({ id: 'clip-3', duration_seconds: 10 })
    expect(item).toMatchObject({
      id: 'timeline-item-3',
      clip_id: 'clip-3',
      start: 4.5,
      start_at_seconds: 4.5,
      duration: 6,
      position: { x: 12, y: -8 },
      scale: { x: 300, y: 200 },
      fade_in: 0.5,
      fade_out: 1,
    })
    expect(getTimelineItemAssetId(item)).toBe('clip-3')
    expect(getTimelineItemStart(item)).toBe(4.5)
    expect(getTimelineItemDuration(item)).toBe(6)
  })

  it('finds timeline items, linked assets, and non-overlapping track items', () => {
    const project = loadProjectDocument({
      project: {
        id: 'show-3',
        name: 'Finders',
        scene: { id: 'scene-3', name: 'Scene', roots: [] },
        media: [
          { id: 'asset-a', name: 'Still', uri: 'file:///still.png', duration_seconds: 10 },
          { id: 'asset-b', name: 'Video', uri: 'file:///clip.mp4', duration_seconds: 12 },
        ],
        timeline: {
          id: 'timeline-3',
          name: 'Timeline',
          tracks: [{
            media: [
              { id: 'item-a', clip_id: 'asset-a', start_at_seconds: 0, duration: 5 },
              { id: 'item-b', clip_id: 'asset-b', start_at_seconds: 2, duration: 5 },
              { id: 'item-c', clip_id: 'asset-b', start_at_seconds: 8, duration: 2 },
            ],
          }],
        },
      },
    })

    expect(findTimelineItemById(project.timeline, 'item-c')?.clip_id).toBe('asset-b')
    expect(findMediaAssetByTimelineItem(project, 'item-c')?.name).toBe('Video')
    expect(getNonOverlappingTrackItems(project.timeline.tracks[0]).map((item) => item.id)).toEqual(['item-c'])
  })

  it('updates and removes timeline items through codec mutation helpers', () => {
    const timeline = ensureTimelineRecord({
      id: 'timeline-4',
      name: 'Timeline',
      duration_seconds: 20,
      tracks: [{
        media: [
          { id: 'item-1', clip_id: 'asset-a', start_at_seconds: 1, duration: 3 },
          { id: 'item-2', clip_id: 'asset-b', start_at_seconds: 8, duration: 4 },
        ],
      }],
    })

    const updated = updateTimelineItems(timeline, (item) => {
      if (item.id !== 'item-2') return null
      return { ...item, start_at_seconds: 10, start: 10, duration: 5, out_seconds: 5 }
    })

    expect(findTimelineItemById(updated, 'item-2')).toMatchObject({
      start: 10,
      start_at_seconds: 10,
      duration: 5,
      out_seconds: 5,
    })

    const removedById = removeTimelineItemById(updated, 'item-1')
    expect(findTimelineItemById(removedById, 'item-1')).toBeNull()

    const removedByAsset = removeTimelineItemsByAssetId(updated, 'asset-b')
    expect(findTimelineItemById(removedByAsset, 'item-2')).toBeNull()
  })
})
