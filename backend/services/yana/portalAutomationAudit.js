/**
 * portalAutomationAudit.js
 *
 * Thin wrapper over `applicationTaskStore.appendTaskEvent` that adds
 * browser-specific metadata (session id, current_url, screenshot path,
 * field counts) and forces an audit-friendly event type.
 *
 * Every Yana browser action MUST flow through this helper so the
 * audit trail in `application_task_events` is complete and tamper-
 * evident. The spec requires we log:
 *   - who authorized it       → actor_user_id / actor_role
 *   - when it ran             → created_at on the row
 *   - what fields were filled → payload.field_count + payload.fields
 *   - what documents attached → payload.document_ids
 *   - what was missing        → payload.missing_count
 *   - whether submission ran  → event_type === 'submitted'
 *   - final status            → status column
 *   - errors encountered      → payload.error
 */

import { appendTaskEvent } from './applicationTaskStore.js'

export const BROWSER_EVENT_TYPES = Object.freeze([
  'browser_session_created',
  'browser_launched',
  'browser_navigated',
  'login_detected',
  'two_factor_detected',
  'captcha_detected',
  'consent_detected',
  'user_resumed',
  'form_inspected',
  'fields_mapped',
  'fields_filled',
  'missing_info_detected',
  'document_attached',
  'draft_saved',
  'pre_submit_snapshot',
  'submit_clicked',
  'submitted',
  'failed',
  'cancelled',
])

export async function recordBrowserEvent(db, {
  taskId,
  sessionId,
  eventType,
  status = null,
  message = '',
  actorUserId = null,
  actorRole = 'agent',
  payload = {},
} = {}) {
  if (!db || !taskId || !eventType) return null
  if (!BROWSER_EVENT_TYPES.includes(eventType)) {
    throw new Error(`invalid browser event type: ${eventType}`)
  }
  const enriched = {
    ...payload,
    yana_browser: true,
    session_id: sessionId,
  }
  const event = await appendTaskEvent(db, {
    taskId,
    eventType,
    status,
    message,
    actorUserId,
    actorRole,
    payload: enriched,
  })
  return event
}
