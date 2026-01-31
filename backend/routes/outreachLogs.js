import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser } from '../utils/accessControl.js'
import { formatError } from '../middleware/errorHandler.js'
import ensureOutreachLogsTable from '../utils/ensureOutreachLogsTable.js'

const router = express.Router()

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

async function ensureProfileAccess(req, res, profileId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null

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
    const profileId = req.query.profile_id ? String(req.query.profile_id) : null
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

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
    console.error('[outreach-logs] list error:', error)
    return res.status(500).json(formatError(error))
  }
})

router.post('/', async (req, res) => {
  try {
    const data = req.body ?? {}
    const profileId = data.profile_id ? String(data.profile_id) : null
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })

    const profileRow = await ensureProfileAccess(req, res, profileId)
    if (!profileRow) return

    await ensureOutreachLogsTable(req.db)

    const funder = String(data.funder || '').trim()
    const method = String(data.method || '').trim()
    if (!funder) return res.status(400).json({ error: 'funder required' })
    if (!['email', 'call', 'meeting'].includes(method)) {
      return res.status(400).json({ error: "method must be one of: 'email', 'call', 'meeting'" })
    }

    const occurredAtRaw = data.occurred_at ?? data.occurredAt ?? null
    const occurredAt = occurredAtRaw ? String(occurredAtRaw) : null

    const metadata =
      data.metadata && typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : data.metadata ?? null

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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
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
        metadata ?? '{}',
        createdBy,
      )

    const row = await req.db.prepare('SELECT * FROM outreach_logs WHERE id = ?').get(id)

    console.info('[outreach-logs] created', {
      profile_id: profileId,
      organization_id: profileRow.organization_id ?? null,
      funder,
      method,
      request_id: req.ctx?.requestId ?? null,
    })

    return res.status(201).json(row)
  } catch (error) {
    console.error('[outreach-logs] create error:', error)
    return res.status(500).json(formatError(error))
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    await ensureOutreachLogsTable(req.db)

    const id = String(req.params.id)
    const existing = await req.db.prepare('SELECT * FROM outreach_logs WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const profileRow = await ensureProfileAccess(req, res, String(existing.profile_id))
    if (!profileRow) return

    await req.db.prepare('DELETE FROM outreach_logs WHERE id = ?').run(id)
    return res.json({ ok: true })
  } catch (error) {
    console.error('[outreach-logs] delete error:', error)
    return res.status(500).json(formatError(error))
  }
})

export default router

