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
import { getProfileLanguage, getUserLanguage } from './comms/profileLanguage.js'
import { ensureNotificationsTable } from './notificationService.js'
export { emitOpportunityChangeNotifications } from './notificationService.js'
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

// Application-tracker statuses that are still actively working toward a deadline.
// grant_applications is a distinct feature from the grants pipeline (see RC-13);
// its lifecycle is: draft, in_progress, submitted, under_review, awarded, denied,
// withdrawn. Terminal = awarded / denied / withdrawn.
const APPLICATION_ACTIVE_STATUSES = ['draft', 'in_progress', 'submitted', 'under_review']

/**
 * Days remaining until a date, normalized to whole days at local midnight.
 * Returns null when the value can't be parsed.
 */
function daysUntil(value) {
  if (!value) return null
  const deadline = new Date(value)
  if (Number.isNaN(deadline.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  deadline.setHours(0, 0, 0, 0)
  return Math.round((deadline - today) / (1000 * 60 * 60 * 24))
}

/**
 * Dedup + insert a single deadline notification and fire the email/SMS alert.
 * Shared by both the pipeline (grants) and application-tracker (grant_applications)
 * sources so their behavior, dedup, and expiry stay identical.
 *
 * @returns {Promise<boolean>} true when a notification was created.
 */
async function emitDeadlineNotification(db, isPostgres, { userId, userEmail, userPhone, profileId, title, deadline, daysRemaining, data }) {
  if (!userId) return false
  const dayLabel = daysRemaining === 1 ? 'tomorrow' : `in ${daysRemaining} days`
  const notifTitle = `Deadline ${dayLabel}: ${title}`

  // Dedup: one notification per (user, title) per day. The title encodes the
  // grant/application title and day threshold, making it a reliable dedup key.
  const dupCheckExpr = isPostgres ? `created_at >= CURRENT_DATE::TIMESTAMP` : `created_at >= date('now')`
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
    if (existing) return false
  } catch (error) {
    console.warn('[deadlineNotifications] Dedup check failed:', error?.message || error)
    return false
  }

  const notifMessage =
    daysRemaining === 1
      ? `The deadline for "${title}" is tomorrow. Make sure your application is ready to submit.`
      : `The deadline for "${title}" is in ${daysRemaining} days (${deadline}). Don't miss it!`

  const expiresAt = isPostgres ? `NOW() + INTERVAL '30 days'` : `datetime('now', '+30 days')`

  try {
    await db
      .prepare(
        `INSERT INTO notifications (id, user_id, type, title, message, data, read, expires_at)
         VALUES (?, ?, 'deadline_approaching', ?, ?, ?, 0, ${expiresAt})`,
      )
      .run(randomUUID(), userId, notifTitle, notifMessage, JSON.stringify(data))

    // Resolve the recipient's preferred language: prefer the specific profile
    // (pipeline path has it) and fall back to any of the user's profiles.
    let lang = 'en'
    try {
      lang = profileId ? await getProfileLanguage(db, profileId) : await getUserLanguage(db, userId)
    } catch { lang = 'en' }

    dispatchDeadlineAlerts(db, {
      userId,
      userEmail,
      userPhone,
      grantTitle: title,
      daysRemaining,
      deadline,
      lang,
    }).catch((err) => console.warn('[deadlineNotifications] Email/SMS dispatch failed:', err?.message))
    return true
  } catch (error) {
    console.warn('[deadlineNotifications] Failed to insert notification:', error?.message || error)
    return false
  }
}

/**
 * Notifications for grants in the discovery→submission pipeline (grants table).
 */
async function notifyPipelineDeadlines(db, isPostgres, todayExpr, dateAddFn) {
  const inStatusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ')
  let candidates = []
  try {
    candidates = await db
      .prepare(
        `SELECT
           g.id AS grant_id,
           g.funding_opportunity_id AS opportunity_id,
           g.title AS grant_title,
           fo.title AS opp_title,
           fo.deadline AS deadline,
           p.id AS profile_id,
           u.id AS user_id,
           u.primary_email AS user_email,
           u.primary_phone AS user_phone
         FROM grants g
         JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
         JOIN profiles p ON p.id = g.profile_id
         JOIN users u ON u.id = p.user_id
         WHERE g.status IN (${inStatusPlaceholders})
           AND fo.deadline IS NOT NULL
           AND fo.deadline >= ${todayExpr}
           AND fo.deadline <= ${dateAddFn(8)}
           AND g.profile_id IS NOT NULL
           AND p.user_id IS NOT NULL`,
      )
      .all(...ACTIVE_STATUSES)
  } catch (error) {
    console.warn('[deadlineNotifications] Pipeline candidate query failed:', error?.message || error)
    return 0
  }

  let created = 0
  for (const row of candidates) {
    const daysRemaining = daysUntil(row.deadline)
    if (daysRemaining === null || !THRESHOLDS_DAYS.includes(daysRemaining)) continue
    const title = row.opp_title || row.grant_title || 'Grant deadline approaching'
    const ok = await emitDeadlineNotification(db, isPostgres, {
      userId: row.user_id,
      userEmail: row.user_email,
      userPhone: row.user_phone,
      profileId: row.profile_id,
      title,
      deadline: row.deadline,
      daysRemaining,
      data: { grant_id: row.grant_id, opportunity_id: row.opportunity_id, days_remaining: daysRemaining, deadline: row.deadline },
    })
    if (ok) created++
  }
  return created
}

/**
 * Notifications for the application tracker (grant_applications table). Its
 * deadline_date was previously unwatched, so users tracking applications got no
 * deadline alerts. Best-effort: silently no-ops if the table is absent.
 */
async function notifyApplicationDeadlines(db, isPostgres, todayExpr, dateAddFn) {
  const inStatusPlaceholders = APPLICATION_ACTIVE_STATUSES.map(() => '?').join(', ')
  const deadlineDateExpr = isPostgres ? 'ga.deadline_date::date' : 'ga.deadline_date'
  const validDeadlineGuard = isPostgres
    ? `
           AND TRIM(ga.deadline_date::text) <> ''
           AND ga.deadline_date::text ~ '^\\d{4}-\\d{2}-\\d{2}'`
    : `
           AND TRIM(ga.deadline_date) <> ''`
  let candidates = []
  try {
    candidates = await db
      .prepare(
        `SELECT
           ga.id AS application_id,
           ga.opportunity_id AS opportunity_id,
           ga.grant_name AS grant_name,
           ga.funder_name AS funder_name,
           ga.deadline_date AS deadline,
           u.id AS user_id,
           u.primary_email AS user_email,
           u.primary_phone AS user_phone
         FROM grant_applications ga
         JOIN users u ON u.id = ga.user_id
         WHERE ga.status IN (${inStatusPlaceholders})
           AND ga.deadline_date IS NOT NULL
           ${validDeadlineGuard}
           AND ${deadlineDateExpr} >= ${todayExpr}
           AND ${deadlineDateExpr} <= ${dateAddFn(8)}
           AND ga.user_id IS NOT NULL`,
      )
      .all(...APPLICATION_ACTIVE_STATUSES)
  } catch (error) {
    // grant_applications may not exist on older DBs — non-fatal.
    console.warn('[deadlineNotifications] Application candidate query skipped:', error?.message || error)
    return 0
  }

  let created = 0
  for (const row of candidates) {
    const daysRemaining = daysUntil(row.deadline)
    if (daysRemaining === null || !THRESHOLDS_DAYS.includes(daysRemaining)) continue
    const title = row.grant_name || (row.funder_name ? `${row.funder_name} application` : 'Application deadline approaching')
    const ok = await emitDeadlineNotification(db, isPostgres, {
      userId: row.user_id,
      userEmail: row.user_email,
      userPhone: row.user_phone,
      title,
      deadline: row.deadline,
      daysRemaining,
      data: { application_id: row.application_id, opportunity_id: row.opportunity_id, days_remaining: daysRemaining, deadline: row.deadline },
    })
    if (ok) created++
  }
  return created
}

/**
 * Generate deadline-approaching notifications across BOTH tracking surfaces:
 * the grants pipeline and the application tracker (grant_applications).
 *
 * @param {object} db - Dialect-aware db handle
 * @returns {{ created: number }}
 */
export async function generateDeadlineNotifications(db) {
  // Ensure the table is available before doing anything.
  try {
    await ensureNotificationsTable(db)
  } catch (error) {
    log.error('[deadlineNotifications] Could not ensure notifications table:', error?.message || error)
    return { created: 0 }
  }

  const isPostgres = db?.dialect === 'postgres'
  const todayExpr = isPostgres ? 'CURRENT_DATE' : "date('now')"
  const dateAddFn = isPostgres
    ? (days) => `CURRENT_DATE + INTERVAL '${days} days'`
    : (days) => `date('now', '+${days} days')`

  const fromPipeline = await notifyPipelineDeadlines(db, isPostgres, todayExpr, dateAddFn)
  const fromApplications = await notifyApplicationDeadlines(db, isPostgres, todayExpr, dateAddFn)
  const created = fromPipeline + fromApplications

  if (created > 0) {
    log.info('[deadlineNotifications] Created notifications', { created, fromPipeline, fromApplications })
  } else {
    log.info('[deadlineNotifications] No approaching deadlines found')
  }

  return { created }
}
