import { randomUUID } from 'node:crypto'
import { canRequestResignation, HR_STEPS, isExited, nextLifecycleStep } from './constants.js'
import { sendMail } from './mailer.js'
import { getDb, publicUser, saveDb } from './store.js'
import { DEFAULT_TEMPLATES, letterVars, renderTemplate, TEMPLATE_KEYS } from './templates.js'
import { canAct, isHrRole } from './util.js'

const LETTER_BY_STEP = Object.fromEntries(TEMPLATE_KEYS.filter((t) => t.step).map((t) => [t.step, t.key]))

export function getTemplates() {
  const settings = getDb().settings
  return { ...DEFAULT_TEMPLATES, ...(settings.templates || {}) }
}

export function userVars(user, extra = {}) {
  return letterVars(user, { company: getDb().settings.companyName || 'People', ...extra })
}

export function previewLetter(key, user, extra = {}) {
  const template = getTemplates()[key]
  if (!template) return null
  return renderTemplate(template, userVars(user, extra))
}

export function getJourney(userId) {
  const db = getDb()
  const user = db.users.find((u) => u.id === userId)
  if (!user) return null
  const letters = db.letters.filter((l) => l.userId === userId)
  const documents = db.documents.filter((d) => d.userId === userId)
  const events = (db.workflowEvents || []).filter((e) => e.userId === userId)
  const emails = (db.emails || []).filter((e) => e.userId === userId)
  const nextStep = nextLifecycleStep(user.hrStep)
  const facePending = user.hrStep >= 6 && user.status !== 'exited' && !user.faceDescriptor
  const resignable = canRequestResignation(user)
  const canStartProbation = user.status !== 'exited' && user.hrStep >= 7 && user.hrStep < 11
  const spec = nextStep ? HR_STEPS.find((s) => s.id === nextStep) : null
  const documentRequest = user.documentRequest || null
  const resignation = [...events].reverse().find((e) => e.step === 13 && e.action === 'complete') || null
  const waitingOn = documentRequest?.open
    ? 'employee'
    : spec
      ? spec.actor === 'employee' || spec.actor === 'employee_head'
        ? 'employee'
        : 'hr'
      : null
  return {
    user: publicUser(user),
    steps: HR_STEPS,
    letters,
    documents,
    events,
    emails,
    nextStep,
    facePending,
    canRequestResignation: resignable,
    canStartProbation,
    waitingOn,
    documentRequest,
    resignation,
    templates: getTemplates(),
  }
}

export function listPendingApprovals() {
  const db = getDb()
  const items = []
  for (const user of db.users) {
    if (user.role !== 'employee' || isExited(user)) continue
    const documents = db.documents.filter((d) => d.userId === user.id)
    const events = (db.workflowEvents || []).filter((e) => e.userId === user.id)
    const resignation = [...events].reverse().find((e) => e.step === 13 && e.action === 'complete') || null
    const req = user.documentRequest
    const nextStep = nextLifecycleStep(user.hrStep)
    const spec = nextStep ? HR_STEPS.find((s) => s.id === nextStep) : null
    const inExit = user.hrStep >= 13

    if (req?.open) {
      items.push({
        kind: 'documents',
        priority: inExit ? 0 : 2,
        user: publicUser(user),
        step: { id: 3, key: 'document_resubmit', label: 'Resubmit documents', actor: 'employee' },
        waitingOn: 'employee',
        documents,
        note: req.note || '',
        requestedAt: req.at || null,
      })
    } else if (req?.submitted && (!spec || spec.id !== 4)) {
      items.push({
        kind: 'documents',
        priority: inExit ? 0 : 1,
        user: publicUser(user),
        step: { id: 4, key: 'document_review', label: 'Review resubmitted documents', actor: 'hr' },
        waitingOn: 'hr',
        documents,
        note: req.note || '',
        requestedAt: req.at || null,
      })
    }

    if (canRequestResignation(user) && !req?.open) {
      items.push({
        kind: 'resignation',
        priority: 3,
        user: publicUser(user),
        step: HR_STEPS.find((s) => s.id === 13),
        waitingOn: 'employee',
        documents,
        note: '',
        requestedAt: null,
      })
    }

    if (!spec) continue
    if (req?.open && spec.id === 4) continue
    const waitingOn = spec.actor === 'employee' || spec.actor === 'employee_head' ? 'employee' : 'hr'
    items.push({
      kind: spec.id >= 13 ? 'resignation' : 'workflow',
      priority: spec.id >= 13 ? 0 : waitingOn === 'hr' ? 1 : 2,
      user: publicUser(user),
      step: spec,
      waitingOn,
      documents: spec.id === 4 || spec.id === 16 || spec.id >= 13 ? documents : [],
      note: spec.id >= 13 ? resignation?.note || '' : '',
      requestedAt: spec.id >= 13 ? resignation?.at || null : null,
    })
  }
  return items.sort((a, b) => a.priority - b.priority || a.user.name.localeCompare(b.user.name))
}

function clearDocumentRequest(user, submitted = false) {
  if (!user.documentRequest) return
  user.documentRequest = {
    ...user.documentRequest,
    open: false,
    submitted,
    submittedAt: submitted ? new Date().toISOString() : user.documentRequest.submittedAt,
  }
}

export async function completeStep(user, actor, { skip = false, note = '', documents = [], subject, body, start } = {}) {
  const db = getDb()
  if (isExited(user)) {
    const error = new Error('This person has exited and is inactive')
    error.status = 409
    throw error
  }
  let nextStep = start === 'probation' ? 11 : start === 'resignation' ? 13 : user.hrStep + 1
  if (start === 'probation') {
    if (!isHrRole(actor.role)) {
      const error = new Error('Only HR can start probation review')
      error.status = 403
      throw error
    }
    if (user.hrStep < 7 || user.hrStep >= 11) {
      const error = new Error('This person is not in active employment')
      error.status = 409
      throw error
    }
  }
  if (start === 'resignation') {
    if (actor.sub !== user.id) {
      const error = new Error('The employee must submit the resignation request')
      error.status = 403
      throw error
    }
    if (!canRequestResignation(user)) {
      const error = new Error('Resignation can be submitted after joining, before an exit is already in progress')
      error.status = 409
      throw error
    }
  }
  if (!start && nextStep >= 8 && nextStep <= 10) {
    const error = new Error('Salary and payslips are run from Payroll using attendance. They are not a person stage.')
    error.status = 409
    throw error
  }
  if (nextStep > 18) {
    const error = new Error('Lifecycle already complete')
    error.status = 409
    throw error
  }
  if (actor.role === 'employee' && actor.sub !== user.id) {
    const error = new Error('Not allowed')
    error.status = 403
    throw error
  }
  if (!skip && nextStep === 13 && actor.sub !== user.id) {
    const error = new Error('The employee must submit the resignation request')
    error.status = 403
    throw error
  }
  if (!skip && !canAct(actor.role, nextStep)) {
    const error = new Error('This step belongs to another role')
    error.status = 403
    throw error
  }
  if (skip && !isHrRole(actor.role)) {
    const error = new Error('Only HR can skip a step')
    error.status = 403
    throw error
  }

  if (!skip && nextStep === 3 && documents.length === 0 && !db.documents.some((d) => d.userId === user.id)) {
    const error = new Error('Upload at least one document first')
    error.status = 400
    throw error
  }

  for (const doc of documents) {
    db.documents.push({
      id: randomUUID(),
      userId: user.id,
      name: doc.name || 'Document',
      kind: doc.kind || 'other',
      notes: doc.notes || '',
      createdAt: new Date().toISOString(),
    })
  }

  let letter = null
  let email = null
  const templateKey = LETTER_BY_STEP[nextStep]
  if (!skip && templateKey && templateKey !== 'payslip') {
    const rendered = previewLetter(templateKey, user, { note })
    if (typeof subject === 'string' && subject.trim()) rendered.subject = subject.trim()
    if (typeof body === 'string' && body.trim()) {
      rendered.body = body.trim()
      rendered.html = `<pre style="font-family:Georgia,serif;white-space:pre-wrap;font-size:15px;line-height:1.6">${body
        .trim()
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')}</pre>`
    }
    letter = {
      id: randomUUID(),
      userId: user.id,
      step: nextStep,
      key: templateKey,
      title: HR_STEPS[nextStep - 1].label,
      subject: rendered.subject,
      body: rendered.body,
      html: rendered.html,
      createdAt: new Date().toISOString(),
      createdBy: actor.sub,
    }
    db.letters.push(letter)
    email = await sendStepEmail(user, rendered, templateKey, nextStep)
  }

  const event = {
    id: randomUUID(),
    userId: user.id,
    step: nextStep,
    action: skip ? 'skip' : 'complete',
    note: note || '',
    by: actor.sub,
    role: actor.role,
    at: new Date().toISOString(),
    emailId: email?.id || null,
  }
  db.workflowEvents = db.workflowEvents || []
  db.workflowEvents.push(event)

  user.hrStep = nextStep
  if (nextStep === 18) user.status = 'exited'
  if (nextStep === 7) user.status = 'active'
  if (nextStep === 1) user.status = 'offer'
  if (user.documentRequest) {
    if (nextStep === 3) {
      user.documentRequest = { ...user.documentRequest, open: false, submitted: true, submittedAt: new Date().toISOString() }
    }
    if (nextStep === 4 || nextStep === 16) {
      user.documentRequest = { ...user.documentRequest, open: false, submitted: false }
    }
  }
  saveDb()
  return { user: publicUser(user), letter, email, event, journey: getJourney(user.id) }
}

export async function sendStepEmail(user, rendered, key, step) {
  const result = await sendMail({
    to: user.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.body,
  })
  const row = {
    id: randomUUID(),
    userId: user.id,
    key,
    step,
    to: user.email,
    subject: rendered.subject,
    previewUrl: result.previewUrl,
    mode: result.mode,
    sentAt: new Date().toISOString(),
  }
  const db = getDb()
  db.emails = db.emails || []
  db.emails.push(row)
  saveDb()
  return row
}

export async function issueOffer(user, actor) {
  if (user.hrStep > 0) {
    return { user: publicUser(user), email: null, already: true, journey: getJourney(user.id) }
  }
  return completeStep(user, actor, { skip: false })
}
