/**
 * Owner Blocklist — HTTP API.
 *
 * Admin-only (req.ctx.isAdmin or admin token):
 *   GET    /api/blocklist            — list entries
 *   POST   /api/blocklist            — add an entry { match_type, value, reason?, enforcement? }
 *   DELETE /api/blocklist            — remove an entry { match_type, value }
 *   GET    /api/blocklist/hits       — recent enforcement hits (audit)
 *   POST   /api/blocklist/sync/gmail-filters — pull Gmail filters server-side (if configured)
 *
 * Device ingest (token: x-blocklist-token / Bearer, value = BLOCKLIST_INGEST_TOKEN
 * or ADMIN_TOKEN). This is what the phone's Tasker profile and the Gmail Apps
 * Script POST to:
 *   POST   /api/blocklist/ingest     — bulk push { source, numbers?[], emails?[], entries?[] }
 */

import express from 'express'
import crypto from 'node:crypto'

import { db } from '../db/index.js'
import { createLogger } from '../utils/logger.js'
import {
  addEntry,
  removeEntry,
  listEntries,
  ensureSeedEntries,
  MATCH_TYPE,
} from '../services/blocklist/ownerBlocklistService.js'
import { syncGmailFilters } from '../services/blocklist/gmailFilterSyncService.js'

const router = express.Router()
const log = createLogger('route:blocklist')

function resolveAdminToken() {
  return process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || process.env.JOHN_ADMIN_TOKEN || null
}
function resolveIngestToken() {
  return process.env.BLOCKLIST_INGEST_TOKEN || resolveAdminToken()
}

function timingSafeEq(a, b) {
  if (!a || !b) return false
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

function adminAuth(req, res, next) {
  if (req.ctx && req.ctx.isAdmin === true) return next()
  if (req.user?.role === 'admin' || req.user?.is_admin === true) return next()
  const configured = resolveAdminToken()
  if (!configured) return res.status(401).json({ error: 'Admin token not configured' })
  const headerToken =
    req.headers.authorization?.replace('Bearer ', '') ||
    req.headers['x-admin-token'] ||
    req.headers['x-blocklist-token']
  if (!headerToken) return res.status(401).json({ error: 'Missing admin credentials' })
  if (!timingSafeEq(headerToken, configured)) return res.status(403).json({ error: 'Invalid admin credentials' })
  return next()
}

// Device ingest accepts the ingest token OR full admin auth.
function ingestAuth(req, res, next) {
  if (req.ctx?.isAdmin === true || req.user?.is_admin === true) return next()
  const configured = resolveIngestToken()
  if (!configured) return res.status(401).json({ error: 'Ingest token not configured (set BLOCKLIST_INGEST_TOKEN)' })
  const headerToken =
    req.headers['x-blocklist-token'] || req.headers.authorization?.replace('Bearer ', '')
  if (!timingSafeEq(headerToken, configured)) return res.status(403).json({ error: 'Invalid ingest token' })
  return next()
}

/** -------- Admin: list / add / remove -------- */

router.get('/', adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 500
    const entries = await listEntries(db, { limit })
    res.json({ ok: true, entries })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.post('/', adminAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const result = await addEntry(db, {
      match_type: body.match_type || body.type,
      value: body.value,
      reason: body.reason || null,
      enforcement: body.enforcement || 'block',
      source: body.source || 'manual',
      added_by_user_id: req.user?.id || null,
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message, code: err?.code })
  }
})

router.delete('/', adminAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const result = await removeEntry(db, { match_type: body.match_type || body.type, value: body.value })
    res.json(result)
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message })
  }
})

router.post('/seed', adminAuth, async (_req, res) => {
  try {
    const result = await ensureSeedEntries(db)
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

router.get('/hits', adminAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 100))
    const rows = await db
      .prepare(`SELECT * FROM owner_blocklist_hits ORDER BY created_at DESC LIMIT ?`)
      .all(limit)
    res.json({ ok: true, hits: rows || [] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

/** -------- Device ingest (Tasker phone list, Gmail Apps Script) -------- */

router.post('/ingest', ingestAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const source = String(body.source || 'device_ingest').slice(0, 64)
    const reason = body.reason || `Imported from ${source}`

    // Normalize the three accepted shapes into a single typed list.
    const typed = []
    for (const num of toArray(body.numbers)) typed.push({ match_type: MATCH_TYPE.PHONE, value: num })
    for (const em of toArray(body.emails)) typed.push({ match_type: MATCH_TYPE.EMAIL, value: em })
    for (const e of toArray(body.entries)) {
      if (e && (e.value ?? e.number ?? e.email)) {
        typed.push({
          match_type: e.match_type || e.type || (e.email ? MATCH_TYPE.EMAIL : e.number ? MATCH_TYPE.PHONE : MATCH_TYPE.EMAIL),
          value: e.value ?? e.email ?? e.number,
          reason: e.reason || reason,
        })
      }
    }

    if (typed.length === 0) {
      return res.status(400).json({ ok: false, error: 'No entries provided (numbers[], emails[], or entries[])' })
    }

    let added = 0
    let skipped = 0
    const errors = []
    for (const t of typed) {
      try {
        const r = await addEntry(db, {
          match_type: t.match_type,
          value: t.value,
          reason: t.reason || reason,
          source,
        })
        if (r.created) added += 1
        else skipped += 1
      } catch (err) {
        errors.push({ value: t.value, error: err?.message })
      }
    }
    log.info(`[ingest] source=${source} added=${added} skipped=${skipped} errors=${errors.length}`)
    res.json({ ok: true, received: typed.length, added, skipped, errors })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

/** -------- Gmail filter sync (server-side, when OAuth configured) -------- */

router.post('/sync/gmail-filters', adminAuth, async (req, res) => {
  try {
    const result = await syncGmailFilters(db, { addedByUserId: req.user?.id || null })
    res.status(result.ok ? 200 : 200).json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean)
  if (typeof v === 'string') return v.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

export default router
