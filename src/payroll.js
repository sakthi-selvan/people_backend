import { randomUUID } from 'node:crypto'
import { getDb, publicUser, saveDb } from './store.js'
import { attendanceDay, monthKey, monthsCovered, nextIsoDate, todayKey, workingDatesInRange } from './util.js'
import { sendMail } from './mailer.js'
import { DEFAULT_TEMPLATES, letterVars, renderTemplate } from './templates.js'

export function periodOf(salary) {
  if (salary?.from && salary?.to) return { from: salary.from, to: salary.to }
  const month = salary?.month || monthKey()
  const [year, mon] = month.split('-').map(Number)
  const last = new Date(year, mon, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

export function periodLabel(from, to) {
  const fmt = (iso) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  if (!from || !to) return ''
  return `${fmt(from)} – ${fmt(to)}`
}

export function lastPaidTo(userId) {
  const dates = getDb()
    .salaries.filter((row) => row.userId === userId)
    .map((row) => periodOf(row).to)
  if (!dates.length) return null
  return dates.sort().at(-1)
}

export function overlappingSalaries(userId, from, to) {
  return getDb().salaries.filter((row) => {
    if (row.userId !== userId) return false
    const period = periodOf(row)
    return period.from <= to && period.to >= from
  })
}

export function suggestedRange(person) {
  const today = todayKey()
  const last = lastPaidTo(person.id)
  const join = person.joiningDate && person.joiningDate <= today ? person.joiningDate : `${today.slice(0, 8)}01`
  const from = last ? nextIsoDate(last) : join
  if (from > today) {
    return { lastPaidTo: last, suggestedFrom: last || join, suggestedTo: last || today, caughtUp: true }
  }
  return { lastPaidTo: last, suggestedFrom: from, suggestedTo: today, caughtUp: false }
}

export function getMonthAttendance(userId, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  const last = new Date(year, month, 0).getDate()
  return getRangeAttendance(userId, `${prefix}-01`, `${prefix}-${String(last).padStart(2, '0')}`)
}

export function getRangeAttendance(userId, from, to) {
  const db = getDb()
  const records = db.attendance.filter((a) => a.userId === userId && a.date >= from && a.date <= to)
  const holidays = db.holidays.filter((h) => h.date >= from && h.date <= to)
  const work = workingDatesInRange(from, to, db.holidays)
  const leaves = db.leaves.filter((l) => l.userId === userId && l.status === 'approved' && l.from <= to && l.to >= from)
  const leaveDates = new Set()
  for (const leave of leaves) {
    for (const date of work) {
      if (date >= leave.from && date <= leave.to) leaveDates.add(date)
    }
  }

  let present = 0
  let hours = 0
  for (const rec of records) {
    const day = attendanceDay(rec)
    if (day.present) present += 1
    hours += day.hours
  }

  const months = monthsCovered(from, to)
  const approved = months.every((month) =>
    db.monthlyApprovals.some((a) => a.userId === userId && a.month === month && a.status === 'approved'),
  )

  return {
    from,
    to,
    month: to.slice(0, 7),
    period: periodLabel(from, to),
    workingDays: work.length,
    presentDays: present,
    leaveDays: [...leaveDates].length,
    holidays: holidays.length,
    hours: Math.round(hours * 10) / 10,
    records,
    approved,
  }
}

export function processSalary(user, from, to, actorId) {
  const db = getDb()
  const summary = getRangeAttendance(user.id, from, to)
  const payableDays = Math.max(summary.workingDays - summary.leaveDays, 0)
  const attendanceFactor = payableDays ? summary.presentDays / payableDays : 0
  const gross = Number(user.baseSalary || 0)
  const computedNet = Math.round(gross * Math.min(attendanceFactor, 1))
  const previous = db.salaries.find(
    (s) => s.userId === user.id && ((s.from === from && s.to === to) || (!s.from && s.month === summary.month)),
  )
  const net = previous?.emailedAt ? previous.net : previous?.netAdjusted ? previous.net : computedNet
  const row = {
    id: previous?.emailedAt ? previous.id : randomUUID(),
    userId: user.id,
    month: summary.month,
    from,
    to,
    period: summary.period,
    gross,
    computedNet,
    net,
    netAdjusted: Boolean(previous?.netAdjusted) && net !== computedNet,
    presentDays: summary.presentDays,
    workingDays: summary.workingDays,
    leaveDays: summary.leaveDays,
    emailedAt: previous?.emailedAt || null,
    createdAt: previous?.createdAt || new Date().toISOString(),
    createdBy: actorId,
  }
  db.salaries = db.salaries.filter((s) => s.id !== row.id && !(s.userId === user.id && s.from === from && s.to === to))
  if (!previous?.from) db.salaries = db.salaries.filter((s) => !(s.userId === user.id && !s.from && s.month === summary.month && s.id !== row.id))
  db.salaries.push(row)
  saveDb()
  return row
}

export function monthsWorkedSince(joiningDate, today = new Date().toISOString().slice(0, 10)) {
  if (!joiningDate || joiningDate > today) return 0
  const start = joiningDate.slice(0, 7)
  const end = today.slice(0, 7)
  let count = 0
  let [year, month] = start.split('-').map(Number)
  const [endYear, endMonth] = end.split('-').map(Number)
  while (year < endYear || (year === endYear && month <= endMonth)) {
    count += 1
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    if (count > 240) break
  }
  return count
}

export function payrollInsights(actor, userId) {
  const db = getDb()
  const employees = db.users.filter((u) => u.role === 'employee' && u.status !== 'exited')
  const targetId = actor.role === 'employee' ? actor.sub : userId
  const salaries = db.salaries
    .filter((row) => (targetId ? row.userId === targetId : true))
    .sort((a, b) => String(periodOf(a).from).localeCompare(String(periodOf(b).from)))

  function forPerson(person) {
    const rows = db.salaries.filter((row) => row.userId === person.id).sort((a, b) => String(periodOf(a).from).localeCompare(String(periodOf(b).from)))
    const received = rows.filter((row) => row.emailedAt)
    const pending = rows.filter((row) => !row.emailedAt)
    const totalReceived = received.reduce((sum, row) => sum + Number(row.net || 0), 0)
    const last = received.at(-1) || rows.at(-1) || null
    const range = suggestedRange(person)
    return {
      user: publicUser(person),
      monthsWorked: monthsWorkedSince(person.joiningDate),
      cyclesPaid: received.length,
      totalReceived,
      pendingAmount: pending.reduce((sum, row) => sum + Number(row.net || 0), 0),
      lastNet: last ? Number(last.net || 0) : 0,
      averageNet: received.length ? Math.round(totalReceived / received.length) : 0,
      lastPaidTo: range.lastPaidTo,
      suggestedFrom: range.suggestedFrom,
      suggestedTo: range.suggestedTo,
      caughtUp: range.caughtUp,
      cycles: rows.map((row) => {
        const period = periodOf(row)
        return {
          ...row,
          from: period.from,
          to: period.to,
          period: row.period || periodLabel(period.from, period.to),
        }
      }),
    }
  }

  if (targetId) {
    const person = db.users.find((u) => u.id === targetId)
    if (!person) return null
    return forPerson(person)
  }

  const people = employees.map(forPerson)
  const totalReceived = people.reduce((sum, row) => sum + row.totalReceived, 0)
  const open = people.filter((row) => !row.caughtUp)
  const today = todayKey()
  return {
    monthsWorked: people.length ? Math.max(...people.map((row) => row.monthsWorked)) : 0,
    cyclesPaid: people.reduce((sum, row) => sum + row.cyclesPaid, 0),
    totalReceived,
    pendingAmount: people.reduce((sum, row) => sum + row.pendingAmount, 0),
    lastNet: 0,
    averageNet: people.length ? Math.round(totalReceived / Math.max(people.reduce((sum, row) => sum + row.cyclesPaid, 0), 1)) : 0,
    lastPaidTo: null,
    suggestedFrom: open.length ? open.map((row) => row.suggestedFrom).sort()[0] : today.slice(0, 8) + '01',
    suggestedTo: today,
    caughtUp: open.length === 0,
    cycles: salaries.map((row) => {
      const period = periodOf(row)
      const person = db.users.find((u) => u.id === row.userId)
      return {
        ...row,
        from: period.from,
        to: period.to,
        period: row.period || periodLabel(period.from, period.to),
        user: person ? publicUser(person) : null,
      }
    }),
    people,
  }
}

export function payslipHtml(user, salary) {
  const template = { ...DEFAULT_TEMPLATES, ...(getDb().settings.templates || {}) }.payslip
  const period = periodOf(salary)
  const rendered = renderTemplate(
    template,
    letterVars(user, {
      company: getDb().settings.companyName || 'People',
      month: periodLabel(period.from, period.to),
      period: periodLabel(period.from, period.to),
      from: period.from,
      to: period.to,
      workingDays: salary.workingDays,
      presentDays: salary.presentDays,
      leaveDays: salary.leaveDays,
      gross: salary.gross,
      net: salary.net,
    }),
  )
  return rendered
}

export async function emailPayslip(user, salary) {
  const db = getDb()
  const rendered = payslipHtml(user, salary)
  const result = await sendMail({
    to: user.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.body,
  })
  const slip = {
    id: randomUUID(),
    salaryId: salary.id,
    userId: user.id,
    month: salary.month,
    emailedAt: new Date().toISOString(),
    previewUrl: result.previewUrl,
    mode: result.mode,
    subject: rendered.subject,
    body: rendered.body,
    html: rendered.html,
  }
  db.payslips.push(slip)
  db.emails = db.emails || []
  db.emails.push({
    id: randomUUID(),
    userId: user.id,
    key: 'payslip',
    step: 10,
    to: user.email,
    subject: rendered.subject,
    previewUrl: result.previewUrl,
    mode: result.mode,
    sentAt: slip.emailedAt,
  })
  saveDb()
  return slip
}

export { publicUser }
export { monthKey }
