import { Router } from 'express';

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
    opportunityType: row.opportunity_type ?? null,
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

export function fetchReminderSnapshot(db, lookaheadDays = DAYS_LOOKAHEAD) {
  // Compute date window boundaries in JavaScript
  const now = new Date();
  now.setHours(0, 0, 0, 0); // Start of today
  
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + lookaheadDays);
  
  // Format as ISO date strings (YYYY-MM-DD) for SQL comparison
  const todayStr = now.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];

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
        o.name AS organization_name
      FROM grants g
      LEFT JOIN organizations o ON o.id = g.organization_id
      WHERE g.deadline IS NOT NULL
        AND g.deadline >= ?
        AND g.deadline <= ?
        AND g.status IN ('discovered', 'interested', 'drafting', 'app_prep', 'submission_ready')
      ORDER BY g.deadline ASC
      LIMIT 10
    `,
  ).all(todayStr, endDateStr);

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
        o.name AS organization_name
      FROM milestones m
      LEFT JOIN grants g ON g.id = m.grant_id
      LEFT JOIN organizations o ON o.id = m.organization_id
      WHERE m.completed = 0
        AND m.due_date IS NOT NULL
        AND m.due_date >= ?
        AND m.due_date <= ?
      ORDER BY m.due_date ASC
      LIMIT 10
    `,
  ).all(todayStr, endDateStr);

  return {
    urgentDeadlines: deadlineRows.map(normalizeDeadline).filter(Boolean),
    upcomingMilestones: milestoneRows.map(normalizeMilestone).filter(Boolean),
  };
}

router.get('/', async (req, res) => {
  try {
    // AUTH GUARD: Require authentication
    if (!req.user || req.user.role === 'guest') {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'You must be logged in to view reminders'
      });
    }
    
    if (!req.db) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[reminders] Database connection not available');
      }
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const snapshot = fetchReminderSnapshot(req.db);
    
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
