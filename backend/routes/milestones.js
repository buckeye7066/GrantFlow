import express from 'express';
import crypto from 'crypto';
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  getAccessibleOrganizationIds,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:milestones')

const router = express.Router();

// Apply authentication middleware to all routes
router.use(async (req, res, next) => {
  try {
    const user = requireAuthenticatedUser(req, res);
    if (!user) return; // requireAuthenticatedUser already sent 401
    next();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Authentication check failed' });
    } else {
      next(error);
    }
  }
});

async function ensureMilestoneAccess(req, res, milestoneId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null

  const row = await req.db
    .prepare(
      `
        SELECT
          m.*,
          g.organization_id AS grant_organization_id
        FROM milestones m
        LEFT JOIN grants g ON g.id = m.grant_id
        WHERE m.id = ?
        LIMIT 1
      `,
    )
    .get(milestoneId)

  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return null
  }

  if (req.ctx?.isAdmin === true) return row

  const orgId = row.grant_organization_id ?? row.organization_id ?? null
  if (!orgId) {
    res.status(403).json({ error: 'Not authorized' })
    return null
  }
  const access = await ensureOrganizationAccess(req, res, String(orgId))
  if (!access) {
    // ensureOrganizationAccess already sent 403
    return null
  }
  return row
}

router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { grant_id, completed, upcoming } = req.query
    let query =
      'SELECT m.*, g.title as grant_title, g.organization_id as grant_organization_id FROM milestones m LEFT JOIN grants g ON m.grant_id = g.id WHERE 1=1'
    const params = []

    // If grant_id specified, validate access to that grant
    if (grant_id) {
      const grant = await ensureGrantAccess(req, res, String(grant_id))
      if (!grant) return // ensureGrantAccess already sent 403/404
      query += ' AND m.grant_id = ?'
      params.push(String(grant_id))
    } else if (req.ctx?.isAdmin !== true) {
      // No grant specified: limit to accessible organizations
      const orgIds = await getAccessibleOrganizationIds(req.db, user)
      if (!orgIds || orgIds.size === 0) {
        console.warn('[milestones] GET / - user has no accessible organizations, returning empty list', { userId: user.id });
        return res.json([]);
      }
      const placeholders = Array.from(orgIds)
        .map(() => '?')
        .join(',')
      // Milestones can be org-scoped or grant-scoped; filter by either
      query += ` AND (COALESCE(m.organization_id, g.organization_id) IN (${placeholders}) OR m.grant_id IN (SELECT id FROM grants WHERE organization_id IN (${placeholders})))`
      params.push(...Array.from(orgIds))
      params.push(...Array.from(orgIds))
    }

    // Apply filter conditions.
    // milestones.completed is BOOLEAN; use it directly (and NOT …) rather than
    // `= 1`/`= 0`, which is fine in SQLite (0/1 ints) but raises
    // "operator does not exist: boolean = integer" in Postgres. Bare boolean
    // truthiness is portable across both dialects.
    if (completed === 'true') query += ' AND m.completed'
    if (completed === 'false') {
      query += ' AND NOT m.completed'
    }
    if (upcoming === 'true') {
      query +=
        req.db?.dialect === 'postgres'
          ? ' AND m.due_date >= CURRENT_DATE AND m.completed = FALSE'
          : " AND m.due_date >= date('now') AND m.completed = 0"
    }

    query += ' ORDER BY m.due_date ASC'
    const milestones = await req.db.prepare(query).all(...params)
    res.json(milestones)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const milestone = await ensureMilestoneAccess(req, res, req.params.id)
    if (!milestone) return
    res.json(milestone)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const id = crypto.randomUUID()
    const { grant_id, title, description, due_date, type } = req.body
    if (!grant_id) return res.status(400).json({ error: 'grant_id is required' })
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' })
    if (!due_date) return res.status(400).json({ error: 'due_date is required' })
if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || isNaN(Date.parse(due_date))) return res.status(400).json({ error: 'due_date must be a valid date (YYYY-MM-DD)' })
    const grant = await ensureGrantAccess(req, res, String(grant_id))
    if (!grant) return
    await req.db
      .prepare('INSERT INTO milestones (id, grant_id, title, description, due_date, type) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, grant_id, title, description, due_date, type)
    const milestone = await req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(id)
    res.status(201).json(milestone)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const existing = await ensureMilestoneAccess(req, res, req.params.id)
    if (!existing) return
    const { title, description, due_date, completed, type } = req.body
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' })
    if (!due_date) return res.status(400).json({ error: 'due_date is required' })
if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || isNaN(Date.parse(due_date))) return res.status(400).json({ error: 'due_date must be a valid date (YYYY-MM-DD)' })
    const completed_date = completed ? new Date().toISOString().split('T')[0] : null
    await req.db
      .prepare(
        'UPDATE milestones SET title = ?, description = ?, due_date = ?, completed = ?, completed_date = ?, type = ? WHERE id = ?'
      )
      .run(title, description, due_date, completed ? 1 : 0, completed_date, type, req.params.id)
    const milestone = await req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id)
    res.json(milestone)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.patch('/:id/complete', async (req, res) => {
  try {
    const existing = await ensureMilestoneAccess(req, res, req.params.id)
    if (!existing) return
    const completed_date = new Date().toISOString().split('T')[0]
    await req.db
      .prepare('UPDATE milestones SET completed = ?, completed_date = ? WHERE id = ?')
      .run(1, completed_date, req.params.id)
    const milestone = await req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id)
    res.json(milestone)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const existing = await ensureMilestoneAccess(req, res, req.params.id)
    if (!existing) return
    await req.db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id)
    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

export default router;
