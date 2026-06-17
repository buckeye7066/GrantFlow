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
  'yana_missing_info',
  'yana_login_required',
  'yana_document_required',
  'yana_review_required',
  'yana_application_ready',
  'yana_application_submitted',
  'yana_application_blocked',
  'yana_application_failed',
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

export function _resetNotificationsSchemaCache() {
  ensuredNotifications = false
}

export const _internal = { ensureNotificationsSchema }
