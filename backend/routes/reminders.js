import { Router } from 'express';
import { getAccessibleOrganizationIds, isAdminUser, requireAuthenticatedUser } from '../utils/accessControl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:reminders')

const router = Router();

export const DAYS_LOOKAHEAD = 30;

function normalizeDeadline(row) {
  if (!row) return null;

  // Calculate days_until in JavaScript
  let daysRemaining = null;
  if (row.deadline) {
    const deadlineDate = new Date(row.deadline);
    const now = new Date();
    // Set both to start of day for accurate day counting
    deadlineDate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    const diffMs = deadlineDate - now;
    daysRemaining = Math.round(diffMs / (1000 * 60 * 60 * 24));
  }

  return {
    id: row.id,
    title: row.title,
    funder: row.funder,
    organizationName: row.organization_name,
    deadline: row.deadline,
    status: row.status,
    daysRemaining,
    amountRequested: row.amount_requested ?? null,
  };
}

function normalizeMilestone(row) {
  if (!row) return null;

  // Calculate days_until in JavaScript
  let daysRemaining = null;
  if (row.due_date) {
    const dueDate = new Date(row.due_date);
    const now = new Date();
    // Set both to start of day for accurate day counting
    dueDate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    const diffMs = dueDate - now;
    daysRemaining = Math.round(diffMs / (1000 * 60 * 60 * 24));
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    type: row.type,
    reminderDays: row.reminder_days,
    grantTitle: row.grant_title,
    organizationName: row.organization_name,
    daysRemaining,
  };
}

export async function fetchReminderSnapshot(db, lookaheadDays = DAYS_LOOKAHEAD, options = {}) {
  const organizationIds =
    options && Array.isArray(options.organizationIds) 
      ? options.organizationIds.filter(id => (id !== null && id !== undefined) && (typeof id === 'number' || typeof id === 'string'))
      : null

  // Compute date window boundaries in JavaScript
  const now = new Date();
  now.setHours(0, 0, 0, 0); // Start of today
  
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + lookaheadDays);
  
  // Format as ISO date strings (YYYY-MM-DD) for SQL comparison
  const todayStr = now.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

  const deadlineConditions = [
    'g.deadline IS NOT NULL',
    'g.deadline >= ?',
    'g.deadline <= ?',
    // Canonical pipeline stages (shared/pipelineStages.js) for which an
    // upcoming deadline is actionable. NOTE: must use canonical names — the
    // old 'submission_ready' is not a real stage, so the filter silently
    // matched nothing and deadline reminders never fired.
    "g.status IN ('discovered', 'interested', 'gathering_documents', 'drafting', 'ready_to_submit', 'app_prep')",
  ]
  const deadlineParams = [todayStr, endDateStr]

  if (organizationIds && organizationIds.length > 0) {
    deadlineConditions.push(`g.organization_id IN (${organizationIds.map(() => '?').join(',')})`)
    deadlineParams.push(...organizationIds)
  }

  const deadlineRows = await db
    .prepare(
      `
        SELECT
          g.id,
          g.title,
          g.funder,
          g.deadline,
          g.status,
          g.amount_requested,
          o.name AS organization_name
        FROM grants g
        LEFT JOIN organizations o ON o.id = g.organization_id
        WHERE ${deadlineConditions.join('\n        AND ')}
        ORDER BY g.deadline ASC
        LIMIT 10
      `,
    )
    .all(...deadlineParams);

  const milestoneSql =
    db?.dialect === 'postgres'
      ? `
          SELECT
            m.id,
            m.title,
            m.description,
            m.due_date,
            m.type,
            m.reminder_days,
            g.title AS grant_title,
            o.name AS organization_name
          FROM milestones m
          LEFT JOIN grants g ON g.id = m.grant_id
          LEFT JOIN organizations o ON o.id = m.organization_id
          WHERE m.completed = FALSE
            AND m.due_date IS NOT NULL
            AND m.due_date >= ?
            AND m.due_date <= ?
          ORDER BY m.due_date ASC
          LIMIT 10
        `
      : `
          SELECT
            m.id,
            m.title,
            m.description,
            m.due_date,
            m.type,
            m.reminder_days,
            g.title AS grant_title,
            o.name AS organization_name
          FROM milestones m
          LEFT JOIN grants g ON g.id = m.grant_id
          LEFT JOIN organizations o ON o.id = m.organization_id
          -- m.completed is BOOLEAN; NOT m.completed is portable, = 0 is not
          -- (Postgres raises operator does not exist: boolean = integer).
          WHERE NOT m.completed
            AND m.due_date IS NOT NULL
            AND m.due_date >= ?
            AND m.due_date <= ?
          ORDER BY m.due_date ASC
          LIMIT 10
        `;

  const milestoneParams = [todayStr, endDateStr]

  // m.completed predicate differs per dialect and is already baked into milestoneSql; keep the filter separate.
  let milestoneSqlWithScope = milestoneSql

  if (organizationIds && organizationIds.length > 0) {
    const placeholders = organizationIds.map(() => '?').join(',')
    const orgClause = `AND COALESCE(m.organization_id, g.organization_id) IN (${placeholders})`
    // Inject the org scope before `AND m.due_date IS NOT NULL`, which is present
    // in BOTH dialect queries. The old code replaced 'WHERE m.completed', which
    // (a) built `WHERE AND COALESCE…` on Postgres (`WHERE m.completed = FALSE`)
    // → invalid SQL → 500 → Dashboard failed to load, and (b) matched nothing on
    // SQLite (`WHERE NOT m.completed`) → the org scope was silently dropped.
    milestoneSqlWithScope = milestoneSqlWithScope.replace(
      'AND m.due_date IS NOT NULL',
      `${orgClause}\n            AND m.due_date IS NOT NULL`
    )
    milestoneParams.push(...organizationIds)
  }

  const milestoneRows = await db.prepare(milestoneSqlWithScope).all(...milestoneParams);

  return {
    urgentDeadlines: deadlineRows.map(normalizeDeadline).filter(Boolean),
    upcomingMilestones: milestoneRows.map(normalizeMilestone).filter(Boolean),
  };
}

router.get('/', async (req, res) => {
  try {
    // AUTH GUARD: Require authentication
    const user = requireAuthenticatedUser(req, res)
    if (!user) {
      return;
    }
    
    if (!req.db) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[reminders] Database connection not available');
      }
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const snapshot = await (async () => {
      if (isAdminUser(user)) return await fetchReminderSnapshot(req.db)
      const orgIds = await getAccessibleOrganizationIds(req.db, user)
      return await fetchReminderSnapshot(req.db, DAYS_LOOKAHEAD, {
        organizationIds: Array.isArray(orgIds) ? Array.from(orgIds) : [],
      })
    })()
    
    res.json({
      generatedAt: new Date().toISOString(),
      ...snapshot,
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[reminders] Error:', error.message);
    }
    
    // Never expose stack traces in production
    const errorResponse = { error: 'Failed to fetch reminders' };
    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = error.message;
    }
    
    res.status(500).json(errorResponse);
  }
});

export default router;
