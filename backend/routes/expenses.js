import express from 'express';
import crypto from 'crypto';
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  getAccessibleOrganizationIds,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:expenses')

const router = express.Router();

async function ensureExpenseAccess(req, res, expenseId) {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return null

  const expense = await req.db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId)
  if (!expense) {
    res.status(404).json({ error: 'Not found' })
    return null
  }

  if (req.ctx?.isAdmin === true) return expense

  if (expense.grant_id) {
    // Will 403/404 as needed.
    const grant = await ensureGrantAccess(req, res, String(expense.grant_id))
    if (!grant) return null
    return expense
  }

  if (expense.organization_id) {
    if (!(await ensureOrganizationAccess(req, res, String(expense.organization_id)))) return null
    return expense
  }

  res.status(403).json({ error: 'Not authorized' })
  return null
}

// Move this line to the top after const router = express.Router();
router.get('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const { grant_id, organization_id } = req.query;
    let query = 'SELECT * FROM expenses WHERE 1=1';
    const params = [];

    if (grant_id) {
      const grant = await ensureGrantAccess(req, res, String(grant_id))
      if (!grant) return
      query += ' AND grant_id = ?'
      params.push(String(grant_id))
    }

    if (organization_id) {
      if (!(await ensureOrganizationAccess(req, res, String(organization_id)))) return
      query += ' AND organization_id = ?'
      params.push(String(organization_id))
    }

    if (req.ctx?.isAdmin !== true) {
      if (!grant_id && !organization_id) {
        const orgIds = await getAccessibleOrganizationIds(req.db, user)
        if (!orgIds || orgIds.size === 0) return res.status(403).json({ error: 'No accessible organizations' })
        const placeholders = Array.from(orgIds).map(() => '?').join(',')
        query += ` AND organization_id IN (${placeholders})`
        params.push(...Array.from(orgIds))
      }
      // When grant_id or organization_id IS supplied, ensureGrantAccess /
      // ensureOrganizationAccess above already verified access â no extra
      // row-level restriction needed.
    }

    query += ' ORDER BY date DESC LIMIT 1000';
    res.json(await req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res);
    if (!user) return;

    const id = crypto.randomUUID();
    const { grant_id, organization_id, description, amount, category, date } = req.body;

    if (grant_id) {
      const grant = await ensureGrantAccess(req, res, String(grant_id))
      if (!grant) return
    } else if (organization_id) {
      if (!(await ensureOrganizationAccess(req, res, String(organization_id)))) return
    } else {
      return res.status(400).json({ error: 'grant_id or organization_id is required' })
    }

    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ error: 'amount must be a non-negative number' });
    }

    await req.db
      .prepare(
        'INSERT INTO expenses (id, grant_id, organization_id, description, amount, category, date) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, grant_id, organization_id, description, parsedAmount, category, date);
    res.status(201).json(await req.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await ensureExpenseAccess(req, res, req.params.id)
    if (!existing) return

    const { description, amount, category, date, approved } = req.body;
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ error: 'amount must be a non-negative number' });
    }
    await req.db
      .prepare('UPDATE expenses SET description = ?, amount = ?, category = ?, date = ?, approved = ? WHERE id = ?')
      .run(description, parsedAmount, category, date, Boolean(approved), req.params.id);
    res.json(await req.db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await ensureExpenseAccess(req, res, req.params.id)
    if (!existing) return

    await req.db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
