import React, { useEffect, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, TransformControls, Edges } from '@react-three/drei'
import { useEditorStore } from '../store.js'

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
