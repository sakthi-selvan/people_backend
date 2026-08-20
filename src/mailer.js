import nodemailer from 'nodemailer'
import { getDb, saveDb } from './store.js'

export async function getTransport() {
  const settings = getDb().settings
  const smtp = settings.smtp || {}

  if (settings.emailMode === 'smtp' && smtp.host && smtp.user) {
    return {
      transporter: nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port || 587),
        secure: Boolean(smtp.secure),
        auth: { user: smtp.user, pass: smtp.pass },
      }),
      from: smtp.from || 'People <people@example.com>',
      mode: 'smtp',
    }
  }

  if (!settings.ethereal) {
    const account = await nodemailer.createTestAccount()
    settings.ethereal = {
      user: account.user,
      pass: account.pass,
      smtp: account.smtp,
    }
    saveDb()
  }

  const eth = settings.ethereal
  return {
    transporter: nodemailer.createTransport({
      host: eth.smtp?.host || 'smtp.ethereal.email',
      port: eth.smtp?.port || 587,
      secure: false,
      auth: { user: eth.user, pass: eth.pass },
    }),
    from: smtp.from || `People <${eth.user}>`,
    mode: 'ethereal',
  }
}

export async function sendMail({ to, subject, html, text }) {
  const { transporter, from, mode } = await getTransport()
  const info = await transporter.sendMail({ from, to, subject, html, text })
  const previewUrl = nodemailer.getTestMessageUrl(info)
  return { messageId: info.messageId, previewUrl, mode }
}
