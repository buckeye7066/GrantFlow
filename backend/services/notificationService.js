/** Canonical in-app notification persistence and opportunity-change events. */

import { createHash } from 'crypto'
import { createLogger } from '../utils/logger.js'

const log = createLogger('notificationService')
const OPPORTUNITY_CHANGE_FIELDS = new Set(['deadline', 'open_date', 'source_status'])

/** Ensure the table read by /api/notifications exists on older deployments. */
export async function ensureNotificationsTable(db) {
  try {
    await db.prepare('SELECT 1 FROM notifications LIMIT 1').get()
  } catch {
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

function stableOpportunityChangeNotificationId(userId, opportunityId, changedFields, beforeValues, afterValues) {
  const relevantFields = [...changedFields].filter((field) => OPPORTUNITY_CHANGE_FIELDS.has(field)).sort()
  const relevantBefore = Object.fromEntries(relevantFields.map((field) => [field, beforeValues?.[field] ?? null]))
  const relevantAfter = Object.fromEntries(relevantFields.map((field) => [field, afterValues?.[field] ?? null]))
  const digest = createHash('sha256')
    .update(JSON.stringify({ userId, opportunityId, relevantFields, relevantBefore, relevantAfter }))
    .digest('hex')
  return `opportunity-change-${digest}`
}

function opportunityChangeMessage({ title, changedFields, beforeValues, afterValues, statusLabel, deadline }) {
  const statements = []
  if (changedFields.includes('source_status')) {
    statements.push(`Status is now ${statusLabel || afterValues?.source_status || 'updated'}.`)
  }
  if (changedFields.includes('open_date')) {
    statements.push(`Open date changed from ${beforeValues?.open_date || 'not listed'} to ${afterValues?.open_date || 'not listed'}.`)
  }
  if (changedFields.includes('deadline')) {
    statements.push(`Deadline changed from ${beforeValues?.deadline || 'not listed'} to ${afterValues?.deadline || deadline || 'not listed'}.`)
  }
  return `${title || 'A saved opportunity'} was updated. ${statements.join(' ')}`.trim()
}

async function opportunityChangeRecipients(db, opportunityId) {
  const recipients = new Map()
  const add = (row) => {
    if (!row?.user_id) return
    const existing = recipients.get(row.user_id)
    recipients.set(row.user_id, {
      user_id: row.user_id,
      profile_id: existing?.profile_id ?? row.profile_id ?? null,
    })
  }
  const queries = [
    `SELECT DISTINCT user_id, profile_id FROM saved_grants WHERE opportunity_id = ?`,
    `SELECT DISTINCT p.user_id, g.profile_id
       FROM grants g
       JOIN profiles p ON p.id = g.profile_id
      WHERE g.funding_opportunity_id = ?
        AND g.status NOT IN ('awarded','rejected','archived','declined','declined_no_review','deadline_passed','closed')`,
    `SELECT DISTINCT user_id, NULL AS profile_id
       FROM grant_applications
      WHERE opportunity_id = ?
        AND status IN ('draft','in_progress','submitted','under_review')`,
  ]
  for (const sql of queries) {
    try {
      const rows = await db.prepare(sql).all(opportunityId)
      for (const row of rows || []) add(row)
    } catch {
      // Optional tracking surfaces may not exist on every deployment.
    }
  }
  return [...recipients.values()]
}

/** Notify users watching an opportunity, idempotently per exact transition. */
export async function emitOpportunityChangeNotifications(db, change = {}) {
  const changedFields = [...new Set(change.changedFields || [])]
    .filter((field) => OPPORTUNITY_CHANGE_FIELDS.has(field))
  if (!db || !change.opportunityId || changedFields.length === 0) return { created: 0, recipients: 0 }

  try {
    await ensureNotificationsTable(db)
  } catch (error) {
    log.warn('[opportunityChangeNotifications] notifications table unavailable:', error?.message || error)
    return { created: 0, recipients: 0 }
  }

  const recipients = await opportunityChangeRecipients(db, change.opportunityId)
  const message = opportunityChangeMessage({ ...change, changedFields })
  const title = `Opportunity updated: ${change.title || 'Saved opportunity'}`
  const expiresAt = db?.dialect === 'postgres' ? `NOW() + INTERVAL '90 days'` : `datetime('now', '+90 days')`
  let created = 0

  for (const recipient of recipients) {
    const id = stableOpportunityChangeNotificationId(
      recipient.user_id,
      change.opportunityId,
      changedFields,
      change.beforeValues,
      change.afterValues,
    )
    const data = JSON.stringify({
      opportunity_id: change.opportunityId,
      profile_id: recipient.profile_id,
      changed_fields: changedFields,
      before_values: change.beforeValues ?? {},
      after_values: change.afterValues ?? {},
      current_status: change.currentStatus ?? null,
      status_label: change.statusLabel ?? null,
      deadline: change.deadline ?? null,
    })
    try {
      const result = await db.prepare(
        `INSERT INTO notifications (id, user_id, type, title, message, data, read, expires_at)
         VALUES (?, ?, 'opportunity_changed', ?, ?, ?, 0, ${expiresAt})
         ON CONFLICT (id) DO NOTHING`,
      ).run(id, recipient.user_id, title, message, data)
      created += Number(result?.changes ?? result?.rowCount ?? 0) > 0 ? 1 : 0
    } catch (error) {
      log.warn('[opportunityChangeNotifications] insert failed:', error?.message || error)
    }
  }
  return { created, recipients: recipients.length }
}

export default { ensureNotificationsTable, emitOpportunityChangeNotifications }
