/**
 * Generic SMS service using Twilio.
 * Runs on the Railway backend (NOT the Vercel frontend).
 *
 * Required environment variables (set in Railway):
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_MESSAGING_SERVICE_SID  (preferred)  OR  TWILIO_FROM_NUMBER
 *
 * Mirrors backend/services/email.js: best-effort, never throws — callers
 * (broadcasts, free-period announcements, profile notifications) treat SMS as
 * fire-and-forget and inspect the returned { ok } flag.
 */

import twilio from 'twilio'
import { createLogger } from '../utils/logger.js'
const log = createLogger('sms')

log.info('[sms] SMS config check', {
  has_account_sid: Boolean(process.env.TWILIO_ACCOUNT_SID),
  has_auth_token: Boolean(process.env.TWILIO_AUTH_TOKEN),
  has_messaging_service: Boolean(process.env.TWILIO_MESSAGING_SERVICE_SID),
  has_from_number: Boolean(process.env.TWILIO_FROM_NUMBER),
})

let _client = null
let _clientKey = null
function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const token = process.env.TWILIO_AUTH_TOKEN?.trim()
  if (!sid || !token) return null
  const key = `${sid}:${token}`
  if (_client && _clientKey === key) return _client
  _clientKey = key
  _client = twilio(sid, token)
  return _client
}

function getFrom() {
  return (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER || '').trim() || null
}

export function isSmsConfigured() {
  return Boolean(getClient() && getFrom())
}

/**
 * Normalize a phone number to E.164 as best we can. US numbers without a
 * country code get +1. Returns null when there clearly aren't enough digits.
 */
export function normalizePhone(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  if (!s) return null
  // Already E.164-ish.
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '')
    return digits.length >= 8 ? `+${digits}` : null
  }
  const digits = s.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`           // US 10-digit
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}` // US with leading 1
  if (digits.length >= 8) return `+${digits}`              // assume already includes country code
  return null
}

/**
 * Single checked Twilio send path. Twilio can RESOLVE (not throw) with a message
 * whose status is failed/undelivered or that carries an errorCode — a bare await
 * would then report a non-delivered message as sent. Returns { ok, sid, error }
 * and never throws for an API-level failure (genuine network throws propagate to
 * the caller's try/catch). Every Twilio messages.create caller routes through
 * here so the delivery-honesty check lives in exactly one place.
 * @param {object} client - a Twilio client
 * @param {object} payload - client.messages.create payload
 * @returns {Promise<{ok: boolean, sid: string|null, error: string|null}>}
 */
export async function sendTwilioMessage(client, payload) {
  const msg = await client.messages.create(payload)
  if (msg?.errorCode || msg?.status === 'failed' || msg?.status === 'undelivered') {
    return { ok: false, sid: msg?.sid || null, error: `twilio_${msg?.errorCode || msg?.status}` }
  }
  return { ok: true, sid: msg?.sid || null, error: null }
}

/**
 * Send a single SMS. Returns { ok, id?, skipped?, error? } and never throws.
 */
export async function sendSms({ to, body } = {}) {
  if (!to || !body) return { ok: false, error: 'to_and_body_required' }
  const client = getClient()
  const from = getFrom()
  if (!client || !from) return { ok: false, skipped: true, error: 'sms_not_configured' }
  const normalized = normalizePhone(to)
  if (!normalized) return { ok: false, error: 'invalid_phone' }

  const payload = { to: normalized, body: String(body) }
  if (process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()) {
    payload.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID.trim()
  } else {
    payload.from = from
  }

  try {
    const { ok, sid, error } = await sendTwilioMessage(client, payload)
    if (!ok) {
      log.warn('[sms] Twilio reported non-delivery', { to: normalized.slice(0, 5) + '***', error })
      return { ok: false, error }
    }
    log.info('[sms] sent', { to: normalized.slice(0, 5) + '***', sid })
    return { ok: true, id: sid }
  } catch (err) {
    log.warn('[sms] send failed', { error: err?.message || String(err) })
    return { ok: false, error: err?.message || String(err) }
  }
}
