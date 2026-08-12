import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, requireAuthenticatedUserMiddleware, ensureOrganizationAccess, getAccessibleOrganizationIds } from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:contactMethods')

const router = express.Router()
router.use(requireAuthenticatedUserMiddleware)

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const limit = normalizeLimit(req.query.limit, 500)
    const orgId = req.query.organization_id ? String(req.query.organization_id) : null
    const type = req.query.type ? String(req.query.type) : null
    const id = req.query.id ? String(req.query.id) : null

    if (orgId) {
      if (!(await ensureOrganizationAccess(req, res, orgId))) return
    }

    const clauses = []
    const params = []
    if (id) {
      clauses.push('id = ?')
      params.push(id)
    }
    if (orgId) {
      clauses.push('organization_id = ?')
      params.push(orgId)
    }
    if (type) {
      clauses.push('type = ?')
      params.push(type)
    }

    if (!req.ctx?.isAdmin) {
      const allowed = req.ctx?.accessibleOrgIds ?? (await getAccessibleOrganizationIds(req.db, user))
      const allowedList = allowed === null ? null : Array.from(allowed || [])
      if (allowedList && allowedList.length === 0) return res.json([])
      if (allowedList) {
        const placeholders = allowedList.map(() => '?').join(', ')
        clauses.push(`organization_id IN (${placeholders})`)
        params.push(...allowedList)
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM contact_methods
          ${where}
          ORDER BY is_primary DESC, updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json(rows || [])
  } catch (error) {
    routeLogger.error('[contact-methods] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const row = await req.db.prepare('SELECT * FROM contact_methods WHERE id = ?').get(String(req.params.id))
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(row.organization_id)))) return
    return res.json(row)
  } catch (error) {
    routeLogger.error('[contact-methods] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const data = req.body ?? {}
    const orgId = data.organization_id ? String(data.organization_id) : null
    if (!orgId) return res.status(400).json({ error: 'organization_id required' })
    if (!(await ensureOrganizationAccess(req, res, orgId))) return

    const validTypes = ['email', 'phone']
    const type = String(data.type || '').trim()
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid contact type' })
    const value = String(data.value || '').trim()
    if (!type || !value) return res.status(400).json({ error: 'type and value required' })
    // Bounded quantifiers (RFC-plausible length caps) to avoid a polynomial
    // ReDoS shape: an unbounded run of chars on both sides of the literal
    // `.` gives many equivalent split points on a long, dot-heavy string.
    if (type === 'email' && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/.test(value)) return res.status(400).json({ error: 'Invalid email format' })
    if (type === 'phone' && !/^[\d\s\-()+]+$/.test(value)) return res.status(400).json({ error: 'Invalid phone format' })

    const id = data.id ? String(data.id) : crypto.randomUUID()
    const isPrimary = data.is_primary ? 1 : 0

    await req.db
      .prepare(
        `
          INSERT INTO contact_methods (
            id, organization_id,
            type, value,
            is_primary, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        orgId,
        type,
        value,
        isPrimary,
        data.notes ?? null,
        data.created_by ?? null,
      )

    const row = await req.db.prepare('SELECT * FROM contact_methods WHERE id = ?').get(id)
    return res.status(201).json(row)
  } catch (error) {
    routeLogger.error('[contact-methods] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const existing = await req.db.prepare('SELECT * FROM contact_methods WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(existing.organization_id)))) return

    const data = req.body ?? {}
    await req.db
      .prepare(
        `
          UPDATE contact_methods
          SET updated_at = CURRENT_TIMESTAMP,
              type = COALESCE(?, type),
              value = COALESCE(?, value),
              is_primary = COALESCE(?, is_primary),
              notes = COALESCE(?, notes)
          WHERE id = ?
        `,
      )
      .run(
        data.type ?? null,
        data.value ?? null,
        data.is_primary === undefined ? null : data.is_primary ? 1 : 0,
        data.notes ?? null,
        String(req.params.id),
      )

    const row = await req.db.prepare('SELECT * FROM contact_methods WHERE id = ?').get(String(req.params.id))
    return res.json(row)
  } catch (error) {
    routeLogger.error('[contact-methods] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const existing = await req.db.prepare('SELECT * FROM contact_methods WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(existing.organization_id)))) return

    await req.db.prepare('DELETE FROM contact_methods WHERE id = ?').run(String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    routeLogger.error('[contact-methods] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

