// Offscreen 3D model thumbnail generator.
//
// Uses a single shared Three.js WebGLRenderer to render model previews.
// Loads GLTF/GLB/OBJ, auto-frames with bounding box, renders to canvas,
// returns a data URL. Results are cached by URI.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { resolveUriSync } from '../media/uri.js'
import { extFromUri } from '../media/asset.js'

const THUMB_SIZE = 256
const _cache = new Map() // uri → dataUrl
const _pending = new Map() // uri → Promise<dataUrl>

// Shared renderer (created lazily)
let _renderer = null
let _scene = null
let _camera = null

function getRenderer() {
  if (!_renderer) {
    _renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    _renderer.setSize(THUMB_SIZE, THUMB_SIZE)
    _renderer.setPixelRatio(1)
    _renderer.setClearColor(0x000000, 0)
    _renderer.outputColorSpace = THREE.SRGBColorSpace
    _renderer.toneMapping = THREE.ACESFilmicToneMapping
    _renderer.toneMappingExposure = 1.2

    _scene = new THREE.Scene()

    // Lighting: ambient + two directional for good coverage
    _scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir1 = new THREE.DirectionalLight(0xffffff, 1.0)
    dir1.position.set(5, 8, 5)
    _scene.add(dir1)
    const dir2 = new THREE.DirectionalLight(0x8888ff, 0.4)
    dir2.position.set(-3, 2, -5)
    _scene.add(dir2)

    _camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000)
  }
  return { renderer: _renderer, scene: _scene, camera: _camera }
}

// One resolver for model URLs. The hand-rolled version here decoded the path
// and never re-encoded it, so any model in a folder with a space failed to
// load; media/uri.js already gets this right.
const resolveUrl = (uri) => resolveUriSync(uri) || null

async function loadModel(uri) {
  const url = resolveUrl(uri)
  if (!url) throw new Error('Cannot resolve model URL')

  const ext = extFromUri(uri)

  if (ext === 'obj') {
    const loader = new OBJLoader()
    return new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject)
    })
  }

  // Default: GLTF/GLB
  const loader = new GLTFLoader()
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject)
  })
}

function frameModel(object, camera) {
  // Compute bounding box and position camera to frame it
  const box = new THREE.Box3().setFromObject(object)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)

  if (maxDim === 0) return

  // Center the object
  object.position.sub(center)

  // Position camera
  const fov = camera.fov * (Math.PI / 180)
  const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.5
  camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7)
  camera.lookAt(0, 0, 0)
  camera.near = dist * 0.01
  camera.far = dist * 10
  camera.updateProjectionMatrix()
}

/**
 * Generate a thumbnail for a 3D model.
 * Returns a data URL (PNG). Results are cached.
 *
 * @param {string} uri - model URI (file://, http://, etc.)
 * @returns {Promise<string|null>} data URL or null on failure
 */
export async function generateModelThumbnail(uri) {
  if (!uri) return null

  // Check cache
  if (_cache.has(uri)) return _cache.get(uri)

  // Deduplicate concurrent requests
  if (_pending.has(uri)) return _pending.get(uri)

  const promise = (async () => {
    try {
      const model = await loadModel(uri)
      const { renderer, scene, camera } = getRenderer()

      // Clear previous model from scene (keep lights)
      const toRemove = []
      scene.traverse((child) => {
        if (child.isMesh || child.isGroup) {
          if (!child.isLight && child !== scene) toRemove.push(child)
        }
      })
      // Just remove direct children that aren't lights
      for (let i = scene.children.length - 1; i >= 0; i--) {
        const child = scene.children[i]
        if (!child.isLight) scene.remove(child)
      }

      scene.add(model)
      frameModel(model, camera)

      renderer.render(scene, camera)
      const dataUrl = renderer.domElement.toDataURL('image/png')

      // Cleanup
      scene.remove(model)
      model.traverse((child) => {
        if (child.isMesh) {
          child.geometry?.dispose()
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material]
            mats.forEach(m => { m.map?.dispose(); m.dispose() })
          }
        }
      })

      _cache.set(uri, dataUrl)
      return dataUrl
    } catch (err) {
      console.warn('[ModelThumb] Failed to generate thumbnail:', err)
      _cache.set(uri, null)
      return null
    } finally {
      _pending.delete(uri)
    }
  })()

  _pending.set(uri, promise)
  return promise
}

/**
 * Clear the thumbnail cache (e.g., when a model file changes).
 */
export function clearModelThumbnailCache(uri) {
  if (uri) {
    _cache.delete(uri)
  } else {
    _cache.clear()
  }
}
