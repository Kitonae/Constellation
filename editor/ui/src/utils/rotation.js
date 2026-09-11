/**
 * Quaternion <-> Euler-degrees conversion for the Inspector.
 *
 * The document stores rotations as quaternions (which is what the renderer
 * wants), but nobody can author a rotation by typing four unbounded floats.
 * The Inspector edits degrees and converts here.
 *
 * Caveat the caller must handle: this mapping is not one-to-one. A quaternion
 * re-derived after every write can legitimately come back as a different but
 * equivalent Euler triple (±180 wrap, gimbal coupling near pitch ±90°), which
 * would make the other two fields jump while the user types in the third.
 * `NodeTransformSection` keeps the triple it last wrote and only re-derives
 * when the quaternion changed from somewhere else (gizmo, undo).
 */

import * as THREE from 'three'

const _q = new THREE.Quaternion()
const _e = new THREE.Euler()

const RAD2DEG = 180 / Math.PI
const DEG2RAD = Math.PI / 180

/** Wrap to (-180, 180] so fields never show 359.99. */
function wrapDeg(d) {
  let x = d % 360
  if (x > 180) x -= 360
  if (x <= -180) x += 360
  // -0 reads badly in a text field.
  return Object.is(x, -0) ? 0 : x
}

/** Quaternion `{x,y,z,w}` to Euler degrees `{x,y,z}`. */
export function quatToEulerDeg(q, order = 'XYZ') {
  const x = Number(q?.x) || 0
  const y = Number(q?.y) || 0
  const z = Number(q?.z) || 0
  const w = Number.isFinite(Number(q?.w)) ? Number(q.w) : 1
  _q.set(x, y, z, w)
  if (_q.lengthSq() === 0) _q.set(0, 0, 0, 1)
  _q.normalize()
  _e.setFromQuaternion(_q, order)
  return {
    x: wrapDeg(_e.x * RAD2DEG),
    y: wrapDeg(_e.y * RAD2DEG),
    z: wrapDeg(_e.z * RAD2DEG),
  }
}

/** Euler degrees `{x,y,z}` to a normalized quaternion `{x,y,z,w}`. */
export function eulerDegToQuat(e, order = 'XYZ') {
  _e.set(
    (Number(e?.x) || 0) * DEG2RAD,
    (Number(e?.y) || 0) * DEG2RAD,
    (Number(e?.z) || 0) * DEG2RAD,
    order,
  )
  _q.setFromEuler(_e).normalize()
  return { x: _q.x, y: _q.y, z: _q.z, w: _q.w }
}

/** Are two quaternions the same within a tolerance? */
export function quatEquals(a, b, eps = 1e-6) {
  if (!a || !b) return false
  return Math.abs((a.x || 0) - (b.x || 0)) < eps
    && Math.abs((a.y || 0) - (b.y || 0)) < eps
    && Math.abs((a.z || 0) - (b.z || 0)) < eps
    && Math.abs((a.w ?? 1) - (b.w ?? 1)) < eps
}
