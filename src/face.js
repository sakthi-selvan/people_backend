import { FACE_THRESHOLD } from './constants.js'
import { getDb } from './store.js'

export function distance(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

export function identifyFace(descriptor, { includeExited = false } = {}) {
  if (!Array.isArray(descriptor) || descriptor.length < 64) return null
  let best = null
  for (const user of getDb().users) {
    if (!Array.isArray(user.faceDescriptor) || (!includeExited && user.status === 'exited')) continue
    const d = distance(descriptor, user.faceDescriptor)
    if (d <= FACE_THRESHOLD && (!best || d < best.distance)) {
      best = { user, distance: d }
    }
  }
  return best
}
