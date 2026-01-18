import express from 'express';
import crypto from 'crypto';
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  getAccessibleOrganizationIds,
  isAdminUser,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'

const router = express.Router();

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

  if (isAdminUser(user)) return row

  const orgId = row.grant_organization_id ?? row.organization_id ?? null
  if (orgId && (await ensureOrganizationAccess(req, res, String(orgId)))) {
    return row
  }

  // ensureOrganizationAccess already sent the 403 if orgId existed.
  if (!orgId) {
    res.status(403).json({ error: 'Not authorized' })
  }
  return null
}

router.get('/', (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { grant_id, completed, upcoming } = req.query;
    let query = 'SELECT m.*, g.title as grant_title, g.organization_id as grant_organization_id FROM milestones m LEFT JOIN grants g ON m.grant_id = g.id WHERE 1=1';
    const params = [];
    
    if (grant_id) {
      Promise.resolve()
        .then(async () => {
          const grant = await ensureGrantAccess(req, res, String(grant_id))
          if (!grant) return
          query += ' AND m.grant_id = ?'
          params.push(String(grant_id))
          // continue building below
          if (completed === 'true') query += ' AND m.completed = 1';
          if (completed === 'false') query += req.db?.dialect === 'postgres' ? ' AND m.completed = FALSE' : ' AND m.completed = 0';
          if (upcoming === 'true')
            query +=
              req.db?.dialect === 'postgres'
                ? ' AND m.due_date >= CURRENT_DATE AND m.completed = FALSE'
                : " AND m.due_date >= date('now') AND m.completed = 0";

          query += ' ORDER BY m.due_date ASC';
          const milestones = req.db.prepare(query).all(...params);
          res.json(milestones);
        })
        .catch((error) => res.status(500).json({ error: error.message }))
      return
    }

    // No grant filter: restrict to accessible organizations for non-admins.
    if (!isAdminUser(user)) {
      Promise.resolve()
        .then(async () => {
          const orgIds = await getAccessibleOrganizationIds(req.db, user)
          if (!orgIds || orgIds.size === 0) return res.json([])
          const placeholders = Array.from(orgIds).map(() => '?').join(',')
          query += ` AND g.organization_id IN (${placeholders})`
          params.push(...Array.from(orgIds))

          if (completed === 'true') query += ' AND m.completed = 1';
          if (completed === 'false') query += req.db?.dialect === 'postgres' ? ' AND m.completed = FALSE' : ' AND m.completed = 0';
          if (upcoming === 'true')
            query +=
              req.db?.dialect === 'postgres'
                ? ' AND m.due_date >= CURRENT_DATE AND m.completed = FALSE'
                : " AND m.due_date >= date('now') AND m.completed = 0";

          query += ' ORDER BY m.due_date ASC';
          const milestones = req.db.prepare(query).all(...params);
          res.json(milestones);
        })
        .catch((error) => res.status(500).json({ error: error.message }))
      return
    }

    if (completed === 'true') query += ' AND m.completed = 1';
    if (completed === 'false') query += req.db?.dialect === 'postgres' ? ' AND m.completed = FALSE' : ' AND m.completed = 0';
    if (upcoming === 'true')
      query +=
        req.db?.dialect === 'postgres'
          ? ' AND m.due_date >= CURRENT_DATE AND m.completed = FALSE'
          : " AND m.due_date >= date('now') AND m.completed = 0";
    
    query += ' ORDER BY m.due_date ASC';
    const milestones = req.db.prepare(query).all(...params);
    res.json(milestones);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const milestone = await ensureMilestoneAccess(req, res, req.params.id)
      if (!milestone) return
      res.json(milestone)
    })
    .catch((error) => res.status(500).json({ error: error.message }))
});

router.post('/', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const user = requireAuthenticatedUser(req, res)
      if (!user) return

      const id = crypto.randomUUID();
      const { grant_id, title, description, due_date, type } = req.body;
      if (!grant_id) return res.status(400).json({ error: 'grant_id is required' })

      const grant = await ensureGrantAccess(req, res, String(grant_id))
      if (!grant) return

      req.db
        .prepare('INSERT INTO milestones (id, grant_id, title, description, due_date, type) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, grant_id, title, description, due_date, type);
      const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(id);
      res.status(201).json(milestone);
    })
    .catch((error) => res.status(500).json({ error: error.message }))
});

router.put('/:id', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const existing = await ensureMilestoneAccess(req, res, req.params.id)
      if (!existing) return
      const { title, description, due_date, completed, type } = req.body;
      const completed_date = completed ? new Date().toISOString().split('T')[0] : null;
      req.db
        .prepare(
          'UPDATE milestones SET title = ?, description = ?, due_date = ?, completed = ?, completed_date = ?, type = ? WHERE id = ?',
        )
        .run(title, description, due_date, completed ? 1 : 0, completed_date, type, req.params.id);
      const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
      res.json(milestone);
    })
    .catch((error) => res.status(500).json({ error: error.message }))
});

router.patch('/:id/complete', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const existing = await ensureMilestoneAccess(req, res, req.params.id)
      if (!existing) return
      const completed_date = new Date().toISOString().split('T')[0];
      req.db
        .prepare('UPDATE milestones SET completed = 1, completed_date = ? WHERE id = ?')
        .run(completed_date, req.params.id);
      const milestone = req.db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
      res.json(milestone);
    })
    .catch((error) => res.status(500).json({ error: error.message }))
});

router.delete('/:id', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const existing = await ensureMilestoneAccess(req, res, req.params.id)
      if (!existing) return
      req.db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    })
    .catch((error) => res.status(500).json({ error: error.message }))
});

export default router;
