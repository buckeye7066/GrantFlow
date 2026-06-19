import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import { formatError } from '../middleware/errorHandler.js'
import ensureOutreachLogsTable from '../utils/ensureOutreachLogsTable.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:outreachLogs')

const router = express.Router()

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

// Shared profile-id resolution. The frontend sends the active profile as the
// `X-Profile-Id` header, but the GET handler only read `?profile_id=` — a
// contract mismatch that returned 400 on every initial Outreach load. Resolve
// from query string, then the header, then the request context's active profile.
function resolveProfileId(req, { fromBody = false } = {}) {
  const candidates = [
    fromBody ? req.body?.profile_id : req.query?.profile_id,
    req.headers?.['x-profile-id'],
    req.ctx?.activeProfileId,
  ]
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== '') return String(c).trim()
  }
  return null
}

async function ensureProfileAccess(req, res, profileId) {
  if (!requireAuthenticatedUser(req, res)) return null
  // user validation passed

  const row = await req.db
    .prepare('SELECT id, user_id, organization_id FROM profiles WHERE id = ?')
    .get(String(profileId))

  if (!row) {
    res.status(404).json({ error: 'Profile not found' })
    return null
  }

  const canAccess =
    req.ctx?.isAdmin === true ||
    (req.ctx?.activeProfileId && String(req.ctx.activeProfileId) === String(profileId)) ||
    (req.ctx?.userId && row.user_id && String(req.ctx.userId) === String(row.user_id))

  if (!canAccess) {
    res.status(403).json({ error: 'Not authorized to access this profile' })
    return null
  }

  return row
}

router.get('/', async (req, res) => {
  try {
    const profileId = resolveProfileId(req)
    if (!profileId) {
      // No profile context yet (initial tab load before a profile is active).
      // Return an empty result at 200 so the Communication Log renders cleanly
      // instead of surfacing a 400.
      return res.json({ profile_id: null, organization_id: null, items: [] })
    }

    const profileRow = await ensureProfileAccess(req, res, profileId)
    if (!profileRow) return

    await ensureOutreachLogsTable(req.db)

    const limit = normalizeLimit(req.query.limit, 250)
    const funder = req.query.funder ? String(req.query.funder).trim() : null

    const clauses = ['profile_id = ?']
    const params = [profileId]
    if (funder) {
      clauses.push('funder = ?')
      params.push(funder)
    }

    const where = `WHERE ${clauses.join(' AND ')}`
    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM outreach_logs
          ${where}
          ORDER BY COALESCE(occurred_at, created_at) DESC, created_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json({
      profile_id: profileId,
      organization_id: profileRow.organization_id ?? null,
      items: rows || [],
    })
  } catch (error) {
    routeLogger.error('[outreach-logs] list error:', error)
    return res.status(500).json(formatError(error))
  }
})

router.post('/', async (req, res) => {
  try {
    const data = req.body ?? {}
    // Creating a log genuinely needs a profile; accept it from the body, the
    // X-Profile-Id header, or the active profile context (shared resolver).
    const profileId = resolveProfileId(req, { fromBody: true })
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

    const profileRow = await ensureProfileAccess(req, res, profileId)
    if (!profileRow) return

    await ensureOutreachLogsTable(req.db)

    const funder = String(data.funder || '').trim()
    const method = String(data.method || '').trim()
    if (!funder) return res.status(400).json({ error: 'funder required' })
    if (!method) return res.status(400).json({ error: 'method required' })
    const ALLOWED_METHODS = ['email', 'call', 'meeting', 'letter', 'portal', 'in-person', 'other']
    if (!ALLOWED_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${ALLOWED_METHODS.join(', ')}` })
    }

    const occurredAtRaw = data.occurred_at ?? data.occurredAt ?? null
    let occurredAt = null
if (occurredAtRaw) {
  const parsed = new Date(String(occurredAtRaw))
  if (!Number.isFinite(parsed.getTime())) {
    return res.status(400).json({ error: 'occurred_at is not a valid ISO date string' })
  }
  occurredAt = parsed.toISOString()
}

    let metadata = null
    if (data.metadata !== undefined && data.metadata !== null) {
      metadata = typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : String(data.metadata)
    }

    const id = crypto.randomUUID()
    const createdBy = req.ctx?.userId ?? req.ctx?.email ?? null

    const insertSql =
      req.db?.dialect === 'postgres'
        ? `
          INSERT INTO outreach_logs (
            id,
            profile_id,
            organization_id,
            funder,
            method,
            occurred_at,
            subject,
            notes,
            metadata,
            created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        `
        : `
          INSERT INTO outreach_logs (
            id,
            profile_id,
            organization_id,
            funder,
            method,
            occurred_at,
            subject,
            notes,
            metadata,
            created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `

    await req.db
      .prepare(insertSql)
      .run(
        id,
        profileId,
        profileRow.organization_id ?? null,
        funder,
        method,
        occurredAt,
        data.subject ?? null,
        data.notes ?? null,
        metadata,
        createdBy,
      )

    const row = await req.db.prepare('SELECT * FROM outreach_logs WHERE id = ?').get(id)

    routeLogger.info('[outreach-logs] created', {
      profile_id: profileId,
      organization_id: profileRow.organization_id ?? null,
      funder,
      method,
      request_id: req.ctx?.requestId ?? null,
    })

    return res.status(201).json(row)
  } catch (error) {
    routeLogger.error('[outreach-logs] create error:', error)
    return res.status(500).json(formatError(error))
  }
})

router.delete('/:id', async (req, res) => {
  try {
    if (!requireAuthenticatedUser(req, res)) return
    // user validation passed

    await ensureOutreachLogsTable(req.db)

    const id = String(req.params.id)
    const existing = await req.db.prepare('SELECT * FROM outreach_logs WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const profileRow = await ensureProfileAccess(req, res, String(existing.profile_id))
    if (!profileRow) return

    await req.db.prepare('DELETE FROM outreach_logs WHERE id = ?').run(id)
    return res.json({ ok: true })
  } catch (error) {
    routeLogger.error('[outreach-logs] delete error:', error)
    return res.status(500).json(formatError(error))
  }
})

export default router

