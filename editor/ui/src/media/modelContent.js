import * as THREE from 'three'
import { loadModel, modelFormat } from '../utils/modelLoader.js'

// Static model sources have a transparent, square presentation frame. The
// native model renderer uses the same framing, lighting and natural size.
export const MODEL_CONTENT_SIZE = 1024
const cache = new Map()
const pending = new Map()
let renderer

function contentMaterial(source) {
  source.map?.updateMatrix()
  const uv = ['uv', 'uv1', 'uv2', 'uv3'][source.map?.channel || 0] || 'uv'
  return new THREE.ShaderMaterial({
    uniforms: {
      mapTexture: { value: source.map || null },
      hasMap: { value: source.map ? 1 : 0 },
      uvTransform: { value: source.map?.matrix || new THREE.Matrix3() },
      tint: { value: new THREE.Vector4(source.color?.r ?? 1, source.color?.g ?? 1, source.color?.b ?? 1, source.opacity ?? 1) },
      cutoff: { value: source.alphaTest || 0.001 },
      alphaMode: { value: source.transparent ? 2 : source.alphaTest > 0 ? 1 : 0 },
    },
    vertexColors: !!source.vertexColors,
    side: THREE.DoubleSide,
    transparent: true,
    forceSinglePass: true,
    vertexShader: `
      uniform mat3 uvTransform;
      varying vec2 texCoord;
      varying vec3 surfaceNormal;
      varying vec4 vertexColor;
      void main() {
        texCoord = (uvTransform * vec3(${uv}, 1.0)).xy;
        surfaceNormal = normalMatrix * normal;
        vertexColor = vec4(1.0);
        #if defined(USE_COLOR) || defined(USE_COLOR_ALPHA)
          vertexColor.rgb = color.rgb;
        #endif
        #ifdef USE_COLOR_ALPHA
          vertexColor.a = color.a;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D mapTexture;
      uniform float hasMap;
      uniform vec4 tint;
      uniform float cutoff;
      uniform float alphaMode;
      varying vec2 texCoord;
      varying vec3 surfaceNormal;
      varying vec4 vertexColor;
      void main() {
        vec4 base = tint * vertexColor;
        if (hasMap > 0.5) base *= texture2D(mapTexture, texCoord);
        if (alphaMode < 0.5) base.a = 1.0;
        if (base.a < cutoff) discard;
        if (alphaMode < 1.5) base.a = 1.0;
        vec3 n = dot(surfaceNormal, surfaceNormal) > 1e-12 ? normalize(surfaceNormal) : vec3(0.0, 0.0, 1.0);
        float light = 0.4 + 0.6 * abs(dot(n, normalize(vec3(3.0, 4.0, 5.0))));
        gl_FragColor = vec4(base.rgb * light, base.a);
        #include <colorspace_fragment>
      }`,
  })
}

/** Render geometry, independently of the small media-bin thumbnail cache. */
export function getModelContent(uri, hint = '') {
  const key = `${uri}\n${modelFormat(uri, hint)}`
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (pending.has(key)) return pending.get(key)
  const job = (async () => {
    const model = await loadModel(uri, hint)
    const materials = new Set()
    const textures = new Set()
    try {
      if (!renderer) {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })
        renderer.setSize(MODEL_CONTENT_SIZE, MODEL_CONTENT_SIZE)
        renderer.setPixelRatio(1)
        renderer.setClearColor(0, 0)
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.sortObjects = false
      }
      model.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(model)
      const size = bounds.getSize(new THREE.Vector3())
      const extent = Math.max(size.x, size.y, size.z)
      if (!(extent > 0) || !Number.isFinite(extent)) throw new Error('Model has no visible geometry')
      model.traverse((child) => {
        if (!child.isMesh) return
        if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals()
        const convert = (material) => {
          materials.add(material)
          for (const value of Object.values(material)) if (value?.isTexture) textures.add(value)
          const next = contentMaterial(material)
          materials.add(next)
          return next
        }
        child.material = Array.isArray(child.material) ? child.material.map(convert) : convert(child.material)
      })
      const scene = new THREE.Scene()
      const frame = new THREE.Group()
      const center = bounds.getCenter(new THREE.Vector3())
      frame.scale.setScalar(1.8 / extent)
      frame.position.copy(center).multiplyScalar(-1.8 / extent)
      frame.add(model)
      scene.add(frame)
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
      camera.position.z = 4
      renderer.render(scene, camera)
      const result = { src: renderer.domElement.toDataURL('image/png'), w: MODEL_CONTENT_SIZE, h: MODEL_CONTENT_SIZE }
      cache.set(key, result)
      if (cache.size > 16) cache.delete(cache.keys().next().value)
      return result
    } finally {
      model.traverse((child) => child.geometry?.dispose())
      materials.forEach((material) => material.dispose())
      textures.forEach((texture) => texture.dispose())
    }
  })().finally(() => pending.delete(key))
  pending.set(key, job)
  return job
}
