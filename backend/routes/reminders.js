import { Router } from 'express';

const router = Router();

export const DAYS_LOOKAHEAD = 30;

function normalizeDeadline(row) {
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    funder: row.funder,
    organizationName: row.organization_name,
    deadline: row.deadline,
    status: row.status,
    daysRemaining: typeof row.days_until === 'number' ? row.days_until : null,
    opportunityType: row.opportunity_type ?? null,
    amountRequested: row.amount_requested ?? null,
  };
}

function normalizeMilestone(row) {
  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    type: row.type,
    reminderDays: row.reminder_days,
    grantTitle: row.grant_title,
    organizationName: row.organization_name,
    daysRemaining: typeof row.days_until === 'number' ? row.days_until : null,
  };
}

export function fetchReminderSnapshot(db, lookaheadDays = DAYS_LOOKAHEAD) {
  const deadlineRows = db.prepare(
    `
      SELECT
        g.id,
        g.title,
        g.funder,
        g.deadline,
        g.status,
        g.amount_requested,
        g.opportunity_type,
        o.name AS organization_name,
        CAST(
          ROUND(JULIANDAY(g.deadline) - JULIANDAY('now'))
        ) AS days_until
      FROM grants g
      LEFT JOIN organizations o ON o.id = g.organization_id
      WHERE g.deadline IS NOT NULL
        AND DATE(g.deadline) >= DATE('now')
        AND DATE(g.deadline) <= DATE('now', ? || ' days')
        AND g.status IN ('discovered', 'interested', 'drafting', 'app_prep', 'submission_ready')
      ORDER BY DATE(g.deadline) ASC
      LIMIT 10
    `,
  ).all(lookaheadDays);

  const milestoneRows = db.prepare(
    `
      SELECT
        m.id,
        m.title,
        m.description,
        m.due_date,
        m.type,
        m.reminder_days,
        g.title AS grant_title,
        o.name AS organization_name,
        CAST(
          ROUND(JULIANDAY(m.due_date) - JULIANDAY('now'))
        ) AS days_until
      FROM milestones m
      LEFT JOIN grants g ON g.id = m.grant_id
      LEFT JOIN organizations o ON o.id = m.organization_id
      WHERE m.completed = 0
        AND m.due_date IS NOT NULL
        AND DATE(m.due_date) >= DATE('now')
        AND DATE(m.due_date) <= DATE('now', ? || ' days')
      ORDER BY DATE(m.due_date) ASC
      LIMIT 10
    `,
  ).all(lookaheadDays);

  return {
    urgentDeadlines: deadlineRows.map(normalizeDeadline).filter(Boolean),
    upcomingMilestones: milestoneRows.map(normalizeMilestone).filter(Boolean),
  };
}

router.get('/', (req, res) => {
  try {
    const snapshot = fetchReminderSnapshot(req.db);

    res.json({
      generatedAt: new Date().toISOString(),
      ...snapshot,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
