import React, { useMemo, useRef, useEffect, Suspense } from 'react'
import { Canvas, useLoader, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import * as THREE from 'three'
import { useEditorStore } from '../../store.js'

function resolveModelUrl(uri) {
  if (!uri) return null
  const u = String(uri)
  if (u.startsWith('file://')) {
    try {
      const url = new URL(u)
      let p = decodeURI(url.pathname)
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
      const port = useEditorStore.getState()._fileServerPort
      if (port) return `http://localhost:${port}/fs/${p}`
      return null
    } catch { return null }
  }
  if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('blob:') || u.startsWith('data:')) return u
  return u
}

function GltfModel({ url, onLoaded }) {
  const { scene } = useGLTF(url)
  const cloned = useMemo(() => scene.clone(true), [scene])
  useEffect(() => { if (cloned) onLoaded?.(cloned) }, [cloned])
  return <primitive object={cloned} />
}

function ObjModel({ url, onLoaded }) {
  const obj = useLoader(OBJLoader, url)
  const cloned = useMemo(() => obj.clone(true), [obj])
  useEffect(() => { if (cloned) onLoaded?.(cloned) }, [cloned])
  return <primitive object={cloned} />
}

/** Loads a model and auto-frames the camera to fit it */
function AutoFramedModel({ uri }) {
  const { camera, invalidate } = useThree()
  const groupRef = useRef()

  const url = resolveModelUrl(uri)
  const ext = useMemo(() => {
    if (!uri) return ''
    const parts = String(uri).split('.')
    return (parts[parts.length - 1] || '').toLowerCase().split('?')[0]
  }, [uri])

  const frameModel = (obj) => {
    if (!obj) return
    const box = new THREE.Box3().setFromObject(obj)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    if (maxDim < 1e-6) return

    // Center the model at origin
    if (groupRef.current) {
      groupRef.current.position.set(-center.x, -center.y, -center.z)
    }

    // Position camera to fit the model
    const dist = maxDim * 1.8
    camera.position.set(dist * 0.6, dist * 0.4, dist * 0.8)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }

  if (!url) {
    return (
      <mesh>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial color="#a78bfa" wireframe />
      </mesh>
    )
  }

  return (
    <group ref={groupRef}>
      {ext === 'obj'
        ? <ObjModel url={url} onLoaded={frameModel} />
        : <GltfModel url={url} onLoaded={frameModel} />
      }
    </group>
  )
}

function TransparentBackground() {
  const { gl, scene } = useThree()
  useEffect(() => {
    gl.setClearColor(0x000000, 0)
    scene.background = null
  }, [gl, scene])
  return null
}

function Fallback() {
  return (
    <mesh rotation={[0, 0, 0]}>
      <boxGeometry args={[0.5, 0.5, 0.5]} />
      <meshStandardMaterial color="#a78bfa" wireframe />
    </mesh>
  )
}

/**
 * Inline 3D model preview rendered via a small Three.js canvas.
 * Used in the 2D viewport to show live model previews.
 */
export function ModelPreview({ uri, size }) {
  const px = Math.max(40, Math.round(size))
  return (
    <Canvas
      camera={{ position: [2, 1.5, 3], fov: 45 }}
      style={{ width: px, height: px, pointerEvents: 'none', display: 'block' }}
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 2]}
      frameloop="demand"
    >
      <TransparentBackground />
      <ambientLight intensity={0.3} />
      <directionalLight position={[3, 5, 4]} intensity={0.7} />
      <directionalLight position={[-2, -1, -3]} intensity={0.2} />
      <Suspense fallback={<Fallback />}>
        <AutoFramedModel uri={uri} />
      </Suspense>
    </Canvas>
  )
}
