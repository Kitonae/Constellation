import React, { useRef, useState } from 'react'
import { useEditorStore } from '../../store.js'
import Category from './Category.jsx'
import PropertyRow from './PropertyRow.jsx'
import NumberInput from './NumberInput.jsx'
import { FIELD } from './constants.js'
import { quatToEulerDeg, eulerDegToQuat, quatEquals } from '../../utils/rotation.js'

/**
 * A scene node's raw transform.
 *
 * Rotation is edited in degrees. It is stored as a quaternion, and
 * re-deriving Euler angles from the quaternion after every keystroke would
 * make the other two axes jump around (±180 wrap, gimbal coupling near
 * pitch 90°), so the triple this component last wrote is remembered and only
 * re-derived when the quaternion changed from somewhere else: a gizmo drag,
 * or an undo.
 */
export default function NodeTransformSection({ node }) {
  const updateNodeTransform = useEditorStore((s) => s.updateNodeTransform)
  const t = node.transform
  const lastWritten = useRef(null)
  const [euler, setEuler] = useState(() => quatToEulerDeg(t.rotation))

  const incoming = t.rotation
  if (!lastWritten.current || !quatEquals(incoming, lastWritten.current)) {
    lastWritten.current = incoming
    const derived = quatToEulerDeg(incoming)
    if (derived.x !== euler.x || derived.y !== euler.y || derived.z !== euler.z) {
      setEuler(derived)
    }
  }

  const setRotation = (axis, deg) => {
    const next = { ...euler, [axis]: deg }
    setEuler(next)
    const q = eulerDegToQuat(next)
    lastWritten.current = q
    updateNodeTransform(node.id, { rotation: q }, 'Rotate Screen')
  }

  const setVec = (key, axis, v, label) => {
    updateNodeTransform(node.id, { [key]: { ...t[key], [axis]: v } }, label)
  }

  return (
    <Category title="Node Transform" defaultOpen={false}>
      <PropertyRow label="Position">
        {['x', 'y', 'z'].map((a) => (
          <NumberInput key={a} prefix={a.toUpperCase()} {...FIELD.nodePosition} value={t.position[a]}
            scrubLabel="Move Screen" onChange={(v) => setVec('position', a, v, 'Move Screen')} />
        ))}
      </PropertyRow>
      <PropertyRow label="Scale">
        {['x', 'y', 'z'].map((a) => (
          <NumberInput key={a} prefix={a.toUpperCase()} {...FIELD.nodeScale} value={t.scale[a]}
            scrubLabel="Scale Screen" onChange={(v) => setVec('scale', a, v, 'Scale Screen')} />
        ))}
      </PropertyRow>
      <PropertyRow label="Rotation" hint="Euler angles, applied in XYZ order">
        {['x', 'y', 'z'].map((a) => (
          <NumberInput key={a} prefix={a.toUpperCase()} {...FIELD.nodeRotation} value={euler[a]}
            scrubLabel="Rotate Screen" onChange={(v) => setRotation(a, v)} />
        ))}
      </PropertyRow>
    </Category>
  )
}
