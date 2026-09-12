import { describe, it, expect, vi } from 'vitest'
import { createDocumentSync, documentFromEvent } from '../document/documentSync.js'
import { parseProject } from '../utils/parseProject.js'
import { buildProjectWrapper } from '../utils/projectSerialize.js'
import { selectDirty } from '../selectors.js'

const stubApi = (overrides = {}) => {
  const calls = []
  const state = (patch = {}) => ({ path: 'C:/shows/a.json', fileName: 'a.json', name: 'A', dirty: false, version: 1, ...patch })
  return {
    calls,
    state,
    api: {
      update: (contents) => { calls.push(['update', contents]); return Promise.resolve(state({ dirty: true })) },
      newShow: () => { calls.push(['newShow']); return Promise.resolve({ state: state({ path: '', fileName: '' }), contents: '{"project":{}}' }) },
      open: () => { calls.push(['open']); return Promise.resolve({ state: state(), contents: '{"project":{}}' }) },
      openPath: (p) => { calls.push(['openPath', p]); return Promise.resolve({ state: state(), contents: '{"project":{}}' }) },
      save: () => { calls.push(['save']); return Promise.resolve({ state: state(), cancelled: false }) },
      saveAs: () => { calls.push(['saveAs']); return Promise.resolve({ state: state(), cancelled: false }) },
      state: () => { calls.push(['state']); return Promise.resolve(state()) },
      contents: () => { calls.push(['contents']); return Promise.resolve('{"project":{}}') },
      recent: () => { calls.push(['recent']); return Promise.resolve(['C:/shows/a.json']) },
      ...overrides,
    },
  }
}

describe('document sync', () => {
  it('coalesces a burst of edits into one send', async () => {
    vi.useFakeTimers()
    try {
      const { calls, api } = stubApi()
      let n = 0
      const sync = createDocumentSync({
        native: true, api,
        serialize: () => `{"project":{"n":${++n}}}`,
        onState: () => { },
      })

      sync.schedule()
      sync.schedule()
      sync.schedule()
      await vi.advanceTimersByTimeAsync(200)

      const updates = calls.filter(([kind]) => kind === 'update')
      expect(updates).toHaveLength(1)
      sync.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send a document that has not changed', async () => {
    const { calls, api } = stubApi()
    const sync = createDocumentSync({
      native: true, api,
      serialize: () => '{"project":{"same":true}}',
      onState: () => { },
    })

    await sync.flush()
    await sync.flush()
    expect(calls.filter(([kind]) => kind === 'update')).toHaveLength(1)
    sync.dispose()
  })

  it('flush sends the pending edit before answering', async () => {
    // Anything that asks "is there unsaved work?" goes through flush. The
    // update is debounced, so a Quit pressed straight after an edit would
    // otherwise be answered from a state recorded before that edit.
    vi.useFakeTimers()
    try {
      const { calls, api } = stubApi()
      const sync = createDocumentSync({
        native: true, api,
        serialize: () => '{"project":{"edited":true}}',
        onState: () => { },
      })

      sync.schedule()
      const state = await sync.flush()
      expect(calls.some(([kind]) => kind === 'update')).toBe(true)
      expect(state.dirty).toBe(true)
      sync.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a document the shell rejects instead of failing quietly', async () => {
    // Silence would turn the next Save into a no-op that writes whatever
    // document last happened to parse.
    const errors = []
    const { api } = stubApi({ update: () => Promise.reject(new Error('invalid document')) })
    const sync = createDocumentSync({
      native: true, api,
      serialize: () => '{"project":{}}',
      onState: () => { },
      onError: (m) => errors.push(m),
    })

    await sync.flush()
    expect(errors.join(' ')).toContain('invalid document')
    sync.dispose()
  })

  it('retries a rejected document on the next change', async () => {
    let attempts = 0
    const { api } = stubApi({
      update: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('nope'))
          : Promise.resolve({ path: '', fileName: '', name: 'A', dirty: true, version: 1 })
      },
    })
    const sync = createDocumentSync({
      native: true, api,
      serialize: () => '{"project":{"same":true}}',
      onState: () => { },
      onError: () => { },
    })

    await sync.flush()
    await sync.flush()
    expect(attempts).toBe(2)
    sync.dispose()
  })

  it('does nothing at all without a shell', async () => {
    const { calls, api } = stubApi()
    const sync = createDocumentSync({
      native: false, api,
      serialize: () => '{"project":{}}',
      onState: () => { },
    })
    sync.schedule()
    expect(await sync.flush()).toBeNull()
    expect(calls).toHaveLength(0)
    expect(sync.native).toBe(false)
  })

  it('reads a payload whether it is bare or wrapped', () => {
    expect(documentFromEvent({ data: { dirty: true } })).toEqual({ dirty: true })
    expect(documentFromEvent({ data: [{ dirty: false }] })).toEqual({ dirty: false })
    expect(documentFromEvent({})).toBeNull()
  })
})

describe('dirty state', () => {
  it('prefers what the shell says over a local reference compare', () => {
    // The shell compares content against what it actually wrote, so undoing
    // back to the saved state reads clean again.
    const project = { id: 'p' }
    const scene = { id: 's' }
    const shellSaysClean = {
      project, scene,
      _cleanRef: { project: {}, scene: {} },
      documentState: { dirty: false },
    }
    expect(selectDirty(shellSaysClean)).toBe(false)

    const shellSaysDirty = {
      project, scene,
      _cleanRef: { project, scene },
      documentState: { dirty: true },
    }
    expect(selectDirty(shellSaysDirty)).toBe(true)
  })

  it('falls back to references when there is no shell', () => {
    const project = { id: 'p' }
    const scene = { id: 's' }
    expect(selectDirty({ project, scene, _cleanRef: { project, scene } })).toBe(false)
    expect(selectDirty({ project, scene, _cleanRef: { project: {}, scene } })).toBe(true)
  })
})

describe('document fidelity', () => {
  // What parseProject returns is what gets saved. Rebuilding each object from
  // named fields dropped whatever this build had no opinion about.
  const richDocument = () => ({
    project: {
      id: 'p', name: 'Show',
      scene: {
        id: 's', name: 'Scene',
        materials: [{ id: 'm1', albedo: [1, 0.5, 0] }],
        meshes: [{ id: 'mesh1', verts: 24 }],
        roots: [
          {
            id: 'scr', name: 'Front', transform: {}, children: [],
            kind: {
              type: 'screen', screenType: 'renderer', pixels: [3840, 2160], enabled: true,
              output: { x: -1920, y: 120, borderless: true },
            },
          },
          { id: 'cam', name: 'Camera', transform: {}, children: [], kind: { type: 'camera', cam: { fov: 55.5 } } },
        ],
      },
      media: [{ id: 'a1', name: 'clip.mp4', uri: 'file:///C:/m/clip.mp4', duration_seconds: 12.5 }],
      timeline: { id: 'tl', name: 'Timeline', events: [], duration_seconds: 60, tracks: [{ media: [] }] },
    },
  })

  it('keeps a screen placement through a round trip', () => {
    // Losing this scattered every output back onto the primary display the
    // next time the show was opened.
    const parsed = parseProject(richDocument())
    const saved = buildProjectWrapper(parsed, parsed.scene)
    const screen = saved.project.scene.roots[0]
    expect(screen.kind.output).toEqual({ x: -1920, y: 120, borderless: true })
  })

  it('keeps scene materials and meshes through a round trip', () => {
    const parsed = parseProject(richDocument())
    const saved = buildProjectWrapper(parsed, parsed.scene)
    expect(saved.project.scene.materials).toHaveLength(1)
    expect(saved.project.scene.meshes).toHaveLength(1)
  })

  it('still normalises the fields every consumer reads', () => {
    const parsed = parseProject({
      project: { scene: { roots: [{ id: 'a', name: 'A', kind: { type: 'screen' } }] } },
    })
    const kind = parsed.scene.roots[0].kind
    expect(kind.screenType).toBe('web')
    expect(kind.enabled).toBe(true)
    expect(kind.pixels).toEqual([0, 0])
  })

  it('converts a legacy screen node and drops the old key', () => {
    const parsed = parseProject({
      project: {
        scene: {
          roots: [{ id: 'a', name: 'A', screen: { screenType: 'renderer', pixels_x: 1920, pixels_y: 1080 } }],
        },
      },
    })
    const node = parsed.scene.roots[0]
    expect(node.kind).toMatchObject({ type: 'screen', screenType: 'renderer', pixels: [1920, 1080], enabled: true })
    expect(node.screen).toBeUndefined()
    expect(node.kind.pixels_x).toBeUndefined()
  })
})
