import { randomUUID } from 'node:crypto'
import { getDb, nextCode, saveDb } from './store.js'
import { hashPassword } from './auth.js'
import { daysInMonth, isWeekend, monthsCovered, payCycleFor, sessionsOf, shiftIsoMonths, syncAttendanceRow } from './util.js'
import { periodLabel } from './payroll.js'
import { demoFacePhoto, hueFrom } from './photos.js'

export async function seedIfEmpty() {
  const db = getDb()
  if (!db.users.length) {
    const passwordHash = await hashPassword('Admin@123')
    const now = new Date().toISOString()
    const joiningDate = `${now.slice(0, 8)}01`

    const admin = {
      id: randomUUID(),
      code: 'EMP-0001',
      name: 'Asha Raman',
      email: 'admin@people.local',
      phone: '',
      role: 'admin',
      department: 'People Operations',
      managerId: null,
      status: 'active',
      hrStep: 12,
      faceDescriptor: null,
      faceEnrolledAt: null,
      baseSalary: 0,
      shiftId: null,
      joiningDate,
      passwordHash,
      createdAt: now,
    }

    const hr = {
      ...admin,
      id: randomUUID(),
      code: 'EMP-0002',
      name: 'Kiran Mehta',
      email: 'hr@people.local',
      role: 'hr',
      passwordHash: await hashPassword('Hr@123'),
    }

    const manager = {
      ...admin,
      id: randomUUID(),
      code: 'EMP-0003',
      name: 'Neel Sharma',
      email: 'manager@people.local',
      role: 'manager',
      department: 'Engineering',
      passwordHash: await hashPassword('Manager@123'),
    }

    const employee = {
      ...admin,
      id: randomUUID(),
      code: 'EMP-0004',
      name: 'Priya Nair',
      email: 'employee@people.local',
      role: 'employee',
      department: 'Engineering',
      managerId: manager.id,
      hrStep: 7,
      baseSalary: 45000,
      passwordHash: await hashPassword('Employee@123'),
    }

    db.users.push(admin, hr, manager, employee)

    db.shifts.push({
      id: randomUUID(),
      name: 'General',
      start: '09:30',
      end: '18:30',
      hours: 9,
      createdAt: now,
    })
    employee.shiftId = db.shifts[0].id
    admin.shiftId = db.shifts[0].id
    hr.shiftId = db.shifts[0].id
    manager.shiftId = db.shifts[0].id

    db.holidays.push({
      id: randomUUID(),
      date: `${new Date().getFullYear()}-01-26`,
      name: 'Republic Day',
    })

    db.devices.push({
      id: randomUUID(),
      name: 'Lobby Kiosk',
      location: 'Reception',
      passwordHash: await hashPassword('Device@123'),
      createdAt: now,
    })
    saveDb()
  }
  seedDemoAttendance()
  seedDemoPayroll()
}

function fakeFace(seed) {
  return Array.from({ length: 128 }, (_, i) => Number(Math.sin(seed * 19.19 + i * 0.17).toFixed(6)))
}

function stamp(date, hour, minute) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString()
}

function seedDemoAttendance() {
  const db = getDb()
  if (!db.attendance.length) {
    fillDemoPunches()
  }
  backfillFacePhotos()
}

function fillDemoPunches() {
  const db = getDb()
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const today = now.toISOString().slice(0, 10)
  const deviceId = db.devices[0]?.id || null
  const employees = db.users.filter((u) => u.role === 'employee' && u.hrStep >= 7)

  employees.forEach((user, index) => {
    user.faceDescriptor = fakeFace(index + 1)
    user.faceEnrolledAt = stamp(`${year}-${String(month).padStart(2, '0')}-01`, 9, 0)
    if (!user.joiningDate || user.joiningDate > `${year}-${String(month).padStart(2, '0')}-01`) {
      user.joiningDate = `${year}-${String(month).padStart(2, '0')}-01`
    }

    for (const date of daysInMonth(year, month)) {
      if (date > today || isWeekend(date)) continue
      const day = Number(date.slice(-2))
      const kind = (day + index) % 5
      if (kind === 3) continue
      if (kind === 1) {
        db.attendance.push({
          id: randomUUID(),
          userId: user.id,
          date,
          deviceId,
          checkIn: stamp(date, 9, 30),
          checkOut: stamp(date, 18, 30),
          sessions: [
            { checkIn: stamp(date, 9, 30), checkOut: stamp(date, 13, 0), deviceId, checkOutDeviceId: deviceId },
            { checkIn: stamp(date, 14, 0), checkOut: stamp(date, 18, 30), deviceId, checkOutDeviceId: deviceId },
          ],
        })
      } else if (kind === 4 && date !== today) {
        db.attendance.push({
          id: randomUUID(),
          userId: user.id,
          date,
          deviceId,
          checkIn: stamp(date, 9, 30),
          checkOut: stamp(date, 14, 0),
          sessions: [{ checkIn: stamp(date, 9, 30), checkOut: stamp(date, 14, 0), deviceId, checkOutDeviceId: deviceId }],
        })
      } else if (date === today) {
        db.attendance.push({
          id: randomUUID(),
          userId: user.id,
          date,
          deviceId,
          checkIn: stamp(date, 9, 30),
          checkOut: null,
          sessions: [{ checkIn: stamp(date, 9, 30), checkOut: null, deviceId }],
        })
      } else {
        db.attendance.push({
          id: randomUUID(),
          userId: user.id,
          date,
          deviceId,
          checkIn: stamp(date, 9, 30),
          checkOut: stamp(date, 18, 30),
          sessions: [{ checkIn: stamp(date, 9, 30), checkOut: stamp(date, 18, 30), deviceId, checkOutDeviceId: deviceId }],
        })
      }
    }
  })

  const priya = db.users.find((u) => u.email === 'employee@people.local')
  if (priya) {
    const leaveDay = daysInMonth(year, month).find((date) => date < today && !isWeekend(date) && Number(date.slice(-2)) % 5 === 3)
    if (leaveDay) {
      db.leaves.push({
        id: randomUUID(),
        userId: priya.id,
        type: 'paid',
        from: leaveDay,
        to: leaveDay,
        reason: 'Personal work',
        status: 'approved',
        createdAt: stamp(leaveDay, 8, 0),
        reviewedAt: stamp(leaveDay, 8, 30),
      })
      db.attendance = db.attendance.filter((row) => !(row.userId === priya.id && row.date === leaveDay))
    }
    const upcoming = daysInMonth(year, month).find((date) => date > today && !isWeekend(date))
    if (upcoming) {
      db.leaves.push({
        id: randomUUID(),
        userId: priya.id,
        type: 'paid',
        from: upcoming,
        to: upcoming,
        reason: 'Family visit',
        status: 'pending',
        createdAt: now.toISOString(),
      })
    }
  }

  saveDb()
}

function seedDemoPayroll() {
  const db = getDb()
  if (db.salaries.length) return
  const priya = db.users.find((u) => u.email === 'employee@people.local')
  if (!priya) return
  const cycle = payCycleFor()
  const join = new Date(`${cycle.from}T12:00:00`)
  join.setMonth(join.getMonth() - 4)
  priya.joiningDate = `${join.getFullYear()}-${String(join.getMonth() + 1).padStart(2, '0')}-01`
  const amounts = [41000, 42500, 43000, 44000]
  for (let i = 4; i >= 1; i -= 1) {
    const from = shiftIsoMonths(cycle.from, -i)
    const to = shiftIsoMonths(cycle.to, -i)
    const emailedAt = new Date(`${to}T18:00:00`).toISOString()
    db.salaries.push({
      id: randomUUID(),
      userId: priya.id,
      month: to.slice(0, 7),
      from,
      to,
      period: periodLabel(from, to),
      gross: priya.baseSalary,
      computedNet: amounts[4 - i],
      net: amounts[4 - i],
      presentDays: 20,
      workingDays: 22,
      leaveDays: 1,
      emailedAt,
      createdAt: emailedAt,
    })
  }
  const hr = db.users.find((u) => u.role === 'hr')
  for (const month of monthsCovered(cycle.from, cycle.to)) {
    if (db.monthlyApprovals.some((a) => a.userId === priya.id && a.month === month)) continue
    db.monthlyApprovals.push({
      id: randomUUID(),
      userId: priya.id,
      month,
      status: 'approved',
      approvedBy: hr?.id || priya.id,
      approvedAt: new Date().toISOString(),
    })
  }
  saveDb()
}

function backfillFacePhotos() {
  const db = getDb()
  let changed = false
  for (const row of db.attendance) {
    const person = db.users.find((u) => u.id === row.userId)
    const name = person?.name || 'Employee'
    const hue = hueFrom(person?.id || name)
    const sessions = sessionsOf(row)
    for (const session of sessions) {
      if (session.checkIn && !session.checkInPhoto) {
        session.checkInPhoto = demoFacePhoto(name, 'In', hue)
        changed = true
      }
      if (session.checkOut && !session.checkOutPhoto) {
        session.checkOutPhoto = demoFacePhoto(name, 'Out', (hue + 32) % 360)
        changed = true
      }
    }
    row.sessions = sessions
    syncAttendanceRow(row)
  }
  for (const user of db.users.filter((u) => u.role === 'employee' && u.hrStep >= 7 && !u.facePhoto)) {
    user.facePhoto = demoFacePhoto(user.name, 'Enrol', hueFrom(user.id))
    changed = true
  }
  if (changed) saveDb()
}

export function createUser(input, { faceDescriptor = null } = {}) {
  const db = getDb()
  const now = new Date().toISOString()
  const user = {
    id: randomUUID(),
    code: nextCode('EMP', db.users, 'code'),
    name: input.name.trim(),
    email: String(input.email || '').trim().toLowerCase(),
    phone: input.phone || '',
    role: input.role || 'employee',
    department: input.department || '',
    managerId: input.managerId || null,
    status: input.status || 'active',
    hrStep: Number.isFinite(input.hrStep) ? input.hrStep : 0,
    faceDescriptor,
    faceEnrolledAt: faceDescriptor ? now : null,
    baseSalary: Number(input.baseSalary || 0),
    shiftId: input.shiftId || db.shifts[0]?.id || null,
    joiningDate: input.joiningDate || now.slice(0, 10),
    passwordHash: input.passwordHash || null,
    createdAt: now,
  }
  db.users.push(user)
  saveDb()
  return user
}
