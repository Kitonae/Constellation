import React, { useEffect, useRef, useState, useMemo, Suspense } from 'react'
import { Canvas, useLoader } from '@react-three/fiber'
import { OrbitControls, TransformControls, Edges, useGLTF } from '@react-three/drei'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { useEditorStore } from '../store.js'
import { resolveUriSync } from '../media/uri.js'
import { extFromUri } from '../media/asset.js'

// media/uri.js is the single resolver; the local copy here decoded the path
// without re-encoding it, so model paths containing spaces never loaded.
const resolveModelUrl = (uri) => resolveUriSync(uri) || null

// The document measures screens in pixels; this stage is in world units. One
// conversion, applied to size and position alike, so a 1920x1080 screen is
// 1.92 by 1.08 units and a screen 500 px to the right sits 0.5 units right.
const PX_PER_UNIT = 1000

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
  const ext = useMemo(() => extFromUri(uri), [uri])

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
    // The plane is the screen's pixel size in world units; the group applies
    // the transform once on top. The geometry used to be built from
    // scale.x/scale.y and then scaled by the same values again, so a scale of
    // two was four times as wide, and pixels were never consulted at all, so
    // every screen was a square.
    const px = node.kind.pixels || [1920, 1080]
    const w = (px[0] > 0 ? px[0] : 1920) / PX_PER_UNIT
    const h = (px[1] > 0 ? px[1] : 1080) / PX_PER_UNIT
    const content = (
      <group ref={group} position={[position.x / PX_PER_UNIT, position.y / PX_PER_UNIT, position.z / PX_PER_UNIT]} quaternion={[rotation.x, rotation.y, rotation.z, rotation.w]} scale={[scale.x, scale.y, scale.z]}>
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
            // Back to the document's pixels, by the same conversion.
            position: { x: obj.position.x * PX_PER_UNIT, y: obj.position.y * PX_PER_UNIT, z: obj.position.z * PX_PER_UNIT },
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
