import express from 'express'
import crypto from 'crypto'
import {
  requireAuthenticatedUser,
  ensureProfileAccess,
} from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:grantApplications')

const router = express.Router()

const VALID_STATUSES = new Set([
  'draft', 'in_progress', 'submitted', 'under_review', 'awarded', 'denied', 'withdrawn',
])

function normalizeLimit(val, fallback = 200) {
  const n = Number.parseInt(String(val ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(500, n)
}

function mapRow(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    opportunity_id: row.opportunity_id ?? null,
    pipeline_grant_id: row.pipeline_grant_id ?? null,
    user_id: row.user_id,
    status: row.status,
    title: row.title ?? null,
    grant_name: row.grant_name,
    funder_name: row.funder_name ?? null,
    amount_requested: row.amount_requested ?? null,
    amount_awarded: row.amount_awarded ?? null,
    deadline_date: row.deadline_date ?? null,
    submitted_at: row.submitted_at ?? null,
    response_expected_date: row.response_expected_date ?? null,
    response_received_at: row.response_received_at ?? null,
    notes: row.notes ?? null,
    contact_name: row.contact_name ?? null,
    contact_email: row.contact_email ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

// Map a Hamilton application_tasks.status to the tracker's status vocabulary.
function mapHamiltonStatus(taskStatus) {
  const s = String(taskStatus || '')
  if (s === 'submitted') return 'submitted'
  if (s === 'completed' || s === 'completed_draft' || s === 'draft_completed') return 'submitted'
  if (s === 'cancelled') return 'withdrawn'
  // Everything else still in flight (queued/analyzing/filling_portal/generating/
  // waiting_for_review/ready_to_print_mail/ready_to_fax/blocked_*/failed/…) is
  // an in-progress application from the tracker's point of view.
  return 'in_progress'
}

// Pull Hamilton's automated applications (application_tasks) for this caller,
// shaped like grant_applications so the tracker can show them alongside manual
// ones. Read-only; tolerant of the table being absent.
async function fetchHamiltonApplications(db, { isAdmin, userId, filterProfileId, filterStatus, limit }) {
  const clauses = []
  const params = []
  if (!isAdmin) { clauses.push('t.user_id = ?'); params.push(String(userId)) }
  if (filterProfileId) { clauses.push('t.profile_id = ?'); params.push(String(filterProfileId)) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  let rows = []
  try {
    // audit:allow unscoped-profile-query -- application_tasks is filtered by t.profile_id/user_id before joining grant display fields.
    rows = await db.prepare(
      `SELECT t.id, t.profile_id, t.user_id, t.opportunity_id, t.grant_id,
              t.status AS task_status, t.submitted_at, t.created_at, t.updated_at,
              COALESCE(fo.title, g.title) AS title,
              COALESCE(fo.sponsor, g.funder) AS funder_name
         FROM application_tasks t
         LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id
         LEFT JOIN grants g ON g.id = t.grant_id
         ${where}
        ORDER BY t.updated_at DESC LIMIT ?`,
    ).all(...params, Math.min(500, Number(limit) || 200))
  } catch {
    return [] // application_tasks (or a joined table) not present — nothing to merge
  }
  return (rows || [])
    .map((r) => ({
      id: r.id,
      profile_id: r.profile_id,
      opportunity_id: r.opportunity_id ?? null,
      pipeline_grant_id: r.grant_id ?? null,
      user_id: r.user_id,
      status: mapHamiltonStatus(r.task_status),
      title: r.title ?? null,
      grant_name: r.title ?? 'Hamilton application',
      funder_name: r.funder_name ?? null,
      amount_requested: null,
      amount_awarded: null,
      deadline_date: null,
      submitted_at: r.submitted_at ?? null,
      response_expected_date: null,
      response_received_at: null,
      notes: null,
      contact_name: null,
      contact_email: null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
      source: 'hamilton',
    }))
    .filter((r) => !filterStatus || r.status === filterStatus)
}

// GET /api/grant-applications — list applications for authenticated user
router.get('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    if (!userId) return res.status(401).json({ error: 'User ID not found in token' })

    const limit = normalizeLimit(req.query.limit, 200)
    const filterProfileId = req.query.profile_id ? String(req.query.profile_id) : null
    const filterStatus = req.query.status ? String(req.query.status) : null

    const clauses = []
    const params = []

    if (req.ctx?.isAdmin) {
      // Admins see all; optionally filter by profile
      if (filterProfileId) {
        clauses.push('profile_id = ?')
        params.push(filterProfileId)
      }
    } else {
      clauses.push('user_id = ?')
      params.push(String(userId))

      if (filterProfileId) {
        // Verify access before filtering
        const canAccess = await ensureProfileAccess(req, res, filterProfileId)
        if (!canAccess) return
        clauses.push('profile_id = ?')
        params.push(filterProfileId)
      }
    }

    if (filterStatus && VALID_STATUSES.has(filterStatus)) {
      clauses.push('status = ?')
      params.push(filterStatus)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await req.db
      .prepare(
        `SELECT * FROM grant_applications ${where} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit)

    const manual = (rows || []).map(mapRow)

    // Hamilton writes its automated applications to application_tasks, NOT
    // grant_applications, so the tracker used to show nothing for anything
    // Hamilton submitted. Merge Hamilton's tasks in (mapped to the same shape),
    // deduped against manual rows by opportunity, so the tracker reflects BOTH
    // manual applications and everything Hamilton has worked/submitted.
    const hamilton = await fetchHamiltonApplications(req.db, {
      isAdmin: !!req.ctx?.isAdmin, userId: String(userId), filterProfileId, filterStatus, limit,
    }).catch((err) => { routeLogger.warn('[grant-applications] hamilton merge failed:', err?.message); return [] })

    const seenOpp = new Set(manual.map((r) => r.opportunity_id).filter(Boolean))
    const merged = [...manual]
    for (const h of hamilton) {
      if (h.opportunity_id && seenOpp.has(h.opportunity_id)) continue
      merged.push(h)
    }
    merged.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))

    return res.json(merged)
  } catch (error) {
    routeLogger.error('[grant-applications] list error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/grant-applications — create a new application
router.post('/', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    if (!userId) return res.status(401).json({ error: 'User ID not found in token' })

    const data = req.body ?? {}

    const grantName = data.grant_name ? String(data.grant_name).trim() : null
    if (!grantName) return res.status(400).json({ error: 'grant_name is required' })

    const profileId = data.profile_id ? String(data.profile_id) : null
    if (!profileId) return res.status(400).json({ error: 'profile_id is required' })

    if (!req.ctx?.isAdmin) {
      const canAccess = await ensureProfileAccess(req, res, profileId)
      if (!canAccess) return
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    await req.db
      .prepare(
        `INSERT INTO grant_applications (
          id, profile_id, opportunity_id, pipeline_grant_id, user_id,
          status, title, grant_name, funder_name,
          amount_requested, deadline_date, response_expected_date,
          notes, contact_name, contact_email,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        profileId,
        data.opportunity_id ? String(data.opportunity_id) : null,
        data.pipeline_grant_id ? String(data.pipeline_grant_id) : null,
        String(userId),
        'draft',
        data.title ? String(data.title).trim() : null,
        grantName,
        data.funder_name ? String(data.funder_name).trim() : null,
        (data.amount_requested !== null && data.amount_requested !== undefined) ? Number(data.amount_requested) : null,
        data.deadline_date ? String(data.deadline_date) : null,
        data.response_expected_date ? String(data.response_expected_date) : null,
        data.notes ? String(data.notes) : null,
        data.contact_name ? String(data.contact_name).trim() : null,
        data.contact_email ? String(data.contact_email).trim() : null,
        now,
        now,
      )

    const row = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(id)

    return res.status(201).json(mapRow(row))
  } catch (error) {
    routeLogger.error('[grant-applications] create error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// GET /api/grant-applications/:id — get single application
router.get('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    const row = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    if (!row) return res.status(404).json({ error: 'Not found' })

    if (!req.ctx?.isAdmin && String(row.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    return res.json(mapRow(row))
  } catch (error) {
    routeLogger.error('[grant-applications] get error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// PUT /api/grant-applications/:id — update application
router.put('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    const row = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    if (!row) return res.status(404).json({ error: 'Not found' })

    if (!req.ctx?.isAdmin && String(row.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const data = req.body ?? {}

    // Validate status if provided
    if ((data.status !== null && data.status !== undefined) && !VALID_STATUSES.has(String(data.status))) {
      return res.status(400).json({ error: `Invalid status. Valid values: ${[...VALID_STATUSES].join(', ')}` })
    }

    const now = new Date().toISOString()
    const newStatus = (data.status !== null && data.status !== undefined) ? String(data.status) : row.status

    await req.db
      .prepare(
        `UPDATE grant_applications SET
          status = ?,
          title = ?,
          grant_name = ?,
          funder_name = ?,
          amount_requested = ?,
          amount_awarded = ?,
          deadline_date = ?,
          response_expected_date = ?,
          response_received_at = ?,
          notes = ?,
          contact_name = ?,
          contact_email = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        newStatus,
        data.title !== undefined ? (data.title ? String(data.title).trim() : null) : row.title,
        data.grant_name !== undefined ? String(data.grant_name).trim() : row.grant_name,
        data.funder_name !== undefined ? (data.funder_name ? String(data.funder_name).trim() : null) : row.funder_name,
        data.amount_requested !== undefined ? ((data.amount_requested !== null && data.amount_requested !== undefined) ? Number(data.amount_requested) : null) : row.amount_requested,
        data.amount_awarded !== undefined ? ((data.amount_awarded !== null && data.amount_awarded !== undefined) ? Number(data.amount_awarded) : null) : row.amount_awarded,
        data.deadline_date !== undefined ? (data.deadline_date ? String(data.deadline_date) : null) : row.deadline_date,
        data.response_expected_date !== undefined ? (data.response_expected_date ? String(data.response_expected_date) : null) : row.response_expected_date,
        data.response_received_at !== undefined ? (data.response_received_at ? String(data.response_received_at) : null) : row.response_received_at,
        data.notes !== undefined ? (data.notes ? String(data.notes) : null) : row.notes,
        data.contact_name !== undefined ? (data.contact_name ? String(data.contact_name).trim() : null) : row.contact_name,
        data.contact_email !== undefined ? (data.contact_email ? String(data.contact_email).trim() : null) : row.contact_email,
        now,
        String(req.params.id),
      )

    const updated = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    return res.json(mapRow(updated))
  } catch (error) {
    routeLogger.error('[grant-applications] update error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// DELETE /api/grant-applications/:id — delete (only if not submitted)
router.delete('/:id', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    const row = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    if (!row) return res.status(404).json({ error: 'Not found' })

    if (!req.ctx?.isAdmin && String(row.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    if (row.status === 'submitted') {
      return res.status(409).json({ error: 'Cannot delete a submitted application' })
    }

    await req.db
      .prepare('DELETE FROM grant_applications WHERE id = ?')
      .run(String(req.params.id))

    return res.status(204).send()
  } catch (error) {
    routeLogger.error('[grant-applications] delete error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/grant-applications/:id/submit — mark as submitted
router.post('/:id/submit', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    const row = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    if (!row) return res.status(404).json({ error: 'Not found' })

    if (!req.ctx?.isAdmin && String(row.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const now = new Date().toISOString()
    await req.db
      .prepare(
        `UPDATE grant_applications SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, String(req.params.id))

    const updated = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    return res.json(mapRow(updated))
  } catch (error) {
    routeLogger.error('[grant-applications] submit error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

// POST /api/grant-applications/:id/outcome — record awarded/denied outcome
router.post('/:id/outcome', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return

  try {
    const userId = req.ctx?.userId || user?.userId || user?.id || user?.user_id
    const row = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    if (!row) return res.status(404).json({ error: 'Not found' })

    if (!req.ctx?.isAdmin && String(row.user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const data = req.body ?? {}
    const outcome = data.outcome ? String(data.outcome) : null

    if (!outcome || !['awarded', 'denied'].includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be "awarded" or "denied"' })
    }

    const now = new Date().toISOString()
    await req.db
      .prepare(
        `UPDATE grant_applications SET
          status = ?,
          amount_awarded = ?,
          notes = ?,
          response_received_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        outcome,
        (data.amount_awarded !== null && data.amount_awarded !== undefined) ? Number(data.amount_awarded) : row.amount_awarded,
        data.notes !== undefined ? (data.notes ? String(data.notes) : null) : row.notes,
        now,
        now,
        String(req.params.id),
      )

    const updated = await req.db
      .prepare('SELECT * FROM grant_applications WHERE id = ?')
      .get(String(req.params.id))

    return res.json(mapRow(updated))
  } catch (error) {
    routeLogger.error('[grant-applications] outcome error:', error)
    return res.status(500).json({ error: error?.message || String(error) })
  }
})

export default router
