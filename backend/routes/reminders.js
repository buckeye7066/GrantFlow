import { Router } from 'express';

const router = Router();
const isDevEnv = process.env.NODE_ENV !== 'production';

export const DAYS_LOOKAHEAD = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function toDate(value) {
  if (!value || typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function calculateDaysRemaining(dateValue, startOfToday) {
  const target = toDate(dateValue);
  if (!target) return null;
  return Math.floor((target.getTime() - startOfToday.getTime()) / MS_PER_DAY);
}

function isWithinWindow(dateValue, startOfToday, endOfWindow) {
  const target = toDate(dateValue);
  if (!target) return false;
  return target.getTime() >= startOfToday.getTime() && target.getTime() <= endOfWindow.getTime();
}

export function fetchReminderSnapshot(db, lookaheadDays = DAYS_LOOKAHEAD) {
  const normalized =
    typeof lookaheadDays === 'number' && Number.isFinite(lookaheadDays) && lookaheadDays > 0
      ? Math.min(Math.max(Math.floor(lookaheadDays), 1), 180)
      : DAYS_LOOKAHEAD;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfWindow = new Date(startOfToday.getTime() + normalized * MS_PER_DAY);

  if (isDevEnv) {
    console.info('[reminders] fetching snapshot', {
      lookaheadDays,
      normalized,
      start: startOfToday.toISOString(),
      end: endOfWindow.toISOString(),
    });
  }

  const rawDeadlines = db
    .prepare(
      `
        SELECT
          g.id,
          g.title,
          g.funder,
          g.deadline,
          g.status,
          g.amount_requested,
          g.opportunity_type,
          o.name AS organization_name
        FROM grants g
        LEFT JOIN organizations o ON o.id = g.organization_id
        WHERE g.deadline IS NOT NULL
          AND g.status IN ('discovered', 'interested', 'drafting', 'app_prep', 'submission_ready')
      `,
    )
    .all();

  const rawMilestones = db
    .prepare(
      `
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
        WHERE m.completed = 0
          AND m.due_date IS NOT NULL
      `,
    )
    .all();

  const urgentDeadlines = rawDeadlines
    .filter((row) => isWithinWindow(row.deadline, startOfToday, endOfWindow))
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
    .slice(0, 10)
    .map((row) =>
      normalizeDeadline({
        ...row,
        days_until: calculateDaysRemaining(row.deadline, startOfToday),
      }),
    )
    .filter(Boolean);

  const upcomingMilestones = rawMilestones
    .filter((row) => isWithinWindow(row.due_date, startOfToday, endOfWindow))
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
    .slice(0, 10)
    .map((row) =>
      normalizeMilestone({
        ...row,
        days_until: calculateDaysRemaining(row.due_date, startOfToday),
      }),
    )
    .filter(Boolean);

  return {
    urgentDeadlines,
    upcomingMilestones,
  };
}

router.get('/', async (req, res) => {
  if (!req.user || req.user.role === 'guest') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const snapshot = fetchReminderSnapshot(req.db);

    res.json({
      generatedAt: new Date().toISOString(),
      ...snapshot,
    });
  } catch (error) {
    if (isDevEnv) {
      console.error('[reminders] error generating snapshot', error);
    }
    res.status(500).json({ error: 'Failed to load reminders' });
  }
});

export default router;
