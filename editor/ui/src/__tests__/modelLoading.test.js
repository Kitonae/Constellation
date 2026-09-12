import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { setFileServerBase } from '../media/uri.js'
import { configureModelLoader, loadModel } from '../utils/modelLoader.js'

afterEach(() => {
  setFileServerBase('', '')
  vi.restoreAllMocks()
})

describe('local glTF dependencies', () => {
  it('authorizes local textures without changing embedded or remote URLs', () => {
    setFileServerBase('http://localhost:1234', 'test-session')
    const loader = configureModelLoader(new GLTFLoader())
    const local = 'http://localhost:1234/fs/C%3A/models/texture%20map.jpg?version=1#image'
    const resolved = new URL(loader.manager.resolveURL(local))
    expect(resolved.searchParams.get('token')).toBe('test-session')
    expect(resolved.searchParams.get('version')).toBe('1')
    expect(resolved.hash).toBe('#image')
    for (const url of ['https://textures.example/texture.jpg', 'http://localhost:12345/fs/map.jpg',
      'http://localhost:1234/other/map.jpg', 'blob:http://localhost:1234/image', 'data:image/png;base64,aA==']) {
      expect(loader.manager.resolveURL(url)).toBe(url)
    }
  })

  it('decodes an OBJ when the browser URL has no file extension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'))
    const scene = await loadModel('blob:http://localhost/model', 'obj')
    expect(scene.children[0].geometry.attributes.position.count).toBe(3)
  })

  it('loads an external mesh through a token-protected file server', async () => {
    const requests = []
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const model = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'mesh.bin', byteLength: positions.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost')
      requests.push({ path: url.pathname, token: url.searchParams.get('token') })
      if (url.searchParams.get('token') !== 'test-session') {
        res.writeHead(401).end('missing or invalid session token')
      } else if (url.pathname.endsWith('/mesh.bin')) {
        res.end(Buffer.from(positions.buffer))
      } else {
        res.setHeader('Content-Type', 'model/gltf+json')
        res.end(JSON.stringify(model))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      setFileServerBase(`http://127.0.0.1:${server.address().port}`, 'test-session')
      const scene = await loadModel('file:///C:/models/stage.gltf')
      expect(scene.children[0].geometry.attributes.position.count).toBe(3)
      expect(requests).toEqual([
        { path: '/fs/C%3A/models/stage.gltf', token: 'test-session' },
        { path: '/fs/C%3A/models/mesh.bin', token: 'test-session' },
      ])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
