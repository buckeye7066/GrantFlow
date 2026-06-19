import express from 'express'
import crypto from 'crypto'
import {
  requireAuthenticatedUser,
  ensureOrganizationAccess,
  ensureProfileAccess,
  getAccessibleOrganizationIds,
} from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
import { enforce as enforceOwnerBlocklist } from '../services/blocklist/ownerBlocklistService.js'
const routeLogger = createLogger('route:contacts')

const router = express.Router()

let contactsHasProfileIdColumnCache = null
async function contactsHasProfileIdColumn(db) {
  if (contactsHasProfileIdColumnCache !== null) return contactsHasProfileIdColumnCache
  try {
    if (db?.dialect === 'postgres') {
      const result = await db.query(
          `
            SELECT 1 AS ok
            FROM information_schema.columns
            WHERE table_name = 'contacts' AND column_name = 'profile_id'
            LIMIT 1
          `
        )
      const row = result.rows?.[0]
      contactsHasProfileIdColumnCache = Boolean(row?.ok)
      return contactsHasProfileIdColumnCache
    }

    // sqlite
    const rows = await db.prepare(`PRAGMA table_info(contacts)`).all()
    contactsHasProfileIdColumnCache = (rows || []).some((r) => String(r?.name || '') === 'profile_id')
    return contactsHasProfileIdColumnCache
  } catch {
    contactsHasProfileIdColumnCache = false
    return false
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
    const orgId = req.query.organization_id ? String(req.query.organization_id) : null
    const id = req.query.id ? String(req.query.id) : null
    const queryProfileIdRaw = req.query.profile_id ? String(req.query.profile_id) : null
    const activeProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

    // SECURITY: Contacts are org-scoped by default. When `contacts.profile_id` is set, contacts become
    // profile-scoped. We log access under active profile context to make intent explicit.
    if (!req.ctx?.isAdmin && req.ctx?.activeProfileId) {
      routeLogger.info('[contacts] list accessed by profile', {
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

      // Profile-aware filtering (Option B):
      // - If contacts.profile_id is set, only allow it to appear when it matches the active/requested profile.
      // - If contacts.profile_id is NULL, treat as org-shared (legacy) and allow it for all profiles in org.
      // This prevents cross-profile confusion/leakage once profile_id is populated, without breaking legacy rows.
      const effectiveProfileId = queryProfileIdRaw || activeProfileId || null
      const hasColumn = await contactsHasProfileIdColumn(req.db)
      if (hasColumn && effectiveProfileId) {
        const canAccess = await ensureProfileAccess(req, res, String(effectiveProfileId))
        if (!canAccess) return
        clauses.push('(profile_id IS NULL OR profile_id = ?)')
        params.push(String(effectiveProfileId))
      } else if (hasColumn && !effectiveProfileId) {
        // If profile_id column exists but no profile specified, require explicit profile context
        return res.status(400).json({ error: 'profile_id required when profile_id column exists' })
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
    routeLogger.error('[contacts] list error:', error)
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
    
    // Apply same profile access control as list endpoint
    const hasColumn = await contactsHasProfileIdColumn(req.db)
    if (hasColumn && row.profile_id && req.ctx?.activeProfileId) {
      const canAccess = await ensureProfileAccess(req, res, String(req.ctx.activeProfileId))
      if (!canAccess) return
      if (String(row.profile_id) !== String(req.ctx.activeProfileId)) {
        return res.status(404).json({ error: 'Not found' })
      }
    }
    
    return res.json(row)
  } catch (error) {
    routeLogger.error('[contacts] get error:', error)
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

    // Owner blocklist: refuse to store a contact whose email/phone/name is blocked.
    const blocked = await enforceOwnerBlocklist(
      req.db,
      { email: data.email, phone: data.phone, name },
      { context: 'inbound_contact' },
    )
    if (blocked.blocked) {
      return res.status(403).json({
        error: 'blocked',
        error_type: 'blocked',
        message: 'This contact is on the owner blocklist and cannot be added.',
      })
    }

    const profileId = data.profile_id ? String(data.profile_id) : null

    if (profileId) {
      const hasColumn = await contactsHasProfileIdColumn(req.db)
      if (!hasColumn) return res.status(400).json({ error: 'profile_id is not supported (migration pending)' })
      const ok = await ensureProfileAccess(req, res, profileId)
      if (!ok) return
      const row = await req.db.prepare('SELECT organization_id FROM profiles WHERE id = ?').get(profileId)
      if (!row) return res.status(400).json({ error: 'profile_id not found' })
      if (String(row.organization_id || '') !== String(orgId)) {
        return res.status(400).json({ error: 'profile_id must belong to the same organization_id' })
      }
    }

    if (profileId) {
      await req.db
        .prepare(
          `
            INSERT INTO contacts (
              id, organization_id, profile_id,
              name, title, email, phone,
              type, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          orgId,
          profileId,
          name,
          data.title ?? null,
          data.email ?? null,
          data.phone ?? null,
          data.type ?? null,
          data.notes ?? null,
        )
    } else {
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
    }

    const row = await req.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)
    return res.status(201).json(row)
  } catch (error) {
    routeLogger.error('[contacts] create error:', error)
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

    const wantsProfileUpdate = Object.prototype.hasOwnProperty.call(data, 'profile_id')
    const profileId = wantsProfileUpdate ? (data.profile_id ? String(data.profile_id) : null) : null

    if (wantsProfileUpdate) {
      const hasColumn = await contactsHasProfileIdColumn(req.db)
      if (!hasColumn) return res.status(400).json({ error: 'profile_id is not supported (migration pending)' })
    }

    if (wantsProfileUpdate && profileId) {
      const ok = await ensureProfileAccess(req, res, String(profileId))
      if (!ok) return
      const row = await req.db.prepare('SELECT organization_id FROM profiles WHERE id = ?').get(String(profileId))
      if (!row) return res.status(400).json({ error: 'profile_id not found' })
      if (String(row.organization_id || '') !== String(existing.organization_id || '')) {
        return res.status(400).json({ error: 'profile_id must belong to the same organization_id' })
      }
    }

    const setProfileSql = wantsProfileUpdate ? 'profile_id = ?,' : ''
    const profileParamList = wantsProfileUpdate ? [profileId] : []

    await req.db
      .prepare(
        `
          UPDATE contacts
          SET updated_at = CURRENT_TIMESTAMP,
              name = COALESCE(?, name),
              ${setProfileSql}
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
        ...profileParamList,
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
    routeLogger.error('[contacts] update error:', error)
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
    routeLogger.error('[contacts] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router

