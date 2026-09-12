import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorStore, getMediaSession } from '../store.js'
import { createNativeSink } from '../media/sink.js'

const st = () => useEditorStore.getState()

const emptyProject = () => ({
  id: 'p', name: 'P',
  scene: { id: 'scene', name: 'Scene', materials: [], meshes: [], roots: [] },
  media: [],
  timeline: { id: 'tl', name: 'Timeline', tracks: [{ media: [] }], events: [], duration_seconds: 60 },
})

// New and Open used to set the store's displayed time to zero and leave the
// session clock where it was, so the next tick put the old time back and
// every output kept playing the previous show's position.
describe('document replacement resets the transport', () => {
  beforeEach(() => { st().newProject() })

  it('loadProject rewinds a clock that was only scrubbed', () => {
    getMediaSession().seek(42)
    expect(st().time).toBe(42)
    st().loadProject(emptyProject())
    expect(getMediaSession().getTime()).toBe(0)
    expect(st().time).toBe(0)
    expect(st().playing).toBe(false)
  })

  it('newProject stops a playing clock', () => {
    const session = getMediaSession()
    session.play()
    session.seek(7)
    expect(session.getState()).toBe('playing')
    st().newProject()
    expect(session.getState()).not.toBe('playing')
    expect(session.getTime()).toBe(0)
    expect(st().playing).toBe(false)
  })
})

// A native sink attached mid-show gets only the document; the serialised
// form strips time and playing, and the clock events that would have told it
// have already happened. It must be handed the transport state explicitly.
describe('native sink attachment', () => {
  it('sends the position and the playing state with the snapshot', () => {
    const calls = []
    const sink = createNativeSink({
      id: 'n',
      pushSnapshot: (json) => calls.push(['snapshot', json]),
      pushTime: (t) => calls.push(['time', t]),
      pushControl: (c) => calls.push(['control', c]),
      serialize: () => '{"project":{}}',
    })
    sink.onSnapshot({ project: {}, scene: {}, time: 42, playing: true })
    expect(calls).toEqual([
      ['snapshot', '{"project":{}}'],
      ['time', 42],
      ['control', 'play'],
    ])
  })

  it('tells a sink attached while paused to stay paused at the position', () => {
    const calls = []
    const sink = createNativeSink({
      id: 'n2',
      pushSnapshot: () => {},
      pushTime: (t) => calls.push(['time', t]),
      pushControl: (c) => calls.push(['control', c]),
      serialize: () => '{}',
    })
    sink.onSnapshot({ project: {}, scene: {}, time: 3.5, playing: false })
    expect(calls).toEqual([['time', 3.5], ['control', 'pause']])
  })
})
