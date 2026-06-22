/**
 * Email service using Resend API
 * Runs on Railway backend (NOT Vercel frontend)
 * 
 * Required environment variables (set in Railway):
 * - RESEND_API_KEY: API key from resend.com
 * - FROM_EMAIL or EMAIL_FROM: Sender email address (must be verified domain in Resend)
 * 
 * Optional:
 * - AUTH_ALLOW_ADMIN_PREVIEW_CODE: Set to "true" to enable admin preview codes on email failure
 */

import { Resend } from 'resend'
import { createLogger } from '../utils/logger.js'
const log = createLogger('email')

// Startup diagnostic (runs once at import time during backend boot).
// IMPORTANT: Never log secrets; only log safe presence booleans.
log.info('[email] Email config check', {
  has_resend_key: Boolean(process.env.RESEND_API_KEY),
  has_from_email: Boolean(process.env.FROM_EMAIL || process.env.EMAIL_FROM),
  node_env: process.env.NODE_ENV,
  railway_env: process.env.RAILWAY_ENVIRONMENT,
})

function getResendApiKey() {
  const v = process.env.RESEND_API_KEY
  if (!v) return null
  const s = String(v).trim()
  return s ? s : null
}

function getFromEmail() {
  const v = process.env.FROM_EMAIL || process.env.EMAIL_FROM
  if (!v) return null
  const s = String(v).trim()
  return s ? s : null
}

export class EmailSendError extends Error {
  constructor(message, { provider, status, details } = {}) {
    super(message)
    this.name = 'EmailSendError'
    this.provider = provider || 'unknown'
    this.status = status ?? null
    this.details = details ?? null
  }
}

// Create a shared Resend client instance.
let resendClient = null
let resendClientKey = null

export function isEmailServiceConfigured() {
  // Required and sufficient:
  // - RESEND_API_KEY exists
  // - FROM_EMAIL or EMAIL_FROM exists
  // Do not cache across requests; env presence is checked at call time.
  return Boolean(getResendApiKey() && getFromEmail())
}

function getResend() {
  const key = getResendApiKey()
  if (!key) {
    return null
  }

  if (resendClient && resendClientKey === key) {
    return resendClient
  }

  resendClientKey = key
  resendClient = new Resend(key)
  return resendClient
}

/**
 * Generic send with cc support. Returns { ok, id?, skipped?, error? } and never
 * throws — callers (invoicing, dunning) treat email as best-effort. `from`
 * defaults to FROM_EMAIL; `cc` accepts a string or array.
 */
export async function sendEmail({ to, cc = null, subject, html, text, from = null, replyTo = null } = {}) {
  if (!to || !subject) return { ok: false, error: 'to_and_subject_required' }
  const resend = getResend()
  if (!resend || !getFromEmail()) return { ok: false, skipped: true, error: 'email_not_configured' }
  try {
    const payload = {
      from: from || getFromEmail(),
      to: Array.isArray(to) ? to : [to],
      subject: String(subject),
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
    }
    if (cc) payload.cc = Array.isArray(cc) ? cc : [cc]
    if (replyTo) {
      // Support both Resend SDK key spellings across versions.
      payload.replyTo = replyTo
      payload.reply_to = replyTo
    }
    const result = await resend.emails.send(payload)
    return { ok: true, id: result?.data?.id || result?.id || null }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export async function sendVerificationEmail(email, code) {
  if (!email) return false
  if (!code) return false
  if (!isEmailServiceConfigured()) return false

  try {
    const resend = getResend()
    if (!resend) return false

    const from = getFromEmail()
    if (!from) return false

    // The sign-in URL points at the public GrantFlow landing page on the
    // Axiom Biolabs website (configurable, but defaults there on purpose so
    // every sign-in email also drives traffic to the marketing site).
    const signInUrl = String(process.env.GRANTFLOW_SIGNIN_URL || 'https://www.axiombiolabs.org/grantflow').trim()
    const safeSignInUrl = signInUrl
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    const subject = 'Your GrantFlow Verification Code'
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>GrantFlow Login Verification</h2>
        <p>Your verification code is:</p>
        <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">
          ${String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}
        </div>
        <p>This code will expire in 10 minutes.</p>
        <p style="margin: 24px 0;">
          <a href="${safeSignInUrl}" style="display: inline-block; padding: 12px 18px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">
            Sign in to GrantFlow
          </a>
        </p>
        <p style="font-size: 13px; color: #475569;">Or copy and paste this link into your browser:<br />
          <a href="${safeSignInUrl}" style="color: #2563eb;">${safeSignInUrl}</a>
        </p>
        <p>If you didn't request this code, you can safely ignore this email.</p>
      </div>
    `
    const text = `Your GrantFlow verification code is: ${code}\n\nThis code will expire in 10 minutes.\n\nSign in here: ${signInUrl}\n\nIf you didn't request this code, you can safely ignore this email.`

    const result = await resend.emails.send({
      from,
      to: email,
      subject,
      html,
      text,
    })

    if (result?.error) {
      console.error('[email/sendVerificationEmail] Resend API error:', {
        error: result.error,
        to: email,
        provider: 'resend',
        runtime: 'railway',
      })
      return false
    }

    return true
  } catch (error) {
    console.error('[email] Failed to send verification email:', error?.message)
    return false
  }
}

export async function sendPasswordSetupEmail(email, link) {
  if (!email) return false
  if (!link) return false
  if (!isEmailServiceConfigured()) return false

  try {
    const resend = getResend()
    if (!resend) return false

    const from = getFromEmail()
    if (!from) return false

    const subject = 'Set your GrantFlow password'
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Set your GrantFlow password</h2>
        <p>To finish signing in, set a password using this one-time link:</p>
        <p style="margin: 20px 0;">
          <a href="${link.replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" style="display: inline-block; padding: 12px 16px; background: #0f172a; color: #fff; text-decoration: none; border-radius: 8px;">
            Set password
          </a>
        </p>
        <p>If the button doesn't work, copy and paste this URL:</p>
        <pre style="white-space: pre-wrap; word-break: break-all; background-color: #f5f5f5; padding: 12px; border-radius: 8px;">${link.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</pre>
        <p>This link expires in 30 minutes and can only be used once.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      </div>
    `
    const text =
      `Set your GrantFlow password using this one-time link:\n\n${link}\n\n` +
      `This link expires in 30 minutes and can only be used once.\n\n` +
      `If you didn't request this, you can safely ignore this email.`

    const result = await resend.emails.send({
      from,
      to: email,
      subject,
      html,
      text,
    })

    if (result?.error) {
      const status = result?.error?.statusCode ?? result?.error?.status ?? null
      const message = result?.error?.message ?? String(result.error)
      console.error('[email/sendPasswordSetupEmail] Resend API error:', {
        status,
        message,
        to: email,
        provider: 'resend',
        runtime: 'railway',
      })
      throw new EmailSendError('Resend email delivery failed', {
        provider: 'resend',
        status,
        details: { message },
      })
    }

    return true
  } catch (error) {
    if (error instanceof EmailSendError) throw error
    console.error('[email/sendPasswordSetupEmail] Unexpected send error:', error?.message || String(error))
    throw new EmailSendError('Email delivery failed', {
      provider: 'resend',
      status: null,
      details: { message: error?.message || String(error) },
    })
  }
}

export async function sendAuthAttemptNotification({ event, identifier, success, error }) {
  // Only send notifications if explicitly enabled and admin email is configured
  const shouldNotify = process.env.AUTH_NOTIFY_ON_LOGIN === 'true'
  const notifyEmail = process.env.AUTH_NOTIFY_EMAIL || process.env.ADMIN_EMAIL

  if (!shouldNotify || !notifyEmail) {
    return false
  }

  if (!isEmailServiceConfigured()) {
    return false
  }

  try {
    const resend = getResend()
    if (!resend) return false

    const from = getFromEmail()
    if (!from) return false

    const statusEmoji = success ? '✅' : '❌'
    const subject = `${statusEmoji} Auth Event: ${event}`

    await resend.emails.send({
      from,
      to: notifyEmail,
      subject,
      html: `
        <div style="font-family: monospace;">
          <h3>Authentication Event</h3>
          <ul>
            <li><strong>Event:</strong> ${String(event).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</li>
            <li><strong>Identifier:</strong> ${String(identifier).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</li>
            <li><strong>Success:</strong> ${String(success).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</li>
            ${error ? `<li><strong>Error:</strong> ${String(error).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</li>` : ''}
            <li><strong>Time:</strong> ${new Date().toISOString()}</li>
          </ul>
        </div>
      `,
      text: `Auth Event: ${event}\nIdentifier: ${identifier}\nSuccess: ${success}${error ? `\nError: ${error}` : ''}\nTime: ${new Date().toISOString()}`,
    })

    return true
  } catch (e) {
    console.warn('[email/sendAuthAttemptNotification] Failed to send notification:', e?.message || e)
    return false
  }
}

export async function sendApplicationEmail(toEmail, applicationData) {
  if (!toEmail) {
    console.error('[email/sendApplicationEmail] Missing recipient email address')
    throw new Error('Cannot send application email: recipient email address is required')
  }
  const resend = getResend()

  if (!resend) {
    const errorMsg = 'Email service not available. Cannot send application email without Resend configuration.'
    console.error('[email/sendApplicationEmail]', errorMsg, '(provider: resend, runtime: railway)')
    throw new Error(errorMsg)
  }

  const from = getFromEmail()
  if (!from) {
    const errorMsg = 'Email service not configured. Missing/invalid FROM_EMAIL (or EMAIL_FROM).'
    console.error('[email/sendApplicationEmail]', errorMsg)
    throw new Error(errorMsg)
  }

  try {
    await resend.emails.send({
      from,
      to: toEmail,
      subject: 'GrantFlow Application Submitted',
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Application Submitted Successfully</h2>
          <p>Your application has been received.</p>
          <pre>${JSON.stringify(applicationData, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</pre>
        </div>
      `,
      text: `Your GrantFlow application has been submitted.\n\n${JSON.stringify(applicationData, null, 2)}`,
    })

    log.info('[email/sendApplicationEmail] Application email sent', {
      to: toEmail,
      provider: 'resend',
      runtime: 'railway',
    })

    return true
  } catch (error) {
    console.error('[email/sendApplicationEmail] Failed to send:', {
      error: error.message,
      to: toEmail,
      provider: 'resend',
      runtime: 'railway',
    })
    throw new Error(`Failed to send application email: ${error.message}`)
  }
}

export async function sendServiceApplicationEmail(toEmail, applicationData) {
  return sendApplicationEmail(toEmail, applicationData)
}
