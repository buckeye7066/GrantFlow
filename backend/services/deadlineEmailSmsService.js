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
import { createLogger } from '../utils/logger.js'
import { t, dayLabel as localizedDayLabel } from './comms/commsMessages.js'
import { getUserLanguage } from './comms/profileLanguage.js'
import { grantFlowLinkFooterHtml, grantFlowLinkFooterText, sendResendEmail } from './email.js'
const log = createLogger('deadlineEmailSmsService')

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

export async function sendDeadlineEmail(email, { grantTitle, daysRemaining, deadline, lang = 'en' }) {
  const resend = getResend()
  const from = getFromEmail()
  if (!resend || !from || !email) return false

  // All copy localized to the recipient's language (defaults to English).
  const dayLabel = localizedDayLabel(lang, daysRemaining)
  const subject = t(lang, 'deadline_email_subject', { dayLabel, grantTitle })
  const introHtml = t(lang, 'deadline_email_body_intro', {
    grantTitle: `<strong>${escapeHtml(grantTitle)}</strong>`,
    dayLabel: `<strong>${escapeHtml(dayLabel)}</strong>`,
    deadline: escapeHtml(deadline),
  })

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1e293b; margin-bottom: 8px;">${escapeHtml(t(lang, 'deadline_email_heading'))}</h2>
      <p style="color: #475569; font-size: 15px; line-height: 1.6;">
        ${introHtml}
      </p>
      ${daysRemaining === 1
        ? `<p style="color: #dc2626; font-weight: 600;">${escapeHtml(t(lang, 'deadline_email_body_final'))}</p>`
        : `<p style="color: #475569; font-size: 15px;">${escapeHtml(t(lang, 'deadline_email_body_review'))}</p>`
      }
      <div style="margin-top: 24px;">
        <a href="${escapeHtml(process.env.GRANTFLOW_APP_BASE_URL || 'https://app.axiombiolabs.org')}/Pipeline"
           style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
          ${escapeHtml(t(lang, 'deadline_email_cta'))}
        </a>
      </div>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 32px;">
        ${escapeHtml(t(lang, 'deadline_email_footer'))}
      </p>
      ${grantFlowLinkFooterHtml()}
    </div>
  `

  try {
    // Resend resolves (not throws) on API rejection — route through the checked
    // helper so a rejected send is reported as failed, not logged as 'Sent'.
    const { ok, error } = await sendResendEmail(resend, {
      from,
      to: email,
      subject,
      html,
      text: `${t(lang, 'deadline_email_heading')}${grantFlowLinkFooterText()}`,
    })
    if (!ok) {
      console.warn('[deadline-email] Resend API error:', error)
      return false
    }
    log.info('[deadline-email] Sent to', email, '—', grantTitle)
    return true
  } catch (err) {
    console.warn('[deadline-email] Failed:', err.message)
    return false
  }
}

// ── SMS ─────────────────────────────────────────────────────────────────────

export async function sendDeadlineSms(phone, { grantTitle, daysRemaining, lang = 'en' }) {
  const client = getTwilio()
  const from = getTwilioFrom()
  if (!client || !from || !phone) return false

  const dayLabel = localizedDayLabel(lang, daysRemaining)
  const body = t(lang, 'deadline_sms', { dayLabel, grantTitle: truncate(grantTitle, 80) })

  const payload = { to: phone, body }
  if (process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()) {
    payload.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID.trim()
  } else {
    payload.from = from
  }

  try {
    const msg = await client.messages.create(payload)
    // Twilio can RESOLVE with a failed/undelivered message (errorCode set)
    // rather than throwing — don't report those as sent.
    if (msg?.errorCode || msg?.status === 'failed' || msg?.status === 'undelivered') {
      console.warn('[deadline-sms] Twilio reported failure:', msg?.errorCode || msg?.status)
      return false
    }
    log.info('[deadline-sms] Sent to', phone.slice(0, 4) + '***')
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
 * @param {string} [params.lang] preferred language; resolved from the user's
 *   profile when omitted (defaults to 'en').
 */
export async function dispatchDeadlineAlerts(db, { userId, userEmail, userPhone, grantTitle, daysRemaining, deadline, lang = null }) {
  // Check user preferences
  let prefs = null
  try {
    prefs = await db.prepare('SELECT email_notifications FROM user_preferences WHERE user_id = ?').get(userId)
  } catch { /* table may not exist yet */ }

  const emailOptIn = prefs?.email_notifications !== 0 // default true if no prefs row

  // Resolve the recipient's language (from any of their profiles) unless the
  // caller already supplied it. Best-effort — defaults to 'en'.
  const recipientLang = lang || (await getUserLanguage(db, userId))
  const context = { grantTitle, daysRemaining, deadline, lang: recipientLang }

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
