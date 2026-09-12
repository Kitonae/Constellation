import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useEditorStore } from '../store.js'
import { importEntries } from '../utils/importMedia.js'
import useMediaBinView from '../components/mediabin/useMediaBinView.js'
import MediaBin from '../components/MediaBin.jsx'
import { computeRenderList } from '../media/renderer.js'

vi.mock('../components/MediaThumb.jsx', () => ({ default: () => null }))
vi.mock('../hooks/useFileExists.js', () => ({ default: () => true }))
vi.mock('../hooks/useMediaNaturalSize.js', () => ({ default: () => null }))

beforeEach(() => {
  cleanup()
  localStorage.clear()
  useEditorStore.getState().newProject()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/model-import')
})

afterEach(() => vi.restoreAllMocks())

describe('model import and placement', () => {
  it('recognizes an OBJ imported from a browser File', async () => {
    const file = new File(['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'], 'stage.obj')
    const { added, skipped } = await importEntries([{ file }])
    expect(added).toHaveLength(1)
    expect(skipped).toEqual([])
    const { result } = renderHook(() => useMediaBinView(useEditorStore.getState().project.media, { kinds: ['model'] }))
    expect(result.current).toHaveLength(1)
    expect(result.current[0]._kind).toBe('model')
  })

  it('adds a GLB as a visible timeline source from the bin action', async () => {
    await importEntries([{ path: 'C:\\models\\statue.glb' }])
    render(<MediaBin />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert at playhead' }))
    const { project, scene } = useEditorStore.getState()
    const items = computeRenderList(project.timeline, project.media, 0)
    expect(items).toHaveLength(1)
    expect(items[0].mediaType).toBe('model')
    expect(items[0].clip.duration).toBe(10)
    expect(computeRenderList(project.timeline, project.media, 11)).toEqual([])
    expect(scene.roots.some((node) => node.kind?.type === 'model')).toBe(false)
  })

  it('retains the browser model format after renaming and timeline placement', async () => {
    await importEntries([{ file: new File([''], 'stage.obj') }])
    const asset = useEditorStore.getState().project.media[0]
    useEditorStore.getState().renameMedia(asset.id, 'Main stage')
    render(<MediaBin />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert at playhead' }))
    const { project } = useEditorStore.getState()
    const [model] = computeRenderList(project.timeline, project.media, 0)
    expect(model.asset.name).toBe('Main stage')
    expect(model.mediaType).toBe('model')
    expect(model.asset.format).toBe('obj')
  })

  it('places an older zero-duration model with a usable duration', () => {
    const st = useEditorStore.getState()
    st.addMediaClip({ id: 'old-model', name: 'statue.glb', uri: 'file:///C:/statue.glb', duration_seconds: 0 })
    st.addClipToTimeline({ clipId: 'old-model', startAt: 5 })
    const { project } = useEditorStore.getState()
    expect(computeRenderList(project.timeline, project.media, 6)).toHaveLength(1)
  })
})
