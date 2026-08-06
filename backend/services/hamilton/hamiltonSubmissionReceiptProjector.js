/**
 * Durable projection of a verified external receipt into user-facing task
 * state. The receipt/outbox commit is authoritative; this projector may crash
 * and replay without creating duplicate task events or notifications.
 */
import crypto from 'node:crypto'
import {
  appendTaskEvent,
  ensureApplicationTaskSchema,
} from './applicationTaskStore.js'
import {
  emitHamiltonNotification,
  ensureNotificationsSchema,
} from './hamiltonNotifications.js'
import {
  claimSubmissionOutbox,
  getSubmissionAttempt,
  markSubmissionOutboxDelivered,
  recordSubmissionOutboxFailure,
} from './hamiltonSubmissionAttemptStore.js'
import { HAMILTON_TERMINAL_RECEIPT_STATES } from '../../../shared/hamiltonSubmissionContract.js'

const DEFAULT_INTERVAL_MS = 30_000

function deterministicId(prefix, attemptId, taskId = '') {
  const digest = crypto.createHash('sha256')
    .update(`${prefix}\n${attemptId}\n${taskId}`)
    .digest('hex')
    .slice(0, 40)
  return `${prefix}-${digest}`
}

async function withTransaction(db, fn) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction((tx) => fn(tx || db))
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = await fn(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* original error wins */ }
    throw error
  }
}

function authoritativeTaskReferences(attempt, payload) {
  if (!attempt?.integrity_valid || !Array.isArray(attempt.task_references)
      || !attempt.task_scopes || typeof attempt.task_scopes !== 'object') {
    throw new Error('receipt attempt integrity quarantined')
  }
  const authoritative = [...new Set(attempt.task_references)].sort()
  const payloadRefs = payload?.task_references
  if (!Array.isArray(payloadRefs)
      || payloadRefs.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('receipt payload task references malformed')
  }
  const normalizedPayload = [...new Set(payloadRefs.map((value) => value.trim()))].sort()
  if (normalizedPayload.some((taskId) => !authoritative.includes(taskId))) {
    throw new Error('receipt payload injected task reference')
  }
  return authoritative
}

function taskMatchesFundingIdentity(task, fundingSourceId) {
  const source = String(fundingSourceId || '')
  if (source.startsWith('funding_opportunity:')) {
    return String(task.opportunity_id || '') === source.slice('funding_opportunity:'.length)
  }
  if (source.startsWith('grant:')) return String(task.grant_id || '') === source.slice('grant:'.length)
  // Native source IDs cannot be reconstructed from an application task row;
  // projection must not guess. Such channels need an explicit canonical
  // funding identity column before they may project duplicate task refs.
  return false
}

export async function projectExternalReceiptOutboxEvent(db, outboxEvent, { now = new Date() } = {}) {
  if (!db || !outboxEvent?.id || !outboxEvent?.lease_token) {
    throw new Error('claimed receipt outbox event required')
  }
  if (outboxEvent.event_type !== 'external_receipt_verified') {
    throw new Error('unsupported submission outbox event')
  }
  await ensureApplicationTaskSchema(db)
  await ensureNotificationsSchema(db)
  const payload = outboxEvent.payload || {}
  const projectedAt = new Date(now).toISOString()
  return withTransaction(db, async (tx) => {
    const attempt = await getSubmissionAttempt(tx, outboxEvent.attempt_id)
    if (!attempt || !HAMILTON_TERMINAL_RECEIPT_STATES.includes(attempt.state)) {
      throw new Error('outbox attempt lacks verified terminal receipt')
    }
    if (payload.attempt_id !== attempt.id
        || payload.profile_id !== attempt.profile_id
        || payload.user_id !== attempt.user_id
        || payload.funding_source_id !== attempt.funding_source_id) {
      throw new Error('outbox receipt scope mismatch')
    }
    const taskReferences = authoritativeTaskReferences(attempt, payload)
    if (taskReferences.length === 0) throw new Error('receipt has no task references')
    const tasks = []
    for (const taskId of taskReferences) {
      const task = await tx.prepare(
        `SELECT id, profile_id, user_id, opportunity_id, grant_id
           FROM application_tasks WHERE id = ? LIMIT 1`,
      ).get(taskId)
      if (!task) throw new Error('receipt task reference missing')
      const taskScope = attempt.task_scopes[taskId]
      if (!taskScope
          || String(task.profile_id) !== attempt.profile_id
          || String(task.user_id || '') !== attempt.user_id
          || !taskMatchesFundingIdentity(task, taskScope.funding_source_id)) {
        throw new Error('receipt task reference scope mismatch')
      }
      tasks.push(task)
    }
    const notificationId = deterministicId('hamilton-receipt-notice', attempt.id)

    for (const task of tasks) {
      const taskId = String(task.id)
      const prior = await tx.prepare(
        `SELECT 1 FROM hamilton_submission_task_projections
          WHERE attempt_id = ? AND task_id = ? LIMIT 1`,
      ).get(attempt.id, taskId)
      if (prior) continue
      const message = 'The funder portal confirmed receipt of this application. Verified proof is on file.'
      await tx.prepare(
        `UPDATE application_tasks
            SET status = 'externally_received', submitted_at = ?, completed_at = ?,
                last_agent_message = ?, updated_at = ?
          WHERE id = ? AND profile_id = ?`,
      ).run(
        attempt.external_received_at || projectedAt,
        attempt.external_received_at || projectedAt,
        message,
        projectedAt,
        taskId,
        attempt.profile_id,
      )
      const eventId = deterministicId('hamilton-receipt-event', attempt.id, taskId)
      await appendTaskEvent(tx, {
        eventId,
        idempotent: true,
        taskId,
        eventType: 'submitted',
        status: 'externally_received',
        step: 'external_receipt_projection',
        message,
        actorUserId: attempt.user_id,
        actorRole: 'agent',
        details: {
          submission_attempt_id: attempt.id,
          evidence_type: attempt.proof?.evidence_type || null,
          proof_policy_version: attempt.proof?.proof_policy_version || null,
          artifact_sha256: attempt.proof?.artifact_sha256 || null,
        },
      })
      await emitHamiltonNotification(tx, {
        notificationId,
        idempotent: true,
        strict: true,
        userId: attempt.user_id,
        type: 'hamilton_submitted',
        title: 'Portal confirmed application receipt',
        message,
        severity: 'success',
        data: {
          submission_attempt_id: attempt.id,
          task_references: taskReferences,
          profile_id: attempt.profile_id,
          evidence_type: attempt.proof?.evidence_type || null,
        },
      })
      await tx.prepare(
        `INSERT INTO hamilton_submission_task_projections
          (attempt_id, task_id, event_id, notification_id, projected_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id, task_id) DO NOTHING`,
      ).run(attempt.id, taskId, eventId, notificationId, projectedAt)
    }

    const delivered = await markSubmissionOutboxDelivered(tx, {
      outboxEventId: outboxEvent.id,
      leaseToken: outboxEvent.lease_token,
      now,
    })
    if (!delivered) throw new Error('receipt outbox lease lost before delivery')
    return { projected: true, attempt_id: attempt.id, task_references: taskReferences }
  })
}

export async function drainHamiltonSubmissionOutbox(db, {
  attemptId = null,
  leaseOwner = `hamilton-receipt-projector:${process.pid}`,
  limit = 25,
  now = new Date(),
} = {}) {
  const summary = { claimed: 0, projected: 0, failed: 0 }
  for (let index = 0; index < Math.max(1, Math.min(100, Number(limit) || 25)); index += 1) {
    const event = await claimSubmissionOutbox(db, { attemptId, leaseOwner, now })
    if (!event) break
    summary.claimed += 1
    try {
      await projectExternalReceiptOutboxEvent(db, event, { now })
      summary.projected += 1
    } catch (error) {
      summary.failed += 1
      await recordSubmissionOutboxFailure(db, {
        outboxEventId: event.id,
        leaseToken: event.lease_token,
        error: error?.message || 'receipt_projection_failed',
        now,
      }).catch(() => {})
    }
  }
  return summary
}

export function startHamiltonSubmissionOutboxDrainer(db, {
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
} = {}) {
  const boundedInterval = Math.max(5_000, Number(intervalMs) || DEFAULT_INTERVAL_MS)
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const summary = await drainHamiltonSubmissionOutbox(db)
      if (summary.projected > 0) logger?.info?.('[hamilton-receipt-outbox] projected', summary)
    } catch (error) {
      logger?.warn?.('[hamilton-receipt-outbox] drain failed:', error?.message || 'projection_failed')
    } finally {
      running = false
    }
  }
  const startupTimer = setTimeoutFn(run, 2_000)
  const intervalTimer = setIntervalFn(run, boundedInterval)
  return {
    run,
    stop() {
      clearTimeout(startupTimer)
      clearInterval(intervalTimer)
    },
  }
}

export const _internal = Object.freeze({ deterministicId, authoritativeTaskReferences, taskMatchesFundingIdentity })
