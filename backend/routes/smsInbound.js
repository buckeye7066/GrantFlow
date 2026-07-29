/**
 * Twilio inbound SMS webhook.
 *
 * Production is fail-closed: a configured SMS integration must have a signing
 * token, and TWILIO_VALIDATE_SIGNATURE=false is ignored. MessageSid is recorded
 * before consent mutation so provider retries are idempotent.
 */

import express from 'express'
import twilio from 'twilio'
import {
  applyInboundReply,
  optInConfirmationBody,
  optOutConfirmationBody,
  unknownReplyBody,
} from '../services/comms/smsConsentService.js'
import { twilioWebhookPosture } from '../services/twilioWebhookSecurity.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:sms-inbound')

export async function recordInboundMessageOnce(db, messageSid) {
  const sid = String(messageSid || '').trim()
  if (!sid) return { accepted: false, reason: 'missing_message_sid' }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS sms_inbound_webhook_events (
      message_sid TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    )
  `).run()

  try {
    await db.prepare(`
      INSERT INTO sms_inbound_webhook_events (message_sid, received_at)
      VALUES (?, ?)
    `).run(sid, new Date().toISOString())
    return { accepted: true, duplicate: false }
  } catch (error) {
    const message = String(error?.message || error).toLowerCase()
    if (message.includes('unique') || message.includes('duplicate') || message.includes('primary key')) {
      return { accepted: false, duplicate: true }
    }
    throw error
  }
}

function publicRequestUrl(req, env) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const base = String(env.TWILIO_PUBLIC_BASE_URL || '').trim() || `${proto}://${host}`
  return `${base.replace(/\/$/, '')}${req.originalUrl}`
}

export function createSmsInboundRouter({
  env = process.env,
  validateRequest = twilio.validateRequest,
  applyReply = applyInboundReply,
} = {}) {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false }))

  router.post('/inbound', async (req, res) => {
    const respondTwiml = (message) => {
      const twiml = new twilio.twiml.MessagingResponse()
      if (message) twiml.message(message)
      return res.set('Content-Type', 'text/xml').status(200).send(twiml.toString())
    }

    try {
      const posture = twilioWebhookPosture(env)
      const token = String(env.TWILIO_AUTH_TOKEN || '').trim()

      if (posture.production && !token) {
        log.error('Twilio inbound webhook unavailable: signing token missing')
        return res.status(503).send('Service Unavailable')
      }

      if (posture.validation_required) {
        let valid = false
        try {
          const signature = req.header('X-Twilio-Signature') || ''
          valid = Boolean(validateRequest(token, signature, publicRequestUrl(req, env), req.body || {}))
        } catch (error) {
          log.warn('Twilio signature validation threw', { error: error?.message })
        }
        if (!valid) {
          log.warn('rejected inbound SMS: invalid Twilio signature')
          return res.status(403).send('Forbidden')
        }
      }

      const messageSid = req.body?.MessageSid || req.body?.SmsSid || null
      if (posture.production && !messageSid) {
        return res.status(400).send('Bad Request')
      }
      if (messageSid) {
        const replay = await recordInboundMessageOnce(req.db, messageSid)
        if (replay.duplicate) return respondTwiml(null)
      }

      const from = req.body?.From || req.body?.from || null
      const body = req.body?.Body || req.body?.body || ''
      if (!from) return respondTwiml(null)

      const result = await applyReply(req.db, { from, body })
      const lang = result.lang || 'en'
      if (result.intent === 'opt_in') return respondTwiml(optInConfirmationBody(lang))
      if (result.intent === 'opt_out') return respondTwiml(optOutConfirmationBody(lang))
      return respondTwiml(unknownReplyBody(lang))
    } catch (error) {
      log.error('inbound SMS handler failed', { error: error?.message })
      return respondTwiml(null)
    }
  })

  return router
}

export default createSmsInboundRouter()
