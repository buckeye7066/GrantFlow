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

const RESEND_API_KEY = process.env.RESEND_API_KEY || null
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.EMAIL_FROM || null

// Resolve sender address for Resend.
// In production-like environments, a missing/invalid sender should be treated as "not configured"
// to avoid silent delivery failures.
function resolveFromEmail() {
  const raw = FROM_EMAIL
  if (!raw) return null
  const v = String(raw).trim()
  if (!v) return null

  // Common misconfiguration: users paste KEY=VALUE into the value field.
  if (v.includes('FROM_EMAIL=')) return null

  // Resend's onboarding sender is only for examples; do not use it as a fallback in production.
  if (v.toLowerCase().includes('onboarding@resend.dev')) return null

  return v
}

// Create a shared Resend client instance.
let resendClient = null

export function isEmailServiceConfigured() {
  // Require api key. Also require a from email address.
  // Without a real sender, most providers will reject or silently drop messages.
  return Boolean(RESEND_API_KEY && resolveFromEmail())
}

function getResend() {
  if (!RESEND_API_KEY) {
    return null
  }

  if (resendClient) {
    return resendClient
  }

  resendClient = new Resend(RESEND_API_KEY)
  return resendClient
}

export async function sendVerificationEmail(email, code) {
  if (!email) return false
  if (!code) return false
  if (!isEmailServiceConfigured()) return false

  try {
    const resend = getResend()
    if (!resend) return false

    const from = resolveFromEmail()
    if (!from) return false

    const subject = 'Your GrantFlow Verification Code'
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>GrantFlow Login Verification</h2>
        <p>Your verification code is:</p>
        <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">
          ${code}
        </div>
        <p>This code will expire in 10 minutes.</p>
        <p>If you didn't request this code, you can safely ignore this email.</p>
      </div>
    `
    const text = `Your GrantFlow verification code is: ${code}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`

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

    const from = resolveFromEmail()
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
            <li><strong>Event:</strong> ${event}</li>
            <li><strong>Identifier:</strong> ${identifier}</li>
            <li><strong>Success:</strong> ${success}</li>
            ${error ? `<li><strong>Error:</strong> ${error}</li>` : ''}
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
  const resend = getResend()

  if (!resend) {
    const errorMsg = 'Email service not available. Cannot send application email without Resend configuration.'
    console.error('[email/sendApplicationEmail]', errorMsg, '(provider: resend, runtime: railway)')
    throw new Error(errorMsg)
  }

  const from = resolveFromEmail()
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
          <pre>${JSON.stringify(applicationData, null, 2)}</pre>
        </div>
      `,
      text: `Your GrantFlow application has been submitted.\n\n${JSON.stringify(applicationData, null, 2)}`,
    })

    console.info('[email/sendApplicationEmail] Application email sent', {
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
