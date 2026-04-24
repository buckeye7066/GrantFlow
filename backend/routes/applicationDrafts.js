import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, ensureGrantAccess, getAccessibleOrganizationIds } from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:applicationDrafts')

const router = express.Router()

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const limit = normalizeLimit(req.query.limit, 50)
    const grantId = req.query.grant_id ? String(req.query.grant_id) : null
    const id = req.query.id ? String(req.query.id) : null

    const clauses = []
    const params = []

    if (id) {
      clauses.push('a.id = ?')
      params.push(id)
    }
    if (grantId) {
      clauses.push('a.grant_id = ?')
      params.push(grantId)
    }

    if (!req.ctx?.isAdmin) {
      const allowed = req.ctx?.accessibleOrgIds ?? (await getAccessibleOrganizationIds(req.db, user))
      const allowedList = allowed === null ? null : Array.from(allowed || [])
      if (allowedList && allowedList.length === 0) return res.json([])
      if (allowedList) {
        // Validate allowedList contains only valid org IDs BEFORE staging into query
        if (!allowedList.every(orgId => typeof orgId === 'string' && /^[a-zA-Z0-9_-]+$/.test(orgId))) {
          return res.status(403).json({ error: 'Invalid organization access' })
        }
        const placeholders = allowedList.map(() => '?').join(', ')
        clauses.push(`g.organization_id IN (${placeholders})`)
        params.push(...allowedList)
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `
          SELECT a.*, g.organization_id
          FROM application_drafts a
          INNER JOIN grants g ON g.id = a.grant_id
          ${where}
          ORDER BY a.updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json(rows || [])
  } catch (error) {
    console.error('[application-drafts] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const row = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    if (!row) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(row.grant_id))
    if (!grant) return
    return res.json(row)
  } catch (error) {
    console.error('[application-drafts] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const data = req.body ?? {}
    const grantId = data.grant_id ? String(data.grant_id) : null
    if (!grantId) return res.status(400).json({ error: 'grant_id required' })
    const grant = await ensureGrantAccess(req, res, grantId)
    if (!grant) return

    const id = data.id ? String(data.id) : crypto.randomUUID()

    await req.db
      .prepare(
        `
          INSERT INTO application_drafts (
            id, grant_id,
            section_name, section_order,
            prompt, content, ai_suggestions,
            word_limit, word_count,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        grantId,
        data.section_name ?? null,
        data.section_order ?? null,
        data.prompt ?? null,
        data.content ?? null,
        data.ai_suggestions ?? null,
        data.word_limit ?? null,
        data.word_count ?? null,
        data.status ?? 'draft',
      )

    const row = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(id)
    return res.status(201).json(row)
  } catch (error) {
    console.error('[application-drafts] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(existing.grant_id))
    if (!grant) return

    const data = req.body ?? {}

    await req.db
      .prepare(
        `
          UPDATE application_drafts
          SET updated_at = CURRENT_TIMESTAMP,
              section_name = COALESCE(?, section_name),
              section_order = COALESCE(?, section_order),
              prompt = COALESCE(?, prompt),
              content = COALESCE(?, content),
              ai_suggestions = COALESCE(?, ai_suggestions),
              word_limit = COALESCE(?, word_limit),
              word_count = COALESCE(?, word_count),
              status = COALESCE(?, status)
          WHERE id = ?
        `,
      )
      .run(
        data.section_name ?? null,
        data.section_order ?? null,
        data.prompt ?? null,
        data.content ?? null,
        data.ai_suggestions ?? null,
        data.word_limit ?? null,
        data.word_count ?? null,
        data.status ?? null,
        String(req.params.id),
      )

    const row = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    return res.json(row)
  } catch (error) {
    console.error('[application-drafts] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM application_drafts WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const grant = await ensureGrantAccess(req, res, String(existing.grant_id))
    if (!grant) return

    await req.db.prepare('DELETE FROM application_drafts WHERE id = ?').run(String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    console.error('[application-drafts] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

