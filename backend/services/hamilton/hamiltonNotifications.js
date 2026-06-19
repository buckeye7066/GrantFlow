/**
 * hamiltonNotifications.js
 *
 * Persistent notifications that Hamilton emits when she needs the user or an
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
 *   hamilton_missing_info, hamilton_login_required, hamilton_document_required,
 *   hamilton_review_required, hamilton_application_ready,
 *   hamilton_application_submitted, hamilton_application_blocked,
 *   hamilton_application_failed
 */

import crypto from 'crypto'
import { resolveAdminUserId, HAMILTON_ADMIN_EMAIL } from './hamiltonAdminAccount.js'

export const HAMILTON_USER_NOTIFICATION_TYPES = Object.freeze([
  // Per-grant Hamilton flow (legacy).
  'hamilton_missing_info',
  'hamilton_login_required',
  'hamilton_document_required',
  'hamilton_review_required',
  'hamilton_application_ready',
  'hamilton_application_submitted',
  'hamilton_application_blocked',
  'hamilton_application_failed',
  // "Automate with Hamilton" select-many automation flow.
  'hamilton_task_started',
  'hamilton_task_blocked',
  'hamilton_task_progress',
  'hamilton_generated_document_saved',
  'hamilton_submitted',
  'hamilton_failed',
  'hamilton_2fa_required',
  'hamilton_captcha_required',
  // Hard-Stop Resolver dual alerts — user side.
  'hamilton_hard_stop',
  'hamilton_payment_required',
  'hamilton_attestation_required',
  'hamilton_task_completed',
])

export const HAMILTON_ADMIN_NOTIFICATION_TYPES = Object.freeze([
  'hamilton_admin_hard_stop',
  'hamilton_admin_missing_info',
  'hamilton_admin_login_required',
  'hamilton_admin_document_required',
  'hamilton_admin_payment_required',
  'hamilton_admin_attestation_required',
  'hamilton_admin_portal_blocked',
  'hamilton_admin_task_failed',
  'hamilton_admin_task_completed',
])

export const HAMILTON_NOTIFICATION_TYPES = Object.freeze([
  ...HAMILTON_USER_NOTIFICATION_TYPES,
  ...HAMILTON_ADMIN_NOTIFICATION_TYPES,
])

/**
 * Map the canonical hard-stop blocker_type to the per-category USER
 * notification type. Anything we don't have a named category for gets
 * the generic `hamilton_hard_stop` envelope.
 */
export function userTypeForCategory(blockerType) {
  switch (String(blockerType || '').trim()) {
    case 'missing_required_information':
    case 'ambiguous_required_field':
      return 'hamilton_missing_info'
    case 'missing_required_document':
      return 'hamilton_document_required'
    case 'login_required':
    case 'sso_required':
    case 'two_factor_required':
    case 'captcha_required':
      return 'hamilton_login_required'
    case 'payment_required':
      return 'hamilton_payment_required'
    case 'wet_signature_required':
    case 'legal_attestation_required':
      return 'hamilton_attestation_required'
    default:
      return 'hamilton_hard_stop'
  }
}

/**
 * Map the canonical hard-stop blocker_type to the per-category ADMIN
 * notification type.
 */
export function adminTypeForCategory(blockerType) {
  switch (String(blockerType || '').trim()) {
    case 'missing_required_information':
    case 'ambiguous_required_field':
      return 'hamilton_admin_missing_info'
    case 'missing_required_document':
      return 'hamilton_admin_document_required'
    case 'login_required':
    case 'sso_required':
    case 'two_factor_required':
    case 'captcha_required':
      return 'hamilton_admin_login_required'
    case 'payment_required':
      return 'hamilton_admin_payment_required'
    case 'wet_signature_required':
    case 'legal_attestation_required':
      return 'hamilton_admin_attestation_required'
    case 'portal_terms_block':
    case 'portal_anti_bot_block':
      return 'hamilton_admin_portal_blocked'
    case 'deadline_expired':
    case 'unknown_application_method':
      return 'hamilton_admin_task_failed'
    default:
      return 'hamilton_admin_hard_stop'
  }
}

export const HAMILTON_SEVERITIES = Object.freeze(['info', 'warning', 'error', 'success'])

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
  return HAMILTON_SEVERITIES.includes(v) ? v : 'info'
}

/**
 * Create a notification for a single user. Returns the notification id
 * (or null if the user_id is missing — we don't throw; the caller has
 * already done its primary work).
 */
export async function emitHamiltonNotification(db, {
  userId,
  type,
  title,
  message,
  data = {},
  severity = 'info',
  expiresInDays = 30,
} = {}) {
  if (!db || !userId || !type) return null
  if (!HAMILTON_NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`invalid hamilton notification type: ${type}`)
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
      console.warn('[hamiltonNotifications] insert failed:', err?.message || err)
    }
    return null
  }
}

/**
 * Notify the profile owner + every admin user. Returns array of created
 * notification ids.
 */
export async function emitHamiltonNotificationToProfileAndAdmins(db, {
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
      const single = await resolveAdminUserId(db)
      admins = single ? [single] : []
    } catch {
      admins = []
    }
  }
  for (const a of admins) recipients.add(String(a))

  const ids = []
  for (const userId of recipients) {
    const id = await emitHamiltonNotification(db, { userId, type, title, message, data, severity, expiresInDays })
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Hard-Stop alert: the mandatory dual-channel notification Hamilton fires
 * EVERY time she pauses on an unresolved blocker. The profile owner
 * gets `hamilton_hard_stop`; every admin gets `hamilton_admin_hard_stop`.
 *
 * Returns:
 *   { user_notification_id, admin_notification_ids: [...] }
 *
 * Spec mapping (verbatim from the requirement):
 *   - title:    "Hamilton needs help completing [Funding Source]"
 *               "Hamilton hard stop: [Profile] / [Funding Source]"
 *   - data fields: task_id, profile_id, user_id, funding_source_id,
 *                  blocker_type, required_action, route_to_resolve /
 *                  route_to_admin_task, deadline, admin_required,
 *                  user_required, severity.
 */
async function lookupProfileLabel(db, profileId) {
  if (!db || !profileId) return null
  try {
    const row = await db.prepare(
      `SELECT
         COALESCE(name, display_name, organization_name, profile_name, profile_label) AS label,
         user_id
       FROM profiles WHERE id = ? LIMIT 1`,
    ).get(String(profileId))
    return row?.label || null
  } catch {
    // Fall back to a narrower query if some columns aren't present in
    // older test schemas.
    try {
      const row = await db.prepare('SELECT name FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
      return row?.name || null
    } catch { return null }
  }
}

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
  const profLabel   = profileLabel || (await lookupProfileLabel(db, profileId)) || profileId || 'profile'
  const userTitle   = `Hamilton needs help completing ${sourceLabel}`
  const adminTitle  = `Hamilton hard stop: ${profLabel} / ${sourceLabel}`
  const baseMessage = blockerMessage
    || `Hamilton paused for: ${blockerTitle || String(blockerType || 'a blocker').replace(/_/g, ' ')}.`
  const whoMustAct = adminRequired && !userRequired
    ? 'Admin action required.'
    : userRequired && !adminRequired
      ? 'User action required.'
      : 'Either the user or an admin can resolve this.'
  const adminMessage = `${baseMessage} ${whoMustAct}`

  const userType  = userTypeForCategory(blockerType)
  const adminType = adminTypeForCategory(blockerType)
  const resolveLink = resolverRoute || `/hamilton/tasks/${taskId}`
  const resumeLink  = `/hamilton/tasks/${taskId}/resume`
  const adminLink   = adminRoute || `/admin/hamilton/hard-stops/${blockerId || taskId}`

  const baseData = {
    task_id: taskId,
    profile_id: profileId,
    profile_name: profLabel,
    user_id: profileUserId,
    funding_source_id: fundingSourceId,
    funding_source_title: fundingSourceTitle,
    blocker_id: blockerId,
    blocker_type: blockerType,
    blocker_title: blockerTitle,
    blocker_message: blockerMessage,
    required_action: requiredAction,
    severity,
    deadline: deadlineAt,
    admin_required: !!adminRequired,
    user_required: !!userRequired,
    route_to_resolve: resolveLink,
    route_to_resume: resumeLink,
  }

  // 1. User notification (per-category type).
  let userNotificationId = null
  if (userRequired && profileUserId) {
    userNotificationId = await emitHamiltonNotification(db, {
      userId: profileUserId,
      type: userType,
      title: userTitle,
      message: baseMessage,
      data: baseData,
      severity,
      expiresInDays,
    })
  }

  // 2. Admin notification — single canonical operator (buckeye7066@gmail.com
  // by default). We always create the row even if the request says
  // adminRequired=false, because GrantFlow's operator must always see
  // every hard stop.
  const adminIds = []
  try {
    const adminId = await resolveAdminUserId(db)
    if (adminId) {
      const id = await emitHamiltonNotification(db, {
        userId: adminId,
        type: adminType,
        title: adminTitle,
        message: adminMessage,
        data: {
          ...baseData,
          admin_email: HAMILTON_ADMIN_EMAIL,
          route_to_admin_task: adminLink,
        },
        severity,
        expiresInDays,
      })
      if (id) adminIds.push(id)
    }
  } catch {
    // best-effort
  }
  return { user_notification_id: userNotificationId, admin_notification_ids: adminIds }
}

/**
 * Emit a paired user + admin notification for any non-blocker Hamilton
 * lifecycle event (task completed, task failed, etc.). Keeps the
 * operator inbox in sync without going through the hard-stop pathway.
 */
export async function emitHamiltonLifecycleAlerts(db, {
  profileId, profileUserId = null,
  fundingSourceId = null, fundingSourceTitle = null,
  profileLabel = null,
  taskId,
  userType,            // e.g. 'hamilton_task_completed'
  adminType,           // e.g. 'hamilton_admin_task_completed'
  title, message,
  severity = 'info',
  data = {},
  expiresInDays = 30,
} = {}) {
  if (!db || !taskId) return { user_notification_id: null, admin_notification_ids: [] }
  await ensureNotificationsSchema(db)
  const sourceLabel = fundingSourceTitle || fundingSourceId || 'this funding source'
  const profLabel = profileLabel
    || (await lookupProfileLabel(db, profileId))
    || profileId || 'profile'
  const baseData = {
    task_id: taskId,
    profile_id: profileId,
    profile_name: profLabel,
    user_id: profileUserId,
    funding_source_id: fundingSourceId,
    funding_source_title: fundingSourceTitle,
    severity,
    ...data,
  }
  let userNotificationId = null
  if (userType && profileUserId) {
    userNotificationId = await emitHamiltonNotification(db, {
      userId: profileUserId,
      type: userType,
      title,
      message,
      data: baseData,
      severity,
      expiresInDays,
    })
  }
  const adminIds = []
  if (adminType) {
    try {
      const adminId = await resolveAdminUserId(db)
      if (adminId) {
        const id = await emitHamiltonNotification(db, {
          userId: adminId,
          type: adminType,
          title: `${title} — ${profLabel} / ${sourceLabel}`,
          message,
          data: { ...baseData, admin_email: HAMILTON_ADMIN_EMAIL },
          severity,
          expiresInDays,
        })
        if (id) adminIds.push(id)
      }
    } catch {
      // best-effort
    }
  }
  return { user_notification_id: userNotificationId, admin_notification_ids: adminIds }
}

/**
 * Emit a precise "Hamilton needs information" alert that the toast bridge can
 * deep-link straight to the exact profile field the user must fill — even when
 * it's a single missing field. The bridge resolves the field via
 * `data.field` (see HamiltonToastBridge.resolveNotificationTarget), so once the
 * user clicks the toast, fills the field, and saves, the missing-info
 * auto-resume re-queues the task and Hamilton continues.
 *
 * Only fires for field/document items (the things a user can supply); returns
 * [] when there are none so callers can fall back to a generic blocked alert
 * for non-info blockers.
 *
 * @returns {Promise<string[]>} created notification ids
 */
export async function emitMissingInfoAlert(db, {
  profileId, profileUserId = null, taskId,
  missing = [], fundingSourceTitle = null,
} = {}) {
  if (!db) return []
  const items = (Array.isArray(missing) ? missing : []).filter(
    (m) => m && (m.kind === 'field' || m.kind === 'document'),
  )
  if (items.length === 0) return []
  // Prefer a FIELD as the deep-link target (the user's focus); fall back to the
  // first item otherwise.
  const primary = items.find((m) => m.kind === 'field') || items[0]
  const count = items.length
  const label = primary?.label || primary?.key || 'a detail'
  const src = fundingSourceTitle ? ` to finish "${fundingSourceTitle}"` : ' to finish'
  const title = count === 1
    ? `Hamilton needs one detail${src}`
    : `Hamilton needs ${count} details${src}`
  const message = count === 1
    ? `Add "${label}" and Hamilton will continue automatically.`
    : `Starting with "${label}" — supply the flagged items and Hamilton resumes automatically.`
  return emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId,
    profileUserId,
    type: 'hamilton_missing_info',
    title,
    message,
    severity: 'warning',
    data: {
      task_id: taskId,
      // The toast bridge deep-links missing_info to the exact field via this key.
      field: primary?.kind === 'field' ? (primary?.key || null) : null,
      missing_key: primary?.key || null,
      missing_keys: items.map((m) => m.key).filter(Boolean),
      missing_count: count,
    },
  })
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

// Re-export for tests so a single resetCaches() call wipes both schema
// and the canonical admin id memoization.
export { _resetAdminAccountCache } from './hamiltonAdminAccount.js'

export const _internal = { ensureNotificationsSchema }
