/**
 * Deadline Notification Service
 *
 * Generates in-app notifications for pipeline grants with approaching deadlines.
 * Thresholds: 1 day, 3 days, 7 days before deadline.
 *
 * Run daily alongside expirePassedDeadlines().
 */

import { randomUUID } from 'crypto'
import { dispatchDeadlineAlerts } from './deadlineEmailSmsService.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('deadlineNotificationService')

const THRESHOLDS_DAYS = [7, 3, 1]

// Statuses that are terminal — no notification needed.
const TERMINAL_STATUSES = [
  'awarded',
  'rejected',
  'archived',
  'declined',
  'declined_no_review',
  'deadline_passed',
  'closed',
]

// Statuses that represent actively tracked grants.
const ACTIVE_STATUSES = [
  'discovered',
  'interested',
  'drafting',
  'application_prep',
  'app_prep',
  'revision',
  'portal',
  'submitted',
  'pending_review',
  'follow_up',
  'under_review',
  'discovery',
  'auto_applied',
  'report',
]

/**
 * Ensure the notifications table exists (idempotent).
 */
async function ensureNotificationsTable(db) {
  try {
    await db.prepare('SELECT 1 FROM notifications LIMIT 1').get()
  } catch {
    // Table missing — create it.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    `)
  }
}

/**
 * Generate deadline-approaching notifications for grants in the pipeline.
 *
 * @param {object} db - Dialect-aware db handle
 * @returns {{ created: number }}
 */
export async function generateDeadlineNotifications(db) {
  // Ensure the table is available before doing anything.
  try {
    await ensureNotificationsTable(db)
  } catch (error) {
    console.error('[deadlineNotifications] Could not ensure notifications table:', error?.message || error)
    return { created: 0 }
  }

  const isPostgres = db?.dialect === 'postgres'
  const todayExpr = isPostgres ? 'CURRENT_DATE' : "date('now')"
  const dateAddFn = isPostgres
    ? (days) => `CURRENT_DATE + INTERVAL '${days} days'`
    : (days) => `date('now', '+${days} days')`

  // Query: find grants in active stages where the linked opportunity has a deadline
  // within the next 8 days (covers our 1/3/7-day thresholds with a small buffer).
  const inStatusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ')

  let candidates = []
  try {
    candidates = await db
      .prepare(
        `SELECT
           g.id AS grant_id,
           g.status AS grant_status,
           g.funding_opportunity_id AS opportunity_id,
           g.title AS grant_title,
           fo.title AS opp_title,
           fo.deadline AS deadline,
           u.id AS user_id,
           u.primary_email AS user_email,
           u.primary_phone AS user_phone,
           p.id AS profile_id
         FROM grants g
         JOIN funding_opportunities fo
           ON fo.id = g.funding_opportunity_id
         JOIN profiles p
           ON p.id = g.profile_id
         JOIN users u
           ON u.id = p.user_id
         WHERE g.status IN (${inStatusPlaceholders})
           AND fo.deadline IS NOT NULL
           AND fo.deadline >= ${todayExpr}
           AND fo.deadline <= ${dateAddFn(8)}
           AND g.profile_id IS NOT NULL
           AND p.user_id IS NOT NULL`,
      )
      .all(...ACTIVE_STATUSES)
  } catch (error) {
    // Best-effort: if the query fails (e.g. missing column), log and return.
    console.warn('[deadlineNotifications] Candidate query failed:', error?.message || error)
    return { created: 0 }
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    log.info('[deadlineNotifications] No approaching deadlines found')
    return { created: 0 }
  }

  let created = 0

  for (const row of candidates) {
    const deadline = row.deadline ? new Date(row.deadline) : null
    if (!deadline) continue

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    deadline.setHours(0, 0, 0, 0)
    const diffMs = deadline - today
    const daysRemaining = Math.round(diffMs / (1000 * 60 * 60 * 24))

    // Only notify at exact thresholds.
    if (!THRESHOLDS_DAYS.includes(daysRemaining)) continue

    const userId = row.user_id
    const grantId = row.grant_id
    const oppId = row.opportunity_id
    const title = row.opp_title || row.grant_title || 'Grant deadline approaching'
    const threshold = daysRemaining

    // Build notification content first so we can use the title as a dedup key.
    const dayLabel = threshold === 1 ? 'tomorrow' : `in ${threshold} days`
    const notifTitle = `Deadline ${dayLabel}: ${title}`

    // Dedup: check if we already sent this exact notification today (same user + title).
    // The title encodes the grant title and day threshold, making it a reliable dedup key.
    const dupCheckExpr = isPostgres
      ? `created_at >= CURRENT_DATE::TIMESTAMP`
      : `created_at >= date('now')`

    try {
      const existing = await db
        .prepare(
          `SELECT id FROM notifications
           WHERE user_id = ?
             AND type = 'deadline_approaching'
             AND title = ?
             AND ${dupCheckExpr}
           LIMIT 1`,
        )
        .get(userId, notifTitle)

      if (existing) continue
    } catch (error) {
      // Dedup check failed — skip this notification to be safe.
      console.warn('[deadlineNotifications] Dedup check failed:', error?.message || error)
      continue
    }
    const notifMessage =
      threshold === 1
        ? `The deadline for "${title}" is tomorrow. Make sure your application is ready to submit.`
        : `The deadline for "${title}" is in ${threshold} days (${row.deadline}). Don't miss it!`

    const data = JSON.stringify({
      grant_id: grantId,
      opportunity_id: oppId,
      days_remaining: threshold,
      deadline: row.deadline,
    })

    // 30-day expiry (stale notifications auto-clean).
    const expiresAt = isPostgres
      ? `NOW() + INTERVAL '30 days'`
      : `datetime('now', '+30 days')`

    try {
      await db
        .prepare(
          `INSERT INTO notifications (id, user_id, type, title, message, data, read, expires_at)
           VALUES (?, ?, 'deadline_approaching', ?, ?, ?, 0, ${expiresAt})`,
        )
        .run(randomUUID(), userId, notifTitle, notifMessage, data)
      created++

      // Dispatch email/SMS (best-effort, non-blocking)
      dispatchDeadlineAlerts(db, {
        userId,
        userEmail: row.user_email,
        userPhone: row.user_phone,
        grantTitle: title,
        daysRemaining: threshold,
        deadline: row.deadline,
      }).catch((err) => console.warn('[deadlineNotifications] Email/SMS dispatch failed:', err?.message))
    } catch (error) {
      console.warn('[deadlineNotifications] Failed to insert notification:', error?.message || error)
    }
  }

  if (created > 0) {
    log.info('[deadlineNotifications] Created notifications', { created })
  }

  return { created }
}
