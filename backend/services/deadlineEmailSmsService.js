/**
 * Deadline Email & SMS Notification Service
 *
 * Sends email (via Resend) and SMS (via Twilio) alerts when grant deadlines
 * approach. Respects user_preferences.email_notifications opt-in.
 *
 * Called by deadlineNotificationService.js after creating in-app notifications.
 */

import { Resend } from 'resend'
import twilio from 'twilio'

// ── Configuration (lazy, from env) ──────────────────────────────────────────

function getResend() {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key) return null
  return new Resend(key)
}

function getFromEmail() {
  return (process.env.FROM_EMAIL || process.env.EMAIL_FROM || '').trim() || null
}

let _twilioClient = null
function getTwilio() {
  if (_twilioClient) return _twilioClient
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const token = process.env.TWILIO_AUTH_TOKEN?.trim()
  if (!sid || !token) return null
  _twilioClient = twilio(sid, token)
  return _twilioClient
}

function getTwilioFrom() {
  return (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER || '').trim() || null
}

// ── Email ───────────────────────────────────────────────────────────────────

export async function sendDeadlineEmail(email, { grantTitle, daysRemaining, deadline }) {
  const resend = getResend()
  const from = getFromEmail()
  if (!resend || !from || !email) return false

  const dayLabel = daysRemaining === 1 ? 'tomorrow' : `in ${daysRemaining} days`
  const subject = `Deadline ${dayLabel}: ${grantTitle}`

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1e293b; margin-bottom: 8px;">Grant Deadline Approaching</h2>
      <p style="color: #475569; font-size: 15px; line-height: 1.6;">
        The deadline for <strong>${escapeHtml(grantTitle)}</strong> is <strong>${dayLabel}</strong>
        (${escapeHtml(deadline)}).
      </p>
      ${daysRemaining === 1
        ? '<p style="color: #dc2626; font-weight: 600;">This is your final reminder. Make sure your application is ready to submit.</p>'
        : '<p style="color: #475569; font-size: 15px;">Log in to GrantFlow to review your application and submit before the deadline.</p>'
      }
      <div style="margin-top: 24px;">
        <a href="${process.env.CORS_ORIGIN || 'https://grantflow.app'}/Pipeline"
           style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
          View in GrantFlow
        </a>
      </div>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 32px;">
        You're receiving this because you have deadline email reminders enabled in GrantFlow.
        Update your preferences in Settings to opt out.
      </p>
    </div>
  `

  try {
    await resend.emails.send({ from, to: email, subject, html })
    console.info('[deadline-email] Sent to', email, '—', grantTitle)
    return true
  } catch (err) {
    console.warn('[deadline-email] Failed:', err.message)
    return false
  }
}

// ── SMS ─────────────────────────────────────────────────────────────────────

export async function sendDeadlineSms(phone, { grantTitle, daysRemaining }) {
  const client = getTwilio()
  const from = getTwilioFrom()
  if (!client || !from || !phone) return false

  const dayLabel = daysRemaining === 1 ? 'TOMORROW' : `in ${daysRemaining} days`
  const body = `GrantFlow: Deadline ${dayLabel} for "${truncate(grantTitle, 80)}". Log in to review your application.`

  const payload = { to: phone, body }
  if (process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()) {
    payload.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID.trim()
  } else {
    payload.from = from
  }

  try {
    await client.messages.create(payload)
    console.info('[deadline-sms] Sent to', phone.slice(0, 4) + '***')
    return true
  } catch (err) {
    console.warn('[deadline-sms] Failed:', err.message)
    return false
  }
}

// ── Dispatch: called after in-app notification is created ───────────────────

/**
 * Send email and/or SMS for a deadline notification.
 * Checks user_preferences for opt-in before sending.
 *
 * @param {object} db
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.userEmail
 * @param {string} params.userPhone
 * @param {string} params.grantTitle
 * @param {number} params.daysRemaining
 * @param {string} params.deadline
 */
export async function dispatchDeadlineAlerts(db, { userId, userEmail, userPhone, grantTitle, daysRemaining, deadline }) {
  // Check user preferences
  let prefs = null
  try {
    prefs = await db.prepare('SELECT email_notifications FROM user_preferences WHERE user_id = ?').get(userId)
  } catch { /* table may not exist yet */ }

  const emailOptIn = prefs?.email_notifications !== 0 // default true if no prefs row

  const context = { grantTitle, daysRemaining, deadline }

  if (emailOptIn && userEmail) {
    await sendDeadlineEmail(userEmail, context)
  }

  // SMS: only for 1-day threshold (final warning) to avoid over-messaging
  if (daysRemaining === 1 && userPhone) {
    await sendDeadlineSms(userPhone, context)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(str, len) {
  const s = String(str || '')
  return s.length > len ? s.slice(0, len - 1) + '…' : s
}
