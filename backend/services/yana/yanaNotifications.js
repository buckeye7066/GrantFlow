/**
 * yanaNotifications.js
 *
 * Persistent notifications that Yana emits when she needs the user or an
 * admin to do something. Reuses the existing `notifications` table
 * (migration 049) and the existing /api/notifications routes — no
 * parallel system.
 *
 * Mission rules:
 *   - "If results are found but not displayed, treat this as a bug" — we
 *     create a persistent notification immediately so it survives toast
 *     timeout and shows up in NotificationBell on the user's next login.
 *   - Toast helpers on the frontend pick the same notification up via
 *     /api/notifications and surface it as a toast when the user is
 *     online.
 *   - Severity is encoded in `data.severity` so the bell can sort/colour
 *     it correctly.
 *
 * Notification types (`type` column):
 *   yana_missing_info, yana_login_required, yana_document_required,
 *   yana_review_required, yana_application_ready,
 *   yana_application_submitted, yana_application_blocked,
 *   yana_application_failed
 */

import crypto from 'crypto'

export const YANA_NOTIFICATION_TYPES = Object.freeze([
  // Per-grant Yana flow (legacy).
  'yana_missing_info',
  'yana_login_required',
  'yana_document_required',
  'yana_review_required',
  'yana_application_ready',
  'yana_application_submitted',
  'yana_application_blocked',
  'yana_application_failed',
  // "Automate with Yana" select-many automation flow.
  'yana_task_started',
  'yana_task_blocked',
  'yana_task_progress',
  'yana_generated_document_saved',
  'yana_submitted',
  'yana_failed',
  'yana_2fa_required',
  'yana_captcha_required',
  // Hard-Stop Resolver — mandatory dual alerts when Yana actually pauses.
  'yana_hard_stop',         // for the profile owner / user
  'yana_admin_hard_stop',   // for admin/operator
])

export const YANA_SEVERITIES = Object.freeze(['info', 'warning', 'error', 'success'])

let ensuredNotifications = false

async function ensureNotificationsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredNotifications) return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'TIMESTAMP'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at ${tsType} DEFAULT ${nowFn},
      expires_at ${tsType}
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read    ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
  `)
  ensuredNotifications = true
}

function normalizeSeverity(value) {
  if (!value) return 'info'
  const v = String(value).toLowerCase()
  return YANA_SEVERITIES.includes(v) ? v : 'info'
}

/**
 * Create a notification for a single user. Returns the notification id
 * (or null if the user_id is missing — we don't throw; the caller has
 * already done its primary work).
 */
export async function emitYanaNotification(db, {
  userId,
  type,
  title,
  message,
  data = {},
  severity = 'info',
  expiresInDays = 30,
} = {}) {
  if (!db || !userId || !type) return null
  if (!YANA_NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`invalid yana notification type: ${type}`)
  }
  if (!title || !message) throw new Error('title and message required')
  await ensureNotificationsSchema(db)

  const id = crypto.randomUUID()
  const isPostgres = db?.dialect === 'postgres'
  const expires = isPostgres
    ? `NOW() + INTERVAL '${Math.max(1, Math.min(365, Number(expiresInDays) || 30))} days'`
    : `datetime('now', '+${Math.max(1, Math.min(365, Number(expiresInDays) || 30))} days')`

  const dataJson = (() => {
    try {
      return JSON.stringify({ ...data, severity: normalizeSeverity(severity) })
    } catch {
      return JSON.stringify({ severity: normalizeSeverity(severity) })
    }
  })()

  try {
    await db
      .prepare(
        `INSERT INTO notifications (id, user_id, type, title, message, data, read, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ${expires})`,
      )
      .run(id, String(userId), String(type), String(title), String(message), dataJson)
    return id
  } catch (err) {
    // Notifications are advisory — never fail the agent run because
    // the table couldn't be written to.
    if (process?.env?.NODE_ENV !== 'test') {
      console.warn('[yanaNotifications] insert failed:', err?.message || err)
    }
    return null
  }
}

/**
 * Notify the profile owner + every admin user. Returns array of created
 * notification ids.
 */
export async function emitYanaNotificationToProfileAndAdmins(db, {
  profileId,
  profileUserId = null,
  adminUserIds = null,
  type,
  title,
  message,
  data = {},
  severity = 'info',
  expiresInDays = 30,
} = {}) {
  if (!db) return []
  await ensureNotificationsSchema(db)

  const recipients = new Set()
  if (profileUserId) recipients.add(String(profileUserId))

  // Resolve the profile owner if not given.
  if (!profileUserId && profileId) {
    try {
      const row = await db.prepare('SELECT user_id FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
      if (row?.user_id) recipients.add(String(row.user_id))
    } catch {
      // ignore — we'll still notify admins
    }
  }

  let admins = adminUserIds
  if (!Array.isArray(admins)) {
    try {
      const rows = await db.prepare("SELECT id FROM users WHERE role = 'admin'").all()
      admins = (rows || []).map((r) => r?.id).filter(Boolean)
    } catch {
      admins = []
    }
  }
  for (const a of admins) recipients.add(String(a))

  const ids = []
  for (const userId of recipients) {
    const id = await emitYanaNotification(db, { userId, type, title, message, data, severity, expiresInDays })
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Hard-Stop alert: the mandatory dual-channel notification Yana fires
 * EVERY time she pauses on an unresolved blocker. The profile owner
 * gets `yana_hard_stop`; every admin gets `yana_admin_hard_stop`.
 *
 * Returns:
 *   { user_notification_id, admin_notification_ids: [...] }
 *
 * Spec mapping (verbatim from the requirement):
 *   - title:    "Yana needs help completing [Funding Source]"
 *               "Yana hard stop: [Profile] / [Funding Source]"
 *   - data fields: task_id, profile_id, user_id, funding_source_id,
 *                  blocker_type, required_action, route_to_resolve /
 *                  route_to_admin_task, deadline, admin_required,
 *                  user_required, severity.
 */
export async function emitHardStopAlerts(db, {
  profileId, profileUserId = null,
  fundingSourceId = null, fundingSourceTitle = null,
  profileLabel = null,
  taskId, blockerId = null,
  blockerType,
  blockerTitle = null, blockerMessage = null,
  requiredAction = null,
  resolverRoute = null,
  adminRoute = null,
  deadlineAt = null,
  severity = 'warning',
  adminRequired = true,
  userRequired = true,
  expiresInDays = 30,
} = {}) {
  if (!db) return { user_notification_id: null, admin_notification_ids: [] }
  await ensureNotificationsSchema(db)

  const sourceLabel = fundingSourceTitle || fundingSourceId || 'this funding source'
  const profLabel   = profileLabel || profileId || 'profile'
  const userTitle   = `Yana needs help completing ${sourceLabel}`
  const adminTitle  = `Yana hard stop: ${profLabel} / ${sourceLabel}`
  const baseMessage = blockerMessage
    || `Yana paused for: ${blockerTitle || blockerType.replace(/_/g, ' ')}.`
  const adminMessage = `${baseMessage} ${adminRequired && !userRequired
    ? 'Admin action required.'
    : userRequired && !adminRequired
      ? 'User action required.'
      : 'Either the user or an admin can resolve this.'}`

  const baseData = {
    task_id: taskId,
    profile_id: profileId,
    user_id: profileUserId,
    funding_source_id: fundingSourceId,
    blocker_type: blockerType,
    blocker_id: blockerId,
    required_action: requiredAction,
    severity,
    deadline: deadlineAt,
    admin_required: !!adminRequired,
    user_required: !!userRequired,
  }

  // 1. User notification.
  let userNotificationId = null
  if (userRequired && profileUserId) {
    userNotificationId = await emitYanaNotification(db, {
      userId: profileUserId,
      type: 'yana_hard_stop',
      title: userTitle,
      message: baseMessage,
      data: { ...baseData, route_to_resolve: resolverRoute || `/yana/tasks/${taskId}` },
      severity,
      expiresInDays,
    })
  }

  // 2. Admin notification(s).
  const adminIds = []
  let admins = []
  try {
    const rows = await db.prepare("SELECT id FROM users WHERE role = 'admin'").all()
    admins = (rows || []).map((r) => r?.id).filter(Boolean)
  } catch {
    admins = []
  }
  for (const adminId of admins) {
    const id = await emitYanaNotification(db, {
      userId: adminId,
      type: 'yana_admin_hard_stop',
      title: adminTitle,
      message: adminMessage,
      data: {
        ...baseData,
        route_to_admin_task: adminRoute || `/admin/yana/hard-stops/${blockerId || taskId}`,
        route_to_resolve: resolverRoute || `/yana/tasks/${taskId}`,
      },
      severity,
      expiresInDays,
    })
    if (id) adminIds.push(id)
  }
  return { user_notification_id: userNotificationId, admin_notification_ids: adminIds }
}

/**
 * Mark a list of notification ids as read. Used when a hard stop is
 * resolved so the persistent alert doesn't keep nagging the user.
 */
export async function markNotificationsResolved(db, notificationIds = []) {
  if (!db || !Array.isArray(notificationIds) || notificationIds.length === 0) return 0
  await ensureNotificationsSchema(db)
  let n = 0
  for (const id of notificationIds) {
    if (!id) continue
    try {
      await db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(String(id))
      n += 1
    } catch {
      // best-effort
    }
  }
  return n
}

export function _resetNotificationsSchemaCache() {
  ensuredNotifications = false
}

export const _internal = { ensureNotificationsSchema }
