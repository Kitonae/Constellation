import React, { useEffect, useRef, useState, useMemo, Suspense } from 'react'
import { Canvas, useLoader } from '@react-three/fiber'
import { OrbitControls, TransformControls, Edges, useGLTF } from '@react-three/drei'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { useEditorStore } from '../store.js'

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

function GltfModel({ url }) {
  const { scene } = useGLTF(url)
  const cloned = useMemo(() => scene.clone(true), [scene])
  return <primitive object={cloned} />
}

function ObjModel({ url }) {
  const obj = useLoader(OBJLoader, url)
  const cloned = useMemo(() => obj.clone(true), [obj])
  return <primitive object={cloned} />
}

function ModelMesh({ uri }) {
  const url = resolveModelUrl(uri)
  const ext = useMemo(() => {
    if (!uri) return ''
    const parts = String(uri).split('.')
    return (parts[parts.length - 1] || '').toLowerCase().split('?')[0]
  }, [uri])

  if (!url) return <mesh><boxGeometry args={[0.5, 0.5, 0.5]} /><meshStandardMaterial color="#a78bfa" wireframe /></mesh>

  if (ext === 'obj') return <ObjModel url={url} />
  return <GltfModel url={url} />
}

function StageNode({ node, selectedId, gizmoMode, onSelect, onTransform }) {
  const group = useRef()
  useEffect(() => {
    if (!group.current) return
  }, [])

  const { position, rotation, scale } = node.transform
  const children = (node.children ?? []).map((c) => (
    <StageNode key={c.id} node={c} selectedId={selectedId} gizmoMode={gizmoMode} onSelect={onSelect} onTransform={onTransform} />
  ))

  const isSelected = node.id === selectedId

  if (node.kind?.type === 'screen') {
    const w = scale.x
    const h = scale.y
    const content = (
      <group ref={group} position={[position.x, position.y, position.z]} quaternion={[rotation.x, rotation.y, rotation.z, rotation.w]} scale={[scale.x, scale.y, scale.z]}>
        <mesh onPointerDown={(e) => { e.stopPropagation(); onSelect(node.id) }}>
          <planeGeometry args={[w, h]} />
          <meshStandardMaterial color={isSelected ? '#2f3b6a' : '#222'} emissive={isSelected ? '#1a2250' : '#111'} />
          {isSelected && <Edges color="#6aa0ff" />}
        </mesh>
        {children}
      </group>
    )
    if (isSelected) {
      return (
        <TransformControls object={group} mode={gizmoMode} onObjectChange={() => {
          const obj = group.current
          if (!obj) return
          onTransform(node.id, {
            position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
            rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
            scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
          })
        }}>
          {content}
        </TransformControls>
      )
    }
    return content
  }

  if (node.kind?.type === 'light') {
    const c = node.kind.light.color
    const col = [c.r, c.g, c.b]
    if (node.kind.light.type === 'SPOT') {
      return (
        <group position={[position.x, position.y, position.z]}>
          <spotLight args={[col, node.kind.light.intensity]} angle={(node.kind.light.spot_angle ?? 30) * Math.PI/180} distance={node.kind.light.range} />
          {children}
        </group>
      )
    }
    return (
      <group position={[position.x, position.y, position.z]}>
        <pointLight args={[col, node.kind.light.intensity, node.kind.light.range]} />
        {children}
      </group>
    )
  }

  if (node.kind?.type === 'model') {
    const content = (
      <group ref={group} position={[position.x, position.y, position.z]} quaternion={[rotation.x, rotation.y, rotation.z, rotation.w]} scale={[scale.x, scale.y, scale.z]}>
        <Suspense fallback={<mesh><boxGeometry args={[0.5, 0.5, 0.5]} /><meshStandardMaterial color="#a78bfa" wireframe /></mesh>}>
          <ModelMesh uri={node.kind.uri} />
        </Suspense>
        {isSelected && (
          <mesh onPointerDown={(e) => { e.stopPropagation(); onSelect(node.id) }}>
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        )}
        {children}
      </group>
    )
    if (isSelected) {
      return (
        <TransformControls object={group} mode={gizmoMode} onObjectChange={() => {
          const obj = group.current
          if (!obj) return
          onTransform(node.id, {
            position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
            rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
            scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
          })
        }}>
          {content}
        </TransformControls>
      )
    }
    // Make model clickable for selection when not selected
    return (
      <group
        ref={group}
        position={[position.x, position.y, position.z]}
        quaternion={[rotation.x, rotation.y, rotation.z, rotation.w]}
        scale={[scale.x, scale.y, scale.z]}
        onPointerDown={(e) => { e.stopPropagation(); onSelect(node.id) }}
      >
        <Suspense fallback={<mesh><boxGeometry args={[0.5, 0.5, 0.5]} /><meshStandardMaterial color="#a78bfa" wireframe /></mesh>}>
          <ModelMesh uri={node.kind.uri} />
        </Suspense>
        {children}
      </group>
    )
  }

  // default empty container
  const content = (
    <group ref={group} position={[position.x, position.y, position.z]} quaternion={[rotation.x, rotation.y, rotation.z, rotation.w]} scale={[scale.x, scale.y, scale.z]}>
      {children}
    </group>
  )
  if (isSelected) {
    return (
      <TransformControls object={group} mode={gizmoMode} onObjectChange={() => {
        const obj = group.current
        if (!obj) return
        onTransform(node.id, {
          position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
          rotation: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
          scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
        })
      }}>
        {content}
      </TransformControls>
    )
  }
  return content
}

export default function Viewport() {
  const scene = useEditorStore((s) => s.scene)
  const selectedId = useEditorStore((s) => s.selectedId)
  const gizmoMode = useEditorStore((s) => s.gizmoMode)
  const setSelected = useEditorStore((s) => s.setSelected)
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)

  return (
    <Canvas camera={{ position: [6, 4, 10], fov: 45 }}>
      <color attach="background" args={[0.05, 0.06, 0.08]} />
      <ambientLight intensity={0.2} />
      <directionalLight position={[5, 10, 5]} intensity={0.6} />
      {scene?.roots?.map((n) => (
        <StageNode key={n.id} node={n} selectedId={selectedId} gizmoMode={gizmoMode} onSelect={setSelected} onTransform={updateNodeTransform} />
      ))}
      <gridHelper args={[50, 50, '#333', '#222']} />
      <OrbitControls makeDefault />
    </Canvas>
  )
}
