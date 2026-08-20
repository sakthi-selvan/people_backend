import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TEMPLATES } from './templates.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const dataDir = process.env.DATA_DIR
  ? join(process.cwd(), process.env.DATA_DIR)
  : join(root, 'data')
export const dbPath = join(dataDir, 'db.json')

function emptyDb() {
  return {
    users: [],
    devices: [],
    documents: [],
    letters: [],
    attendance: [],
    leaves: [],
    shifts: [],
    holidays: [],
    monthlyApprovals: [],
    salaries: [],
    payslips: [],
    emails: [],
    workflowEvents: [],
    settings: {
      companyName: 'People',
      emailMode: 'ethereal',
      ethereal: null,
      templates: {},
      smtp: {
        host: process.env.SMTP_HOST || '',
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.SMTP_FROM || 'People <people@example.com>',
        secure: process.env.SMTP_SECURE === 'true',
      },
    },
  }
}

mkdirSync(dataDir, { recursive: true })
mkdirSync(join(dataDir, 'uploads'), { recursive: true })

let db = emptyDb()
if (existsSync(dbPath)) {
  try {
    db = { ...emptyDb(), ...JSON.parse(readFileSync(dbPath, 'utf8')) }
    db.settings = {
      ...emptyDb().settings,
      ...(db.settings || {}),
      smtp: { ...emptyDb().settings.smtp, ...(db.settings?.smtp || {}) },
      templates: { ...DEFAULT_TEMPLATES, ...(db.settings?.templates || {}) },
    }
    db.emails = db.emails || []
    db.workflowEvents = db.workflowEvents || []
    for (const user of db.users) {
      if (user.role === 'admin' || user.role === 'manager') user.role = 'hr'
    }
  } catch {
    db = emptyDb()
  }
}

export function getDb() {
  return db
}

export function saveDb() {
  const tmp = `${dbPath}.tmp`
  writeFileSync(tmp, JSON.stringify(db, null, 2))
  renameSync(tmp, dbPath)
}

if (existsSync(dbPath)) saveDb()

export function nextCode(prefix, list, field = 'code') {
  const nums = list
    .map((row) => Number(String(row[field] || '').replace(/\D/g, '')))
    .filter((n) => Number.isFinite(n))
  const n = (nums.length ? Math.max(...nums) : 0) + 1
  return `${prefix}-${String(n).padStart(4, '0')}`
}

export function publicUser(user) {
  if (!user) return null
  const { passwordHash, faceDescriptor, ...rest } = user
  return {
    ...rest,
    role: rest.role === 'admin' || rest.role === 'manager' ? 'hr' : rest.role,
    hasFace: Array.isArray(faceDescriptor) && faceDescriptor.length > 0,
    hasPassword: Boolean(passwordHash),
  }
}
