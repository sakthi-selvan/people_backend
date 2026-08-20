import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import express from 'express'
import cors from 'cors'
import { ATTENDANCE_FLOW, HR_STEPS } from './constants.js'
import {
  deviceSession,
  hashPassword,
  requireAuth,
  sessionPayload,
  verifyPassword,
} from './auth.js'
import { identifyFace } from './face.js'
import { sendMail } from './mailer.js'
import { emailPayslip, getMonthAttendance, overlappingSalaries, payrollInsights, periodOf, periodLabel, processSalary } from './payroll.js'
import { createUser } from './seed.js'
import { getDb, publicUser, saveDb, dataDir } from './store.js'
import { todayKey, punchState, syncAttendanceRow, sessionHours, sessionsOf, SHIFT_HOURS, MAX_SESSIONS } from './util.js'
import { completeStep, getJourney, getTemplates, previewLetter } from './workflow.js'
import { TEMPLATE_KEYS } from './templates.js'
import { saveFacePhoto } from './photos.js'

const app = express()
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
app.use(cors({ origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins }))
app.use(express.json({ limit: '8mb' }))
app.use('/uploads', express.static(join(dataDir, 'uploads')))

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/api/meta', (_req, res) => {
  res.json({ steps: HR_STEPS, attendanceFlow: ATTENDANCE_FLOW, templates: TEMPLATE_KEYS })
})

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = getDb().users.find((u) => u.email === email)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' })
    return
  }
  res.json(sessionPayload(user))
})

app.post('/api/auth/device', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const password = String(req.body?.password || '')
  const device = getDb().devices.find((d) => d.name.toLowerCase() === name.toLowerCase())
  if (!device || !(await verifyPassword(password, device.passwordHash))) {
    res.status(401).json({ error: 'Invalid device name or password' })
    return
  }
  res.json(deviceSession(device))
})

app.get('/api/auth/me', requireAuth(), (req, res) => {
  const db = getDb()
  if (req.actor.role === 'device') {
    const device = db.devices.find((d) => d.id === req.actor.sub)
    res.json({ role: 'device', device: device ? { id: device.id, name: device.name, location: device.location } : null })
    return
  }
  res.json({ role: req.actor.role, user: publicUser(db.users.find((u) => u.id === req.actor.sub)) })
})

app.get('/api/users', requireAuth(['admin', 'hr', 'manager']), (req, res) => {
  let users = getDb().users.map(publicUser)
  if (req.actor.role === 'manager') {
    users = users.filter((u) => u.managerId === req.actor.sub || u.id === req.actor.sub)
  }
  res.json(users)
})

app.post('/api/users', requireAuth(['admin', 'hr']), async (req, res) => {
  const { name, email, role, password, department, managerId, baseSalary, hrStep } = req.body || {}
  if (!name || !email) {
    res.status(400).json({ error: 'Name and email are required' })
    return
  }
  if (getDb().users.some((u) => u.email === String(email).toLowerCase())) {
    res.status(409).json({ error: 'Email already exists' })
    return
  }
  const allowedRoles = ['hr', 'employee']
  const nextRole = allowedRoles.includes(role) ? role : 'employee'
  const passwordHash = password ? await hashPassword(password) : await hashPassword('Welcome@123')
  const startStep = nextRole === 'employee' ? 0 : 7
  const user = createUser({
    name,
    email,
    role: nextRole,
    department,
    managerId,
    baseSalary,
    hrStep: Number.isFinite(hrStep) ? hrStep : startStep,
    passwordHash,
    status: nextRole === 'employee' ? 'offer' : 'active',
  })
  res.status(201).json(publicUser(user))
})

app.patch('/api/users/:id', requireAuth(['admin', 'hr', 'manager', 'employee']), async (req, res) => {
  const db = getDb()
  const user = db.users.find((u) => u.id === req.params.id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  const self = req.actor.sub === user.id
  if (!self && !['admin', 'hr'].includes(req.actor.role) && !(req.actor.role === 'manager' && user.managerId === req.actor.sub)) {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  const body = req.body || {}
  if (typeof body.name === 'string' && body.name.trim()) user.name = body.name.trim()
  if (typeof body.phone === 'string') user.phone = body.phone.trim()
  if (typeof body.email === 'string' && (self || ['admin', 'hr'].includes(req.actor.role))) {
    const email = body.email.trim().toLowerCase()
    if (!email) {
      res.status(400).json({ error: 'Email is required' })
      return
    }
    if (getDb().users.some((u) => u.email === email && u.id !== user.id)) {
      res.status(409).json({ error: 'Email already exists' })
      return
    }
    user.email = email
  }
  if (typeof body.department === 'string' && ['admin', 'hr'].includes(req.actor.role)) user.department = body.department
  if (typeof body.baseSalary === 'number' && ['admin', 'hr'].includes(req.actor.role)) user.baseSalary = body.baseSalary
  if (body.shiftId && ['admin', 'hr'].includes(req.actor.role)) user.shiftId = body.shiftId
  saveDb()
  res.json(publicUser(user))
})

app.post('/api/auth/password', requireAuth(['admin', 'hr', 'manager', 'employee']), async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' })
    return
  }
  const user = getDb().users.find((u) => u.id === req.actor.sub)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    res.status(401).json({ error: 'Current password is incorrect' })
    return
  }
  user.passwordHash = await hashPassword(newPassword)
  saveDb()
  res.json({ ok: true })
})

app.post('/api/users/:id/reset-password', requireAuth(['hr']), async (req, res) => {
  const password = String(req.body?.password || '')
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' })
    return
  }
  const user = getDb().users.find((u) => u.id === req.params.id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  user.passwordHash = await hashPassword(password)
  saveDb()
  res.json({ ok: true, user: publicUser(user) })
})

app.get('/api/users/:id', requireAuth(), (req, res) => {
  if (req.actor.role === 'device') {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  const user = getDb().users.find((u) => u.id === req.params.id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (req.actor.role === 'employee' && req.actor.sub !== user.id) {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  res.json(publicUser(user))
})

app.get('/api/devices', requireAuth(['admin', 'hr']), (_req, res) => {
  res.json(getDb().devices.map(({ passwordHash, ...d }) => d))
})

app.post('/api/devices', requireAuth(['admin', 'hr']), async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const password = String(req.body?.password || '')
  const location = String(req.body?.location || '').trim()
  if (!name || !password) {
    res.status(400).json({ error: 'Device name and password are required' })
    return
  }
  if (getDb().devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    res.status(409).json({ error: 'Device name already exists' })
    return
  }
  const device = {
    id: randomUUID(),
    name,
    location,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
    createdBy: req.actor.sub,
  }
  getDb().devices.push(device)
  saveDb()
  const { passwordHash, ...rest } = device
  res.status(201).json(rest)
})

app.patch('/api/devices/:id', requireAuth(['admin', 'hr']), async (req, res) => {
  const device = getDb().devices.find((d) => d.id === req.params.id)
  if (!device) {
    res.status(404).json({ error: 'Device not found' })
    return
  }
  if (req.body?.name) device.name = String(req.body.name).trim()
  if (typeof req.body?.location === 'string') device.location = req.body.location
  if (req.body?.password) device.passwordHash = await hashPassword(String(req.body.password))
  saveDb()
  const { passwordHash, ...rest } = device
  res.json(rest)
})

app.delete('/api/devices/:id', requireAuth(['hr']), (req, res) => {
  const db = getDb()
  const before = db.devices.length
  db.devices = db.devices.filter((d) => d.id !== req.params.id)
  if (db.devices.length === before) {
    res.status(404).json({ error: 'Device not found' })
    return
  }
  saveDb()
  res.json({ ok: true })
})

function kioskUserJson(user, extra = {}) {
  const db = getDb()
  const today = db.attendance.find((a) => a.userId === user.id && a.date === todayKey())
  const state = punchState(today)
  const sessions = state.sessions
  return {
    user: publicUser(user),
    today: today
      ? {
          date: today.date,
          checkIn: today.checkIn || sessions[0]?.checkIn || null,
          checkOut: today.checkOut || sessions[sessions.length - 1]?.checkOut || null,
          sessions,
          hours: Math.round(sessionHours(sessions) * 10) / 10,
        }
      : null,
    nextAction: state.next,
    session: state.session,
    shiftHours: SHIFT_HOURS,
    maxSessions: MAX_SESSIONS,
    ...extra,
  }
}

app.post('/api/kiosk/identify', requireAuth(['device']), (req, res) => {
  const match = identifyFace(req.body?.descriptor)
  if (!match) {
    res.json({ match: false })
    return
  }
  res.json({ match: true, ...kioskUserJson(match.user, { confidence: match.distance }) })
})

app.post('/api/kiosk/enroll', requireAuth(['device']), async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const descriptor = req.body?.descriptor
  if (!name || !email || !password || !Array.isArray(descriptor)) {
    res.status(400).json({ error: 'Name, work email, password and face capture are required' })
    return
  }
  const db = getDb()
  const user = db.users.find((u) => u.email === email)
  if (!user) {
    res.status(404).json({ error: 'This person is not in People. HR must add them first.' })
    return
  }
  if (user.name.trim() !== name) {
    res.status(400).json({ error: 'Name must match the People record exactly' })
    return
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Password does not match' })
    return
  }
  if (user.status === 'exited') {
    res.status(409).json({ error: 'This person has exited' })
    return
  }
  if (user.hrStep < 6) {
    res.status(409).json({ error: 'Face enrolment is allowed only after the appointment letter' })
    return
  }
  if (user.faceDescriptor) {
    res.status(409).json({ error: 'This person already has a face enrolled' })
    return
  }
  if (identifyFace(descriptor)) {
    res.status(409).json({ error: 'This face is already enrolled' })
    return
  }
  user.faceDescriptor = descriptor
  user.faceEnrolledAt = new Date().toISOString()
  const facePhoto = saveFacePhoto(req.body?.photo)
  if (facePhoto) user.facePhoto = facePhoto
  if (user.hrStep < 7) user.hrStep = 7
  if (user.status === 'offer') user.status = 'active'
  saveDb()
  res.json(kioskUserJson(user))
})

app.post('/api/kiosk/punch', requireAuth(['device']), (req, res) => {
  const match = identifyFace(req.body?.descriptor)
  if (!match) {
    res.status(404).json({ error: 'Face not recognised. Enrol as a new user first.' })
    return
  }
  if (match.user.hrStep < 7) {
    res.status(409).json({ error: 'Onboarding is not complete yet' })
    return
  }
  const db = getDb()
  const date = todayKey()
  let row = db.attendance.find((a) => a.userId === match.user.id && a.date === date)
  const now = new Date().toISOString()
  const photo = saveFacePhoto(req.body?.photo)
  const state = punchState(row)
  if (state.next === 'done') {
    res.status(409).json({ error: 'Day complete. Two check-in and check-out pairs is the maximum.' })
    return
  }
  if (!row) {
    row = {
      id: randomUUID(),
      userId: match.user.id,
      date,
      sessions: [{ checkIn: now, checkOut: null, deviceId: req.actor.sub, checkInPhoto: photo }],
      deviceId: req.actor.sub,
    }
    db.attendance.push(row)
  } else if (state.next === 'check-out') {
    const last = state.sessions[state.sessions.length - 1]
    last.checkOut = now
    last.checkOutDeviceId = req.actor.sub
    if (photo) last.checkOutPhoto = photo
    row.sessions = state.sessions
  } else {
    row.sessions = [...state.sessions, { checkIn: now, checkOut: null, deviceId: req.actor.sub, checkInPhoto: photo }]
  }
  syncAttendanceRow(row)
  saveDb()
  res.json(kioskUserJson(match.user, { lastAction: state.next }))
})

app.post('/api/users/:id/face', requireAuth(['admin', 'hr', 'employee', 'device']), (req, res) => {
  const user = getDb().users.find((u) => u.id === req.params.id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (req.actor.role === 'employee' && req.actor.sub !== user.id) {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  if (!Array.isArray(req.body?.descriptor)) {
    res.status(400).json({ error: 'Face capture required' })
    return
  }
  user.faceDescriptor = req.body.descriptor
  user.faceEnrolledAt = new Date().toISOString()
  const enrolledPhoto = saveFacePhoto(req.body?.photo)
  if (enrolledPhoto) user.facePhoto = enrolledPhoto
  saveDb()
  res.json(publicUser(user))
})

app.get('/api/attendance', requireAuth(['admin', 'hr', 'manager', 'employee']), (req, res) => {
  const db = getDb()
  let rows = db.attendance
  if (req.actor.role === 'employee') rows = rows.filter((a) => a.userId === req.actor.sub)
  if (req.query.userId) rows = rows.filter((a) => a.userId === req.query.userId)
  if (req.query.month) rows = rows.filter((a) => a.date.startsWith(req.query.month))
  res.json(
    rows
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((row) => {
        const sessions = sessionsOf(row)
        return { ...row, sessions, hours: Math.round(sessionHours(sessions) * 10) / 10 }
      }),
  )
})

app.get('/api/attendance/faces', requireAuth(['hr']), (req, res) => {
  const db = getDb()
  const date = String(req.query.date || todayKey())
  const rows = db.attendance.filter((row) => row.date === date)
  res.json(
    rows.map((row) => {
      const person = db.users.find((u) => u.id === row.userId)
      const sessions = sessionsOf(row)
      return {
        user: publicUser(person),
        date: row.date,
        hours: Math.round(sessionHours(sessions) * 10) / 10,
        sessions: sessions.map((session) => ({
          checkIn: session.checkIn || null,
          checkOut: session.checkOut || null,
          checkInPhoto: session.checkInPhoto || null,
          checkOutPhoto: session.checkOutPhoto || null,
        })),
      }
    }),
  )
})

app.get('/api/attendance/faces/days', requireAuth(['hr']), (req, res) => {
  const month = String(req.query.month || todayKey().slice(0, 7))
  const counts = {}
  for (const row of getDb().attendance.filter((item) => item.date.startsWith(month))) {
    const photos = sessionsOf(row).reduce(
      (n, session) => n + (session.checkInPhoto ? 1 : 0) + (session.checkOutPhoto ? 1 : 0),
      0,
    )
    if (!photos) continue
    counts[row.date] = (counts[row.date] || 0) + photos
  }
  res.json(Object.entries(counts).map(([date, photos]) => ({ date, photos })).sort((a, b) => b.date.localeCompare(a.date)))
})

app.get('/api/attendance/summary', requireAuth(['admin', 'hr', 'manager', 'employee']), (req, res) => {
  const now = new Date()
  const year = Number(req.query.year || now.getFullYear())
  const month = Number(req.query.month || now.getMonth() + 1)
  let users = getDb().users.filter((u) => u.role === 'employee' || u.baseSalary)
  if (req.actor.role === 'employee') users = users.filter((u) => u.id === req.actor.sub)
  if (req.actor.role === 'manager') users = users.filter((u) => u.managerId === req.actor.sub || u.id === req.actor.sub)
  res.json(users.map((u) => ({ user: publicUser(u), ...getMonthAttendance(u.id, year, month) })))
})

app.post('/api/attendance/approve', requireAuth(['admin', 'hr', 'manager']), (req, res) => {
  const { userId, month } = req.body || {}
  if (!userId || !month) {
    res.status(400).json({ error: 'userId and month are required' })
    return
  }
  const db = getDb()
  db.monthlyApprovals = db.monthlyApprovals.filter((a) => !(a.userId === userId && a.month === month))
  db.monthlyApprovals.push({
    id: randomUUID(),
    userId,
    month,
    status: 'approved',
    approvedBy: req.actor.sub,
    approvedAt: new Date().toISOString(),
  })
  saveDb()
  res.json({ ok: true })
})

app.get('/api/leaves', requireAuth(['hr', 'employee']), (req, res) => {
  const db = getDb()
  let rows = db.leaves
  if (req.actor.role === 'employee') rows = rows.filter((l) => l.userId === req.actor.sub)
  res.json(
    rows
      .map((leave) => {
        const person = db.users.find((u) => u.id === leave.userId)
        return { ...leave, user: person ? { id: person.id, name: person.name } : null }
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  )
})

app.post('/api/leaves', requireAuth(['hr', 'employee']), (req, res) => {
  const { type, from, to, reason, userId } = req.body || {}
  const target = req.actor.role === 'hr' && userId ? userId : req.actor.sub
  if (!from || !to) {
    res.status(400).json({ error: 'From and to dates are required' })
    return
  }
  if (from > to) {
    res.status(400).json({ error: 'From date must be before the to date' })
    return
  }
  const leave = {
    id: randomUUID(),
    userId: target,
    type: type || 'paid',
    from,
    to,
    reason: String(reason || '').trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  getDb().leaves.push(leave)
  saveDb()
  res.status(201).json(leave)
})

app.patch('/api/leaves/:id', requireAuth(['hr']), (req, res) => {
  const leave = getDb().leaves.find((l) => l.id === req.params.id)
  if (!leave) {
    res.status(404).json({ error: 'Leave not found' })
    return
  }
  const status = req.body?.status
  if (!['approved', 'rejected'].includes(status)) {
    res.status(400).json({ error: 'Approve or reject this request' })
    return
  }
  leave.status = status
  leave.reviewedBy = req.actor.sub
  leave.reviewedAt = new Date().toISOString()
  saveDb()
  res.json(leave)
})

app.get('/api/shifts', requireAuth(), (_req, res) => res.json(getDb().shifts))
app.post('/api/shifts', requireAuth(['admin', 'hr']), (req, res) => {
  const shift = {
    id: randomUUID(),
    name: req.body?.name || 'Shift',
    start: req.body?.start || '09:30',
    end: req.body?.end || '18:30',
    createdAt: new Date().toISOString(),
  }
  getDb().shifts.push(shift)
  saveDb()
  res.status(201).json(shift)
})

app.get('/api/holidays', requireAuth(), (_req, res) => res.json(getDb().holidays))
app.post('/api/holidays', requireAuth(['admin', 'hr']), (req, res) => {
  const holiday = {
    id: randomUUID(),
    date: req.body?.date,
    name: req.body?.name || 'Holiday',
  }
  if (!holiday.date) {
    res.status(400).json({ error: 'Date required' })
    return
  }
  getDb().holidays.push(holiday)
  saveDb()
  res.status(201).json(holiday)
})

app.get('/api/users/:id/journey', requireAuth(), (req, res) => {
  if (req.actor.role === 'device') {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  if (req.actor.role === 'employee' && req.actor.sub !== req.params.id) {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  const journey = getJourney(req.params.id)
  if (!journey) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  res.json(journey)
})

app.post('/api/users/:id/documents', requireAuth(['admin', 'hr', 'employee']), (req, res) => {
  const db = getDb()
  const user = db.users.find((u) => u.id === req.params.id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (req.actor.role === 'employee' && req.actor.sub !== user.id) {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  const name = String(req.body?.name || '').trim()
  if (!name) {
    res.status(400).json({ error: 'Document name is required' })
    return
  }
  const doc = {
    id: randomUUID(),
    userId: user.id,
    name,
    kind: req.body?.kind || 'other',
    notes: req.body?.notes || '',
    createdAt: new Date().toISOString(),
  }
  db.documents.push(doc)
  saveDb()
  res.status(201).json(doc)
})

app.get('/api/users/:id/preview/:key', requireAuth(), (req, res) => {
  if (req.actor.role === 'employee' && req.actor.sub !== req.params.id) {
    res.status(403).json({ error: 'Not allowed' })
    return
  }
  const user = getDb().users.find((u) => u.id === req.params.id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  const rendered = previewLetter(req.params.key, user)
  if (!rendered) {
    res.status(404).json({ error: 'Unknown template' })
    return
  }
  res.json(rendered)
})

app.post('/api/users/:id/workflow', requireAuth(['admin', 'hr', 'manager', 'employee']), async (req, res) => {
  try {
    const user = getDb().users.find((u) => u.id === req.params.id)
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    const result = await completeStep(user, req.actor, {
      skip: Boolean(req.body?.skip),
      note: String(req.body?.note || '').trim(),
      documents: Array.isArray(req.body?.documents) ? req.body.documents : [],
      subject: req.body?.subject,
      body: req.body?.body,
    })
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not complete step' })
  }
})

app.get('/api/users/:id/letters', requireAuth(), (req, res) => {
  if (req.actor.role === 'employee' && req.actor.sub !== req.params.id) {
    return res.status(403).json({ error: 'Not allowed' })
  }
  res.json(getDb().letters.filter((l) => l.userId === req.params.id))
})

app.get('/api/payroll/insights', requireAuth(['hr', 'employee']), (req, res) => {
  const userId = req.actor.role === 'employee' ? req.actor.sub : req.query.userId || ''
  const data = payrollInsights(req.actor, userId || undefined)
  if (!data) {
    res.status(404).json({ error: 'Person not found' })
    return
  }
  res.json(data)
})

app.get('/api/payroll', requireAuth(['hr', 'employee']), (req, res) => {
  const db = getDb()
  const month = req.query.month
  const from = req.query.from
  const to = req.query.to
  const userId = req.actor.role === 'employee' ? req.actor.sub : req.query.userId
  let rows = db.salaries
  if (req.actor.role === 'employee' || userId) rows = rows.filter((s) => s.userId === (userId || req.actor.sub))
  if (month) rows = rows.filter((s) => s.month === month)
  if (from && to) {
    rows = rows.filter((s) => {
      const period = periodOf(s)
      return period.from <= to && period.to >= from
    })
  }
  res.json(
    rows
      .sort((a, b) => String(periodOf(b).from).localeCompare(String(periodOf(a).from)))
      .map((row) => {
        const person = db.users.find((u) => u.id === row.userId)
        const period = periodOf(row)
        return {
          ...row,
          from: period.from,
          to: period.to,
          period: row.period || periodLabel(period.from, period.to),
          user: person ? publicUser(person) : null,
        }
      }),
  )
})

app.post('/api/payroll/run', requireAuth(['hr']), (req, res) => {
  const from = String(req.body?.from || '')
  const to = String(req.body?.to || '')
  const userId = req.body?.userId ? String(req.body.userId) : ''
  if (!from || !to || from > to) {
    res.status(400).json({ error: 'Choose a start date and an end date' })
    return
  }
  const db = getDb()
  let users
  if (userId) {
    const person = db.users.find((u) => u.id === userId)
    if (!person || person.role === 'device') {
      res.status(404).json({ error: 'Person not found' })
      return
    }
    users = [person]
  } else {
    users = db.users.filter((u) => u.role === 'employee' && u.hrStep >= 7 && u.status !== 'exited')
  }

  const skipped = []
  const toProcess = []
  for (const person of users) {
    const overlap = overlappingSalaries(person.id, from, to)
    const paid = overlap.filter((row) => row.emailedAt)
    if (paid.length) {
      const period = periodOf(paid[0])
      skipped.push({
        name: person.name,
        reason: `Already paid ${periodLabel(period.from, period.to)}. Pick dates after that.`,
      })
      continue
    }
    const draft = overlap.filter((row) => !row.emailedAt)
    if (draft.length && !(draft.length === 1 && draft[0].from === from && draft[0].to === to)) {
      const period = periodOf(draft[0])
      skipped.push({
        name: person.name,
        reason: `Overlaps an unsent payslip (${periodLabel(period.from, period.to)}). Change the dates or send that one first.`,
      })
      continue
    }
    toProcess.push(person)
  }

  if (!toProcess.length) {
    res.status(409).json({
      error: skipped[0]?.reason || 'This range is already processed',
      skipped,
    })
    return
  }

  const salaries = toProcess.map((u) => processSalary(u, from, to, req.actor.sub))
  toProcess.forEach((u, i) => {
    const salary = salaries[i]
    if (salary.emailedAt) return
    db.payslips = db.payslips.filter((p) => !(p.userId === u.id && p.from === from && p.to === to && !p.emailedAt))
    db.payslips.push({
      id: randomUUID(),
      salaryId: salary.id,
      userId: u.id,
      month: salary.month,
      from,
      to,
      generatedAt: new Date().toISOString(),
    })
    if (u.hrStep < 9) u.hrStep = 9
  })
  saveDb()
  res.json({
    salaries: salaries.map((row) => {
      const person = db.users.find((u) => u.id === row.userId)
      return { ...row, user: person ? publicUser(person) : null }
    }),
    skipped,
  })
})

app.patch('/api/payroll/:id', requireAuth(['hr']), (req, res) => {
  const salary = getDb().salaries.find((s) => s.id === req.params.id)
  if (!salary) {
    res.status(404).json({ error: 'Salary row not found' })
    return
  }
  if (salary.emailedAt) {
    res.status(409).json({ error: 'Payslip already sent. Amount cannot be changed.' })
    return
  }
  const net = Number(req.body?.net)
  if (!Number.isFinite(net) || net < 0) {
    res.status(400).json({ error: 'Enter a valid final amount' })
    return
  }
  salary.net = Math.round(net)
  salary.netAdjusted = true
  salary.adjustedBy = req.actor.sub
  salary.adjustedAt = new Date().toISOString()
  saveDb()
  const person = getDb().users.find((u) => u.id === salary.userId)
  res.json({ ...salary, user: person ? publicUser(person) : null })
})

app.post('/api/payroll/:id/payslip', requireAuth(['hr']), (req, res) => {
  const salary = getDb().salaries.find((s) => s.id === req.params.id)
  if (!salary) {
    res.status(404).json({ error: 'Salary row not found' })
    return
  }
  const user = getDb().users.find((u) => u.id === salary.userId)
  const slip = {
    id: randomUUID(),
    salaryId: salary.id,
    userId: user.id,
    month: salary.month,
    generatedAt: new Date().toISOString(),
  }
  getDb().payslips.push(slip)
  if (user.hrStep < 9) user.hrStep = 9
  saveDb()
  res.json(slip)
})

app.post('/api/payroll/:id/email', requireAuth(['hr']), async (req, res) => {
  try {
    const salary = getDb().salaries.find((s) => s.id === req.params.id)
    if (!salary) {
      res.status(404).json({ error: 'Salary row not found' })
      return
    }
    if (salary.emailedAt) {
      res.status(409).json({ error: 'Payslip already sent to this employee' })
      return
    }
    const user = getDb().users.find((u) => u.id === salary.userId)
    const slip = await emailPayslip(user, salary)
    salary.emailedAt = slip.emailedAt
    if (user.hrStep < 10) user.hrStep = 10
    saveDb()
    res.json(slip)
  } catch (err) {
    res.status(500).json({ error: err.message || 'Email failed' })
  }
})

app.get('/api/settings', requireAuth(['admin', 'hr']), (_req, res) => {
  const { smtp, ethereal, ...rest } = getDb().settings
  res.json({
    ...rest,
    templates: getTemplates(),
    templateKeys: TEMPLATE_KEYS,
    smtp: { ...smtp, pass: smtp?.pass ? '••••' : '' },
    etherealUser: ethereal?.user || null,
  })
})

app.patch('/api/settings', requireAuth(['hr']), (req, res) => {
  const settings = getDb().settings
  if (req.body?.companyName) settings.companyName = req.body.companyName
  if (req.body?.emailMode) settings.emailMode = req.body.emailMode
  if (req.body?.smtp) {
    settings.smtp = { ...settings.smtp, ...req.body.smtp }
    if (req.body.smtp.pass === '••••') delete settings.smtp.pass
  }
  if (req.body?.templates) {
    settings.templates = { ...getTemplates(), ...req.body.templates }
  }
  saveDb()
  res.json({ ok: true, templates: getTemplates() })
})

app.post('/api/settings/email-test', requireAuth(['admin', 'hr']), async (req, res) => {
  try {
    const to = req.body?.to || getDb().users.find((u) => u.id === req.actor.sub)?.email
    const result = await sendMail({
      to,
      subject: 'People · test email',
      html: '<p>This is an MVP test email from People.</p>',
      text: 'This is an MVP test email from People.',
    })
    res.json({ ok: true, ...result, to })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Email failed' })
  }
})

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || 'Server error' })
})

export default app
