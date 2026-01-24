import express from 'express'
import crypto from 'crypto'
import { requireAuthenticatedUser, ensureOrganizationAccess, getAccessibleOrganizationIds } from '../utils/accessControl.js'

const router = express.Router()

function nowIso() {
  return new Date().toISOString()
}

function mapRow(row) {
  if (!row) return null
  return {
    ...row,
    // Normalize sqlite boolean-ish fields
    active: row.active === true || row.active === 1,
  }
}

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
    const id = req.query.id ? String(req.query.id) : null
    const orgId = req.query.discovered_for_organization_id ? String(req.query.discovered_for_organization_id) : null

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
      clauses.push('discovered_for_organization_id = ?')
      params.push(orgId)
    }

    if (!req.ctx?.isAdmin) {
      const allowed = req.ctx?.accessibleOrgIds ?? (await getAccessibleOrganizationIds(req.db, user))
      const allowedList = allowed === null ? null : Array.from(allowed || [])
      if (allowedList && allowedList.length === 0) return res.json([])
      if (allowedList) {
        const placeholders = allowedList.map(() => '?').join(', ')
        clauses.push(`discovered_for_organization_id IN (${placeholders})`)
        params.push(...allowedList)
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `
          SELECT *
          FROM source_directory
          ${where}
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(...params, limit)

    return res.json((rows || []).map(mapRow))
  } catch (error) {
    console.error('[source-directory] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const row = await req.db.prepare('SELECT * FROM source_directory WHERE id = ?').get(String(req.params.id))
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(row.discovered_for_organization_id)))) return
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[source-directory] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const data = req.body ?? {}
    const orgId = data.discovered_for_organization_id ?? data.organization_id ?? data.organizationId ?? null
    if (!orgId) return res.status(400).json({ error: 'discovered_for_organization_id required' })
    if (!(await ensureOrganizationAccess(req, res, String(orgId)))) return

    const id = data.id ? String(data.id) : crypto.randomUUID()
    const createdAt = nowIso()
    const updatedAt = createdAt

    await req.db
      .prepare(
        `
          INSERT INTO source_directory (
            id, created_at, updated_at,
            discovered_for_organization_id,
            name, parent_organization, source_type,
            website_url, scholarship_page_url,
            city, state, zip,
            crawl_frequency, active, notes, contact_email,
            last_crawled, opportunities_found, opportunities_added
          ) VALUES (
            ?, ?, ?,
            ?,
            ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?
          )
        `,
      )
      .run(
        id,
        createdAt,
        updatedAt,
        String(orgId),
        String(data.name || '').trim(),
        data.parent_organization ?? null,
        data.source_type ?? null,
        data.website_url ?? null,
        data.scholarship_page_url ?? null,
        data.city ?? null,
        data.state ?? null,
        data.zip ?? null,
        data.crawl_frequency ?? null,
        data.active === false ? 0 : 1,
        data.notes ?? null,
        data.contact_email ?? null,
        data.last_crawled ?? null,
        Number(data.opportunities_found ?? 0) || 0,
        Number(data.opportunities_added ?? 0) || 0,
      )

    const row = await req.db.prepare('SELECT * FROM source_directory WHERE id = ?').get(id)
    return res.status(201).json(mapRow(row))
  } catch (error) {
    console.error('[source-directory] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM source_directory WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(existing.discovered_for_organization_id)))) return

    const data = req.body ?? {}
    const updatedAt = nowIso()

    await req.db
      .prepare(
        `
          UPDATE source_directory
          SET updated_at = ?,
              name = COALESCE(?, name),
              parent_organization = COALESCE(?, parent_organization),
              source_type = COALESCE(?, source_type),
              website_url = COALESCE(?, website_url),
              scholarship_page_url = COALESCE(?, scholarship_page_url),
              city = COALESCE(?, city),
              state = COALESCE(?, state),
              zip = COALESCE(?, zip),
              crawl_frequency = COALESCE(?, crawl_frequency),
              active = COALESCE(?, active),
              notes = COALESCE(?, notes),
              contact_email = COALESCE(?, contact_email),
              last_crawled = COALESCE(?, last_crawled),
              opportunities_found = COALESCE(?, opportunities_found),
              opportunities_added = COALESCE(?, opportunities_added)
          WHERE id = ?
        `,
      )
      .run(
        updatedAt,
        data.name !== undefined ? String(data.name || '').trim() : null,
        data.parent_organization ?? null,
        data.source_type ?? null,
        data.website_url ?? null,
        data.scholarship_page_url ?? null,
        data.city ?? null,
        data.state ?? null,
        data.zip ?? null,
        data.crawl_frequency ?? null,
        data.active === undefined ? null : data.active === false ? 0 : 1,
        data.notes ?? null,
        data.contact_email ?? null,
        data.last_crawled ?? null,
        data.opportunities_found ?? null,
        data.opportunities_added ?? null,
        String(req.params.id),
      )

    const row = await req.db.prepare('SELECT * FROM source_directory WHERE id = ?').get(String(req.params.id))
    return res.json(mapRow(row))
  } catch (error) {
    console.error('[source-directory] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const existing = await req.db.prepare('SELECT * FROM source_directory WHERE id = ?').get(String(req.params.id))
    if (!existing) return res.status(404).json({ error: 'Not found' })
    if (!(await ensureOrganizationAccess(req, res, String(existing.discovered_for_organization_id)))) return

    await req.db.prepare('DELETE FROM source_directory WHERE id = ?').run(String(req.params.id))
    return res.json({ ok: true })
  } catch (error) {
    console.error('[source-directory] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

