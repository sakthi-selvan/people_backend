import { HR_STEPS } from './constants.js'

export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

export function isWeekend(isoDate) {
  const day = new Date(`${isoDate}T12:00:00`).getDay()
  return day === 0 || day === 6
}

export function pad2(value) {
  return String(value).padStart(2, '0')
}

export function isoDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function nextIsoDate(date) {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + 1)
  return isoDate(d)
}

export function datesInRange(from, to) {
  if (!from || !to || from > to) return []
  const dates = []
  for (let date = from, i = 0; date <= to && i < 400; i += 1) {
    dates.push(date)
    date = nextIsoDate(date)
  }
  return dates
}

export function workingDatesInRange(from, to, holidays = []) {
  const holidaySet = new Set(holidays.map((h) => h.date))
  return datesInRange(from, to).filter((d) => !isWeekend(d) && !holidaySet.has(d))
}

export function monthsCovered(from, to) {
  return [...new Set(datesInRange(from, to).map((date) => date.slice(0, 7)))]
}

export function payCycleFor(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth() - 1, 21)
  const end = new Date(date.getFullYear(), date.getMonth(), 20)
  return { from: isoDate(start), to: isoDate(end) }
}

export function shiftIsoMonths(iso, months) {
  const d = new Date(`${iso}T12:00:00`)
  d.setMonth(d.getMonth() + months)
  return isoDate(d)
}

export function daysInMonth(year, month) {
  const last = new Date(year, month, 0).getDate()
  return Array.from({ length: last }, (_, i) => {
    const d = String(i + 1).padStart(2, '0')
    const m = String(month).padStart(2, '0')
    return `${year}-${m}-${d}`
  })
}

export function workingDates(year, month, holidays) {
  const holidaySet = new Set(holidays.map((h) => h.date))
  return daysInMonth(year, month).filter((d) => !isWeekend(d) && !holidaySet.has(d))
}

export function minutesBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / 60000)
}

export const SHIFT_HOURS = 9
export const MAX_SESSIONS = 2

export function sessionsOf(record) {
  if (!record) return []
  if (Array.isArray(record.sessions) && record.sessions.length) return record.sessions
  if (record.checkIn) {
    return [
      {
        checkIn: record.checkIn,
        checkOut: record.checkOut || null,
        deviceId: record.deviceId || null,
        checkOutDeviceId: record.checkOutDeviceId || null,
      },
    ]
  }
  return []
}

export function syncAttendanceRow(row) {
  const sessions = sessionsOf(row)
  row.sessions = sessions
  row.checkIn = sessions[0]?.checkIn || null
  const last = sessions[sessions.length - 1]
  row.checkOut = last?.checkOut || null
  return row
}

export function punchState(record) {
  const sessions = sessionsOf(record)
  const last = sessions[sessions.length - 1]
  if (!last) return { next: 'check-in', session: 1, sessions }
  if (!last.checkOut) return { next: 'check-out', session: sessions.length, sessions }
  if (sessions.length < MAX_SESSIONS) return { next: 'check-in', session: sessions.length + 1, sessions }
  return { next: 'done', session: sessions.length, sessions }
}

export function sessionHours(sessions) {
  return sessions.reduce((sum, item) => {
    if (!item?.checkIn || !item.checkOut) return sum
    return sum + minutesBetween(item.checkIn, item.checkOut) / 60
  }, 0)
}

export function isHrRole(role) {
  return role === 'hr' || role === 'admin' || role === 'manager'
}

export function canAct(actorRole, step) {
  const spec = HR_STEPS.find((s) => s.id === step)
  if (!spec) return false
  if (isHrRole(actorRole)) return true
  if (spec.actor === 'employee' || spec.actor === 'employee_head') return actorRole === 'employee'
  return false
}

export function attendanceDay(record) {
  const sessions = sessionsOf(record)
  if (!sessions.length) return { present: false, hours: 0 }
  const hours = sessionHours(sessions)
  const open = sessions.some((item) => item.checkIn && !item.checkOut)
  return { present: true, hours, open }
}
