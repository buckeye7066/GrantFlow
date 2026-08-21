/**
 * Map a Hamilton task to the grant-application tracker's vocabulary.
 *
 * `completed`, `completed_draft`, and `draft_completed` mean Hamilton produced
 * an artifact. They do not prove delivery. A submission requires both the
 * explicit submitted state and a persisted submitted_at timestamp.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG (2026-08-21, measured against
 * production). The whole mapper was three lines:
 *
 *     if (status === 'submitted' && submittedAt) return 'submitted'
 *     if (status === 'cancelled') return 'withdrawn'
 *     return 'in_progress'
 *
 * Two defects, both visible on the owner's own tracker:
 *
 * 1. `cancelled` was rendered as **withdrawn**. Withdrawn is a claim that the
 *    APPLICANT changed their mind. In production, 295 of 331 cancellations were
 *    written by one boot sweep inside a single second on 2026-08-03 with the
 *    reason "Cancelled by the 2026-08-03 eligibility/junk audit". Calling that
 *    "withdrawn" tells the owner they did something they did not do.
 * 2. The final `return 'in_progress'` was total by accident rather than by
 *    design, so `failed`, `completed`, `blocked`, and every `waiting_for_*`
 *    wall all landed in the tracker's "In Progress" lane wearing a "Mark
 *    Submitted" button — while the "Needs review" lane was UNREACHABLE, which
 *    is why the tracker read "Needs review 0" on the same data the run
 *    dashboard read "8 need you".
 *
 * The bucket map is now the shared, totality-tested one, so this file and the
 * run dashboard can never again disagree about what a status means.
 */
import {
  bucketForTaskStatus,
  isRecognisedTaskStatus,
  normaliseTaskStatus,
  TRACKER_STATUS_BY_BUCKET,
} from '../../../shared/hamiltonTaskLifecycle.js'

/**
 * Terminal task statuses that carry their own tracker lane. A terminal state
 * is a RESULT and the tracker has a word for each of these; only the ones with
 * no lane of their own fall through to the bucket map.
 */
const TERMINAL_TRACKER_STATUS = Object.freeze({
  failed: 'closed',
  cancelled: 'closed',
  completed: 'in_progress',
  draft_completed: 'in_progress',
})

export function mapHamiltonStatus(task = {}) {
  const rawStatus = typeof task === 'string'
    ? task
    : task?.task_status ?? task?.status ?? ''
  const status = normaliseTaskStatus(rawStatus)
  const submittedAt = typeof task === 'string'
    ? null
    : task?.submitted_at ?? task?.submittedAt ?? null

  // A submission is the one claim that needs BOTH the state and the stamp.
  // Without the stamp the row is still in flight, not delivered.
  if (status === 'submitted' && submittedAt) return 'submitted'
  if (status === 'submitted') return 'in_progress'

  // An unrecognised status is a defect. Route it to the lane that exists for
  // exactly that — "Needs review" — rather than hiding it inside "In Progress".
  if (!isRecognisedTaskStatus(status)) return 'unknown'

  if (Object.prototype.hasOwnProperty.call(TERMINAL_TRACKER_STATUS, status)) {
    return TERMINAL_TRACKER_STATUS[status]
  }

  return TRACKER_STATUS_BY_BUCKET[bucketForTaskStatus(status)] || 'unknown'
}

/**
 * The honest word for a terminal task, for surfaces that need to say WHY a row
 * closed rather than only that it did. `cancelled` is deliberately never
 * "withdrawn" — see the header.
 */
export function terminalReasonLabel(task = {}) {
  const status = normaliseTaskStatus(task?.task_status ?? task?.status ?? '')
  if (status === 'cancelled') return 'cancelled'
  if (status === 'failed') return 'failed'
  if (status === 'submitted') return 'submitted'
  if (status === 'completed' || status === 'draft_completed') return 'drafted'
  return null
}

export default { mapHamiltonStatus, terminalReasonLabel }
