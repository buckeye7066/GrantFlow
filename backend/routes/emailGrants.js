/**
 * Email → Grant ingestion — HTTP API.
 *
 * The owner's inbox bridge (Gmail Apps Script, mail forwarder) POSTs grant
 * emails here. Parsed grants land in the funding catalog and flow through the
 * normal Smart Match / Discover pipeline.
 *
 * Device/script ingest (token: x-email-grants-token / Bearer, value =
 * EMAIL_GRANTS_INGEST_TOKEN or ADMIN_TOKEN):
 *   POST /api/email-grants/ingest   — { source?, email?{...} } OR { emails:[...] }
 *
 * Admin (req.ctx.isAdmin or admin token):
 *   GET  /api/email-grants          — recent ingestions + status tallies (review)
 *   POST /api/email-grants/:id/reject — mark an ingestion rejected (audit)
 *
 * One email shape: { messageId, from, subject, text|body|html, receivedAt, profileId? }
 */

import express from 'express'
import crypto from 'node:crypto'

import { db } from '../db/index.js'
import { createLogger } from '../utils/logger.js'
import { ingestEmails, getEmailGrantHealth, ensureEmailGrantSchema } from '../services/emailGrants/emailGrantIngestor.js'
import { runOutlookGrantFeed } from '../services/emailGrants/outlookGrantFeeder.js'

const router = express.Router()
const log = createLogger('route:emailGrants')

function resolveAdminToken() {
  return process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || process.env.JOHN_ADMIN_TOKEN || null
}
function resolveIngestToken() {
  return process.env.EMAIL_GRANTS_INGEST_TOKEN || resolveAdminToken()
}

function timingSafeEq(a, b) {
  if (!a || !b) return false
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

function adminAuth(req, res, next) {
  if (req.ctx?.isAdmin === true) return next()
  const configured = resolveAdminToken()
  if (!configured) return res.status(401).json({ error: 'Admin token not configured' })
  const headerToken =
    req.headers.authorization?.replace('Bearer ', '') ||
    req.headers['x-admin-token'] ||
    req.headers['x-email-grants-token']
  if (!headerToken) return res.status(401).json({ error: 'Missing admin credentials' })
  if (!timingSafeEq(headerToken, configured)) return res.status(403).json({ error: 'Invalid admin credentials' })
  return next()
}

function ingestAuth(req, res, next) {
  if (req.ctx?.isAdmin === true) return next()
  const configured = resolveIngestToken()
  if (!configured) {
    return res.status(401).json({ error: 'Ingest token not configured (set EMAIL_GRANTS_INGEST_TOKEN)' })
  }
  const headerToken =
    req.headers['x-email-grants-token'] || req.headers.authorization?.replace('Bearer ', '')
  if (!timingSafeEq(headerToken, configured)) return res.status(403).json({ error: 'Invalid ingest token' })
  return next()
}

/** Normalize the accepted request shapes into a flat array of email objects. */
function collectEmails(body) {
  if (!body || typeof body !== 'object') return []
  if (Array.isArray(body.emails)) return body.emails.filter((e) => e && typeof e === 'object')
  if (body.email && typeof body.email === 'object') return [{ source: body.source, ...body.email }]
  // Also accept a single flat email posted at the top level.
  if (body.subject || body.text || body.body || body.html || body.messageId) return [body]
  return []
}

router.post('/ingest', ingestAuth, async (req, res) => {
  try {
    const emails = collectEmails(req.body)
    if (emails.length === 0) {
      return res.status(400).json({ ok: false, error: 'No email(s) provided (email{}, emails[], or a flat email body)' })
    }
    // Carry a default source down to each email if the caller set one globally.
    const defaultSource = req.body?.source
    const normalized = emails.map((e) => (e.source ? e : { ...e, source: defaultSource }))
    const { summary, results } = await ingestEmails(db, normalized)
    log.info(`[ingest] ${JSON.stringify(summary)}`)
    res.json({ ok: true, ...summary, results })
  } catch (err) {
    log.error('ingest failed', { error: err?.message })
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/', adminAuth, async (req, res) => {
  try {
    const health = await getEmailGrantHealth(db, { limit: Number(req.query.limit) || 20 })
    res.json({ ok: true, ...health })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

// Pull grant emails straight from the configured Microsoft 365 inbox (the John
// Outlook Graph bridge) and ingest them. No Gmail / Apps Script needed. Admin
// or ingest-token; can also be wired to a schedule for hands-off operation.
router.post('/sync-outlook', ingestAuth, async (req, res) => {
  try {
    const top = Math.max(1, Math.min(100, Number(req.body?.top) || 25))
    const result = await runOutlookGrantFeed(db, { top, sinceIso: req.body?.since || null })
    res.status(result.ok ? 200 : 200).json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/:id/reject', adminAuth, async (req, res) => {
  try {
    await ensureEmailGrantSchema(db)
    const id = String(req.params.id)
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : 'manual_reject'
    const result = await db
      .prepare("UPDATE email_grant_ingestions SET status = 'rejected', reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(reason, id)
    const changes = Number(result?.changes ?? result?.rowCount ?? 0)
    if (!changes) return res.status(404).json({ ok: false, error: 'Ingestion not found' })
    res.json({ ok: true, id, status: 'rejected' })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

export default router
