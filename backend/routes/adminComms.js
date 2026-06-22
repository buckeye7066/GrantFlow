/**
 * adminComms.js — owner-initiated outbound messaging.
 *
 * Mounted at /api/admin/comms. Every route is admin-only (ensureAuth +
 * ensureAdmin). Powers the Broadcast screen: list all profiles + their
 * email/phone contacts, send a promotional/notification message (email via the
 * dr.johnwhite alias, SMS via Twilio), manage SMS phones + opt-in, and flag an
 * email as a proxy (belongs to someone else).
 */

import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { formatError } from '../middleware/errorHandler.js'
import {
  listProfileContacts,
  sendBroadcast,
  addProfilePhone,
  setPhoneOptIn,
  removeProfilePhone,
  setEmailProxy,
  ensureCommsSchema,
} from '../services/comms/commsService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:admin-comms')
const router = express.Router()

router.use(ensureAuth)
router.use(ensureAdmin)

function actor(req) {
  return req.user?.email ?? req.user?.primary_email ?? req.user?.userId ?? 'admin'
}

// All profiles + their resolved email/phone contacts (for the recipient table).
router.get('/recipients', async (req, res) => {
  try {
    const recipients = await listProfileContacts(req.db)
    res.json({ recipients })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Send a broadcast to the selected profiles.
// Body: { profileIds: [...], channel: 'email'|'sms'|'auto', subject, body }
router.post('/broadcast', async (req, res) => {
  try {
    const { profileIds, channel = 'auto', subject = null, body = null } = req.body ?? {}
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one recipient' })
    }
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message body is required' })
    if (channel !== 'sms' && (!subject || !String(subject).trim())) {
      return res.status(400).json({ error: 'Subject is required for email' })
    }
    const result = await sendBroadcast(req.db, {
      profileIds: profileIds.map(String),
      channel,
      subject: subject ? String(subject) : null,
      body: String(body),
      sentBy: actor(req),
      kind: 'broadcast',
    })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    log.error('broadcast failed', { error: error?.message })
    res.status(500).json(formatError(error))
  }
})

// Add / update an SMS phone for a profile (admin captures consent verbally).
router.post('/phones', async (req, res) => {
  try {
    const { profileId, phone, label = null, optIn = true } = req.body ?? {}
    if (!profileId || !phone) return res.status(400).json({ error: 'profileId and phone are required' })
    const result = await addProfilePhone(req.db, { profileId: String(profileId), phone: String(phone), label, optIn: optIn !== false, addedBy: actor(req) })
    // If the admin did NOT capture explicit consent (optIn=false → 'none'),
    // enqueue the SMS consent ask so this number gets the same opt-in flow.
    if (result.ok && result.consent_status === 'none') {
      try {
        const { requestConsentForProfile } = await import('../services/comms/smsConsentService.js')
        requestConsentForProfile(req.db, { profileId: String(profileId) }).catch(() => {})
      } catch { /* best-effort */ }
    }
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Toggle a phone's opt-in.
router.post('/phones/optin', async (req, res) => {
  try {
    const { profileId, phone, optIn } = req.body ?? {}
    if (!profileId || !phone) return res.status(400).json({ error: 'profileId and phone are required' })
    const result = await setPhoneOptIn(req.db, { profileId: String(profileId), phone: String(phone), optIn: Boolean(optIn) })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Remove a phone.
router.post('/phones/remove', async (req, res) => {
  try {
    const { profileId, phone } = req.body ?? {}
    if (!profileId || !phone) return res.status(400).json({ error: 'profileId and phone are required' })
    const result = await removeProfilePhone(req.db, { profileId: String(profileId), phone: String(phone) })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Flag/unflag an email as a proxy (belongs to someone else — e.g. a relative).
router.post('/email-proxy', async (req, res) => {
  try {
    const { profileId, email, isProxy } = req.body ?? {}
    if (!profileId || !email) return res.status(400).json({ error: 'profileId and email are required' })
    const result = await setEmailProxy(req.db, { profileId: String(profileId), email: String(email), isProxy: Boolean(isProxy) })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Hamilton weekly digest — run now (drafts per-profile updates into the owner
// mailbox) and read the last run's status. Visible to the owner + Anya owner
// tools + Sam diagnostics.
router.post('/hamilton-digest/run', async (req, res) => {
  try {
    const { runHamiltonWeeklyDigest } = await import('../services/hamilton/hamiltonWeeklyDigest.js')
    const profileIds = Array.isArray(req.body?.profileIds) ? req.body.profileIds.map(String) : null
    const summary = await runHamiltonWeeklyDigest(req.db, { force: true, profileIds })
    res.json(summary)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.get('/hamilton-digest/status', async (req, res) => {
  try {
    let lastRun = null
    let summary = null
    try {
      const r1 = await req.db.prepare('SELECT value FROM system_kv WHERE key = ?').get('hamilton_weekly_digest_last_run')
      lastRun = r1?.value || null
      const r2 = await req.db.prepare('SELECT value FROM system_kv WHERE key = ?').get('hamilton_weekly_digest_last_run_summary')
      summary = r2?.value ? JSON.parse(r2.value) : null
    } catch { /* system_kv may not exist until first run */ }
    const { isWeeklyDigestEnabled } = await import('../services/hamilton/hamiltonWeeklyDigest.js')
    res.json({ enabled: isWeeklyDigestEnabled(), last_run_week: lastRun, last_summary: summary })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Robert email-contact lead scan — run now + read whether it's enabled. Robert
// finds LEADS only in the owner's email contacts and hands them to John.
router.post('/robert-contacts/scan', async (req, res) => {
  try {
    const { runContactScanForRobert } = await import('../services/robert/robertContactDiscovery.js')
    const summary = await runContactScanForRobert(req.db, { force: true })
    res.json(summary)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.get('/robert-contacts/status', async (req, res) => {
  try {
    const { isContactScanEnabled } = await import('../services/robert/robertContactDiscovery.js')
    let pendingLeads = null
    try {
      const r = await req.db.prepare(
        `SELECT COUNT(*) AS c FROM robert_source_candidates WHERE discovered_by = 'robert_contacts'`,
      ).get()
      pendingLeads = Number(r?.c || 0)
    } catch { /* table may not exist yet */ }
    res.json({ enabled: isContactScanEnabled(), tagged_contact_leads: pendingLeads })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// ── SMS consent campaign (the "is it ok to text you?" opt-in flow) ──────────
//
// CRITICAL SAFETY: the campaign DEFAULTS TO DRY-RUN. It previews who WOULD be
// texted and sends nothing unless the caller passes confirm:true (or send:true).
// It never texts a blocklisted/suppressed number and never re-asks a number that
// is already pending/opted_in/opted_out.
router.post('/sms-consent/campaign', async (req, res) => {
  try {
    const { runConsentCampaign } = await import('../services/comms/smsConsentService.js')
    const confirm = req.body?.confirm === true || req.body?.send === true
    const limit = Number(req.body?.limit) || 500
    const summary = await runConsentCampaign(req.db, { confirm, limit, requestedBy: actor(req) })
    res.json(summary)
  } catch (error) {
    log.error('sms consent campaign failed', { error: error?.message })
    res.status(500).json(formatError(error))
  }
})

// Consent status counts (none / pending / opted_in / opted_out) + SMS configured.
router.get('/sms-consent/status', async (req, res) => {
  try {
    const { getConsentStatusCounts } = await import('../services/comms/smsConsentService.js')
    const counts = await getConsentStatusCounts(req.db)
    res.json(counts)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Expire stale pending consents now (numbers asked but never replied → opted_out).
// Normally driven by the nightly sweep; exposed for the owner to run on demand.
router.post('/sms-consent/expire', async (req, res) => {
  try {
    const { expirePendingConsent } = await import('../services/comms/smsConsentService.js')
    const days = req.body?.days !== undefined && req.body?.days !== null ? Number(req.body.days) : null
    const result = await expirePendingConsent(req.db, { days })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Recent broadcast history (for the audit panel).
router.get('/broadcasts', async (req, res) => {
  try {
    await ensureCommsSchema(req.db)
    const rows = await req.db.prepare(
      `SELECT id, created_at, sent_by, kind, channel, subject, profile_count, sent_email, sent_sms, failed
         FROM comms_broadcasts ORDER BY created_at DESC LIMIT 50`,
    ).all()
    res.json({ broadcasts: rows || [] })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

export default router
