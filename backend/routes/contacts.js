import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, ensureOrganizationAccess, getAccessibleOrganizationIds } from '../utils/accessControl.js'

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
    const limit = normalizeLimit(req.query.limit, 500)
    const orgId = req.query.organization_id ? String(req.query.organization_id) : null
    const id = req.query.id ? String(req.query.id) : null

    // SECURITY: Contacts are org-scoped (table has no profile_id). If the user is operating under an
    // active profile context, log for audit/debugging to make cross-profile intent explicit.
    if (!req.ctx?.isAdmin && req.ctx?.activeProfileId) {
      console.info('[contacts] list accessed by profile', {
        userId: req.ctx.userId,
        profileId: req.ctx.activeProfileId,
        orgId,
      })
    }

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
          FROM contacts
          ${where}
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json(rows || [])
  } catch (error) {
    console.error('[contacts] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const row = await req.db.prepare('SELECT * FROM contacts WHERE id = ?').get(String(req.params.id))
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(row.organization_id)))) return
    return res.json(row)
  } catch (error) {
    console.error('[contacts] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const data = req.body ?? {}
    const orgId = data.organization_id ? String(data.organization_id) : null
    if (!orgId) return res.status(400).json({ error: 'organization_id required' })
    if (!(await ensureOrganizationAccess(req, res, orgId))) return

    const id = data.id ? String(data.id) : crypto.randomUUID()
    const name = String(data.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })

    await req.db
      .prepare(
        `
          INSERT INTO contacts (
            id, organization_id,
            name, title, email, phone,
            type, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        orgId,
        name,
        data.title ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.type ?? null,
        data.notes ?? null,
      )

    const row = await req.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)
    return res.status(201).json(row)
  } catch (error) {
    console.error('[contacts] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM contacts WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(existing.organization_id)))) return

    const data = req.body ?? {}
    const name = data.name !== undefined ? String(data.name || '').trim() : null
    if (data.name !== undefined && !name) return res.status(400).json({ error: 'name required' })

    await req.db
      .prepare(
        `
          UPDATE contacts
          SET updated_at = CURRENT_TIMESTAMP,
              name = COALESCE(?, name),
              title = COALESCE(?, title),
              email = COALESCE(?, email),
              phone = COALESCE(?, phone),
              type = COALESCE(?, type),
              notes = COALESCE(?, notes)
          WHERE id = ?
        `,
      )
      .run(
        name,
        data.title ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.type ?? null,
        data.notes ?? null,
        String(req.params.id),
      )

    const row = await req.db.prepare('SELECT * FROM contacts WHERE id = ?').get(String(req.params.id))
    return res.json(row)
  } catch (error) {
    console.error('[contacts] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM contacts WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(existing.organization_id)))) return

    await req.db.prepare('DELETE FROM contacts WHERE id = ?').run(String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    console.error('[contacts] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

