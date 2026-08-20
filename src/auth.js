import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDb, publicUser } from './store.js'

const secret = process.env.JWT_SECRET || 'people-dev-secret-change-me'

export async function hashPassword(password) {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password, hash) {
  if (!password || !hash) return false
  return bcrypt.compare(password, hash)
}

export function signToken(payload) {
  return jwt.sign(payload, secret, { expiresIn: '12h' })
}

export function readToken(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  try {
    return jwt.verify(token, secret)
  } catch {
    return null
  }
}

export function requireAuth(roles) {
  return (req, res, next) => {
    const payload = readToken(req)
    if (!payload) {
      res.status(401).json({ error: 'Sign in required' })
      return
    }
    if (roles?.length && !roles.includes(payload.role)) {
      const asHr = payload.role === 'admin' || payload.role === 'manager' ? 'hr' : payload.role
      if (!roles.includes(asHr)) {
        res.status(403).json({ error: 'Not allowed' })
        return
      }
      req.actor = { ...payload, role: asHr }
      next()
      return
    }
    req.actor = {
      ...payload,
      role: payload.role === 'admin' || payload.role === 'manager' ? 'hr' : payload.role,
    }
    next()
  }
}

export function actorUser(req) {
  if (!req.actor?.sub || req.actor.role === 'device') return null
  return getDb().users.find((u) => u.id === req.actor.sub) || null
}

export function sessionPayload(user) {
  const role = user.role === 'admin' || user.role === 'manager' ? 'hr' : user.role
  return { user: { ...publicUser(user), role }, token: signToken({ sub: user.id, role }) }
}

export function deviceSession(device) {
  return {
    device: { id: device.id, name: device.name, location: device.location },
    token: signToken({ sub: device.id, role: 'device', device: true }),
  }
}
