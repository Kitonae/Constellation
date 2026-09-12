import { LoadingManager } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { extFromUri } from '../media/asset.js'
import { getFileServerBase, getFileServerToken, resolveUriSync } from '../media/uri.js'

// A blob URL has no extension. Keep the import's format (or original name)
// available to both the thumbnail and the scene loader.
export function modelFormat(uri, hint = '') {
  return extFromUri(uri) || extFromUri(hint) || hint.toLowerCase()
}

export function configureModelLoader(loader) {
  // glTF resolves buffers and textures relative to the model's directory,
  // dropping its query string. Authorize every local dependency, including
  // textures loaded through <img>, without sending credentials to other hosts.
  loader.manager = new LoadingManager().setURLModifier((url) => {
    const base = getFileServerBase()
    const token = getFileServerToken()
    if (!base || !token) return url
    try {
      const resource = new URL(url)
      const files = new URL(`${base}/fs/`)
      if (resource.origin !== files.origin || !resource.pathname.startsWith(files.pathname)) return url
      resource.searchParams.set('token', token)
      return resource.href
    } catch {
      return url
    }
  })
  return loader
}

export async function loadModel(uri, formatHint = '') {
  const url = resolveUriSync(uri)
  if (!url) throw new Error('Cannot resolve model URL')
  const format = modelFormat(uri, formatHint)
  const loader = configureModelLoader(format === 'obj' ? new OBJLoader() : new GLTFLoader())
  const result = await loader.loadAsync(url)
  return format === 'obj' ? result : result.scene
}
