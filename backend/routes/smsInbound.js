/**
 * smsInbound.js — Twilio inbound-SMS webhook.
 *
 * Mounted at /api/sms/inbound (Twilio "A MESSAGE COMES IN" webhook). Twilio
 * POSTs application/x-www-form-urlencoded with at least { From, Body }. We:
 *   1. Optionally verify the request really came from Twilio (X-Twilio-Signature
 *      against TWILIO_AUTH_TOKEN) — only enforced when validation is available
 *      AND not explicitly disabled, so a misconfigured signing secret can't lock
 *      out legitimate replies in non-prod.
 *   2. Parse From + Body, classify the consent intent, and update every
 *      profile_phones row that matches the normalized number.
 *   3. Reply with a short TwiML confirmation (opt-in / opt-out / neutral).
 *
 * Compliance: STOP/UNSUBSCRIBE/etc. ALWAYS opts out; START/YES re-subscribes —
 * see smsConsentService.classifyConsentReply. The handler never exposes
 * internals on error: any failure still returns a benign 200 + empty TwiML so
 * Twilio doesn't retry-storm, and the error is logged server-side only.
 *
 * This router is mounted BEFORE express.json() with its own urlencoded parser
 * (Twilio doesn't send JSON), mirroring the Stripe webhook mount.
 */

import express from 'express'
import twilio from 'twilio'
import { applyInboundReply, optInConfirmationBody, optOutConfirmationBody, unknownReplyBody } from '../services/comms/smsConsentService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:sms-inbound')
const router = express.Router()

// Twilio sends form-encoded; parse it locally so this can mount before the
// global JSON parser without consuming the body twice.
router.use(express.urlencoded({ extended: false }))

/** Should we enforce Twilio signature validation for this request? */
function shouldValidate() {
  if (String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase() === 'false') return false
  // Validation needs the auth token (the signing secret). If it's absent we
  // can't validate — we log and allow (so dev/test still works), but in prod the
  // token IS set, so validation runs.
  return Boolean(process.env.TWILIO_AUTH_TOKEN?.trim())
}

function isValidTwilioRequest(req) {
  try {
    const token = process.env.TWILIO_AUTH_TOKEN?.trim()
    if (!token) return false
    const signature = req.header('X-Twilio-Signature') || ''
    // Reconstruct the full public URL Twilio signed. Honor the proxy headers
    // Railway sets so the scheme/host match what Twilio used.
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const base = process.env.TWILIO_PUBLIC_BASE_URL?.trim() || `${proto}://${host}`
    const url = `${base.replace(/\/$/, '')}${req.originalUrl}`
    return twilio.validateRequest(token, signature, url, req.body || {})
  } catch (err) {
    log.warn('twilio signature validation threw', { error: err?.message })
    return false
  }
}

router.post('/inbound', async (req, res) => {
  // Default response: empty TwiML (acknowledge, say nothing).
  const respondTwiml = (message) => {
    const twiml = new twilio.twiml.MessagingResponse()
    if (message) twiml.message(message)
    res.set('Content-Type', 'text/xml').status(200).send(twiml.toString())
  }

  try {
    if (shouldValidate() && !isValidTwilioRequest(req)) {
      // Do not reveal why — just reject. Twilio won't retry a 403.
      log.warn('rejected inbound SMS: invalid Twilio signature')
      return res.status(403).send('Forbidden')
    }

    const from = req.body?.From || req.body?.from || null
    const body = req.body?.Body || req.body?.body || ''
    if (!from) return respondTwiml(null)

    const result = await applyInboundReply(req.db, { from, body })
    // Confirmation copy is rendered in the matched profile's language (result.lang,
    // defaults to 'en' when the number maps to no profile / no stored preference).
    const lang = result.lang || 'en'
    if (result.intent === 'opt_in') return respondTwiml(optInConfirmationBody(lang))
    if (result.intent === 'opt_out') return respondTwiml(optOutConfirmationBody(lang))
    // Unknown reply — acknowledge without changing state. Keep it short + neutral.
    return respondTwiml(unknownReplyBody(lang))
  } catch (err) {
    // Never leak internals; log server-side, ack with empty TwiML.
    log.error('inbound SMS handler failed', { error: err?.message })
    return respondTwiml(null)
  }
})

export default router
