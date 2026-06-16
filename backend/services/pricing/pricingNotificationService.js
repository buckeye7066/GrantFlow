/**
 * pricingNotificationService.js
 *
 * Admin pricing toast queue. Notifications are inserted by
 * `profilePricingInitializer.queueAdminNotification` and consumed by
 * the admin client (live polling).
 *
 * The queue ONLY targets the configured admin email (default
 * `buckeye7066@gmail.com`); other users — even users with `is_admin=true`
 * — never receive these notifications. The route layer enforces this.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import {
  ADMIN_NOTIFICATION_STATUS,
  adminNotificationEmail,
  isAdminNotificationTarget,
} from './pricingTypes.js'
import { ADMIN_NOTIFICATIONS_TABLE } from './profilePricingInitializer.js'

async function tableExists(db, table) {
  if (!db) return false
  try {
    if (db.dialect === 'pg' || db.dialect === 'postgres') {
      const r = await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1").get(table)
      return Boolean(r)
    }
    const r = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table)
    return Boolean(r)
  } catch {
    return false
  }
}

function decodeNotification(row) {
  if (!row) return null
  let payload = null
  try { payload = row.payload_json ? (typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json) : null } catch { payload = null }
  return { ...row, payload }
}

/**
 * List recent notifications for the given admin user. Returns empty
 * when the requester isn't the configured admin email — even if they
 * have `is_admin=true`.
 */
export async function listForAdmin(db, { user, limit = 25, status = null } = {}) {
  if (!user || !isAdminNotificationTarget(user.email)) {
    return { ok: false, error: 'not_admin_notification_target', items: [] }
  }
  if (!(await tableExists(db, ADMIN_NOTIFICATIONS_TABLE))) {
    return { ok: true, installed: false, items: [] }
  }
  const adminEmail = adminNotificationEmail()
  const items = await withProfileScope({ bypass: true }, async () => {
    if (status) {
      return db.prepare(
        `SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE}
          WHERE admin_email = ? AND status = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      ).all(adminEmail, status, limit)
    }
    return db.prepare(
      `SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE}
        WHERE admin_email = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(adminEmail, limit)
  })
  return { ok: true, installed: true, items: items.map(decodeNotification) }
}

/**
 * Mark a notification as delivered (live or on-login).
 * mode="live" or "on_login".
 */
export async function markDelivered(db, { user, id, mode = 'live' }) {
  if (!user || !isAdminNotificationTarget(user.email)) {
    return { ok: false, error: 'not_admin_notification_target' }
  }
  if (!(await tableExists(db, ADMIN_NOTIFICATIONS_TABLE))) {
    return { ok: false, error: 'pricing_tables_not_installed' }
  }
  const targetStatus = mode === 'on_login'
    ? ADMIN_NOTIFICATION_STATUS.DELIVERED_ON_LOGIN
    : ADMIN_NOTIFICATION_STATUS.DELIVERED_LIVE
  const adminEmail = adminNotificationEmail()
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(
      `UPDATE ${ADMIN_NOTIFICATIONS_TABLE}
        SET status = ?, delivered_at = COALESCE(delivered_at, ?)
        WHERE id = ? AND admin_email = ?`,
    ).run(targetStatus, new Date().toISOString(), id, adminEmail)
    return { ok: true, id, status: targetStatus }
  })
}

/**
 * Dismiss a notification (admin clicked the X). Records dismissed_at.
 */
export async function dismiss(db, { user, id }) {
  if (!user || !isAdminNotificationTarget(user.email)) {
    return { ok: false, error: 'not_admin_notification_target' }
  }
  if (!(await tableExists(db, ADMIN_NOTIFICATIONS_TABLE))) {
    return { ok: false, error: 'pricing_tables_not_installed' }
  }
  const adminEmail = adminNotificationEmail()
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(
      `UPDATE ${ADMIN_NOTIFICATIONS_TABLE}
        SET status = ?, dismissed_at = ?
        WHERE id = ? AND admin_email = ?`,
    ).run(ADMIN_NOTIFICATION_STATUS.DISMISSED, new Date().toISOString(), id, adminEmail)
    return { ok: true, id, status: ADMIN_NOTIFICATION_STATUS.DISMISSED }
  })
}

/**
 * Pull queued (unread) notifications and mark them delivered_on_login
 * in a single shot. Useful when the admin client wants to flush the
 * queue on first load.
 */
export async function flushQueuedOnLogin(db, { user }) {
  if (!user || !isAdminNotificationTarget(user.email)) {
    return { ok: false, error: 'not_admin_notification_target', items: [] }
  }
  if (!(await tableExists(db, ADMIN_NOTIFICATIONS_TABLE))) {
    return { ok: true, installed: false, items: [] }
  }
  const adminEmail = adminNotificationEmail()
  return withProfileScope({ bypass: true }, async () => {
    const queued = await db.prepare(
      `SELECT * FROM ${ADMIN_NOTIFICATIONS_TABLE}
        WHERE admin_email = ? AND status = ?
        ORDER BY created_at DESC`,
    ).all(adminEmail, ADMIN_NOTIFICATION_STATUS.QUEUED)
    if (queued.length === 0) return { ok: true, items: [] }
    const now = new Date().toISOString()
    for (const row of queued) {
      await db.prepare(
        `UPDATE ${ADMIN_NOTIFICATIONS_TABLE} SET status = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`,
      ).run(ADMIN_NOTIFICATION_STATUS.DELIVERED_ON_LOGIN, now, row.id)
    }
    return { ok: true, items: queued.map(decodeNotification) }
  })
}
