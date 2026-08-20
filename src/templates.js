export const TEMPLATE_KEYS = [
  { key: 'offer_letter', label: 'Offer letter', step: 1 },
  { key: 'appointment_letter', label: 'Appointment letter', step: 6 },
  { key: 'confirmation_letter', label: 'Confirmation letter', step: 12 },
  { key: 'relieving_letter', label: 'Experience / relieving letter', step: 18 },
  { key: 'payslip', label: 'Payslip email', step: 10 },
]

export const DEFAULT_TEMPLATES = {
  offer_letter: {
    subject: 'Offer of employment · {{name}}',
    body: `{{company}}
People Operations

Date: {{today}}

Dear {{name}},

We are pleased to offer you employment with {{company}} in {{department}}.

Employee code: {{code}}
Joining date: {{joiningDate}}
Monthly compensation: ₹{{baseSalary}}

Please sign in to People to accept this offer and upload your joining documents.

We look forward to working with you.

Yours sincerely,
{{company}}
People team`,
  },
  appointment_letter: {
    subject: 'Appointment letter · {{name}}',
    body: `{{company}}
Appointment letter

Date: {{today}}

Dear {{name}},

This confirms your appointment with {{company}} as a member of {{department}}, effective {{joiningDate}}.

Employee code: {{code}}
Compensation: ₹{{baseSalary}} per month

Please keep this letter for your records.

Yours sincerely,
{{company}}
People team`,
  },
  confirmation_letter: {
    subject: 'Confirmation of employment · {{name}}',
    body: `{{company}}
Confirmation letter

Date: {{today}}

Dear {{name}},

Following a successful probation review, your employment with {{company}} is confirmed.

Employee code: {{code}}
Department: {{department}}

Yours sincerely,
{{company}}
People team`,
  },
  relieving_letter: {
    subject: 'Experience and relieving letter · {{name}}',
    body: `{{company}}
Experience / Relieving letter

Date: {{today}}

To whom it may concern,

This is to certify that {{name}} ({{code}}) was employed with {{company}} in {{department}} from {{joiningDate}} until {{today}}.

They have been relieved of their duties after completing exit formalities.

Yours sincerely,
{{company}}
People team`,
  },
  payslip: {
    subject: 'Payslip {{month}} · {{name}}',
    body: `{{company}} · Payslip

Employee: {{name}} ({{code}})
Period: {{period}}

Working days: {{workingDays}}
Present days: {{presentDays}}
Leave days: {{leaveDays}}
Gross: ₹{{gross}}
Net pay: ₹{{net}}

This is a system-generated payslip.`,
  },
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function fillTemplate(text, vars) {
  return String(text || '').replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '')
}

export function letterVars(user, extra = {}) {
  const company = extra.company || 'People'
  return {
    name: user.name || '',
    code: user.code || '',
    email: user.email || '',
    department: user.department || 'the organisation',
    joiningDate: user.joiningDate || '',
    baseSalary: String(user.baseSalary ?? 0),
    company,
    today: extra.today || new Date().toISOString().slice(0, 10),
    month: extra.month || extra.period || '',
    from: extra.from || '',
    to: extra.to || '',
    period: extra.period || extra.month || '',
    workingDays: String(extra.workingDays ?? ''),
    presentDays: String(extra.presentDays ?? ''),
    leaveDays: String(extra.leaveDays ?? ''),
    gross: String(extra.gross ?? ''),
    net: String(extra.net ?? ''),
  }
}

export function renderTemplate(template, vars) {
  const subject = fillTemplate(template.subject, vars)
  const body = fillTemplate(template.body, vars)
  const html = `<div style="font-family:Georgia,serif;color:#0b2a4a;max-width:640px;margin:0 auto;padding:32px;background:#fff">
    <pre style="white-space:pre-wrap;font-family:Georgia,serif;font-size:16px;line-height:1.6;margin:0">${escapeHtml(body)}</pre>
  </div>`
  return { subject, body, html }
}
