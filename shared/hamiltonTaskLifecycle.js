/**
 * The ONE map from a Hamilton task status to what a person should be told
 * about it.
 *
 * WHY THIS FILE EXISTS. Three surfaces each hand-typed their own subset of the
 * status vocabulary and each of them silently dropped states:
 *
 *  - `HamiltonAutomationWatch` counted `queued|ready|in_progress` as "working",
 *    `blocked*|waiting_for_user|waiting_for_admin` as "need you" and
 *    `submitted|cancelled|failed|draft_completed` as "finished" — and swept the
 *    remaining 23 real statuses into an `idle` counter it never rendered. On
 *    production data (931 tasks, 2026-08-21) that is 523 tasks — 56% of the
 *    fleet — in NO counter at all, including two sitting in `filling_portal`
 *    while the header read "Hamilton is not working right now · 0 working".
 *  - `applicationStatusPresentation.mapHamiltonStatus` collapsed everything
 *    that was not `submitted`-with-a-timestamp or `cancelled` into
 *    `in_progress`, so a FAILED task and a COMPLETED task both appeared in the
 *    tracker's "In Progress" lane wearing a "Mark Submitted" button, and the
 *    tracker's "Needs review" lane was unreachable by construction.
 *  - The same mapper rendered `cancelled` as **withdrawn**, a word that means a
 *    person changed their mind. On 2026-08-03 a boot sweep cancelled 295 tasks
 *    inside one second; the owner read that as 43 applications they had
 *    personally withdrawn.
 *
 * The rule this file enforces is the owner's accounting rule — every candidate
 * is either acted on, skipped with a reason, or failed, and nothing is
 * invisible. `backend/tests/hamiltonTaskLifecycle.test.js` asserts TOTALITY
 * against the canonical `TASK_STATUSES`, so a new status cannot be added
 * without deciding what it means here.
 */

/**
 * The four things a person can be told, and the order they are shown in.
 * "Needs you" sorts first because it is the only bucket the reader can act on.
 */
export const TASK_BUCKETS = Object.freeze(['needs_you', 'working', 'waiting', 'finished'])

export const BUCKET_ORDER = Object.freeze({
  needs_you: 0,
  working: 1,
  waiting: 2,
  finished: 3,
})

/**
 * status -> bucket. TOTAL over `TASK_STATUSES`.
 *
 *  - `working`   Hamilton has the row in hand and is moving it RIGHT NOW.
 *  - `needs_you` Hamilton stopped and a HUMAN is the next actor.
 *  - `waiting`   Queued or held by something that is not the reader (a
 *                schedule window, a review, a retry) — nobody is blocked on
 *                the reader and no work is happening this second.
 *  - `finished`  Terminal. It will not move again on its own.
 */
export const TASK_STATUS_BUCKET = Object.freeze({
  // ── working ──────────────────────────────────────────────────────────────
  queued: 'working',
  ready: 'working',
  in_progress: 'working',
  analyzing: 'working',
  generating_application: 'working',
  generating_documents: 'working',
  saving_documents: 'working',
  launching_portal: 'working',
  filling_portal: 'working',
  saving_portal_draft: 'working',
  submit_attempt_started: 'working',
  submit_evidence_pending: 'working',

  // ── needs you ────────────────────────────────────────────────────────────
  // Every one of these is a wall only a person can walk through. The legacy
  // `blocked_*` spellings and the newer `waiting_for_*` spellings are the SAME
  // situation and must count the same; separating them is what let 8 captcha
  // and 8 login walls sit outside the "need you" counter in production.
  waiting_for_user: 'needs_you',
  waiting_for_admin: 'needs_you',
  waiting_for_login: 'needs_you',
  waiting_for_2fa: 'needs_you',
  waiting_for_captcha: 'needs_you',
  waiting_for_email_verification: 'needs_you',
  waiting_for_missing_info: 'needs_you',
  waiting_for_review: 'needs_you',
  submission_verification_required: 'needs_you',
  blocked: 'needs_you',
  blocked_login_required: 'needs_you',
  blocked_missing_info: 'needs_you',
  blocked_2fa: 'needs_you',
  blocked_captcha: 'needs_you',
  blocked_terms_or_policy: 'needs_you',
  ready_to_submit: 'needs_you',
  ready_to_print_mail: 'needs_you',
  ready_to_email: 'needs_you',
  ready_to_fax: 'needs_you',

  // ── waiting ──────────────────────────────────────────────────────────────
  ready_to_start: 'waiting',
  waiting_for_window: 'waiting',

  // ── finished ─────────────────────────────────────────────────────────────
  submitted: 'finished',
  draft_completed: 'finished',
  completed: 'finished',
  failed: 'finished',
  cancelled: 'finished',
})

/**
 * Vocabularies that are the SAME state under a different name.
 *
 * `hamiltonAutopilotEngine` returns `completed_draft` where the task store
 * spells the identical state `draft_completed`. Both reach these functions
 * (the engine's word survives onto `task_status` in some payloads), and
 * treating one of them as an unrecognised defect would be wrong — it is a
 * naming inconsistency, not a broken state. Aliases are declared here rather
 * than added to the bucket map so the totality test keeps measuring the
 * CANONICAL vocabulary.
 */
export const TASK_STATUS_ALIASES = Object.freeze({
  completed_draft: 'draft_completed',
})

/**
 * An UNRECOGNISED status is a defect, not a category. It gets its own bucket
 * so it is loud rather than silently absorbed into "waiting" — the failure
 * mode this file exists to end.
 */
export const UNKNOWN_STATUS_BUCKET = 'needs_you'

export function normaliseTaskStatus(status) {
  const key = String(status || '').toLowerCase()
  return TASK_STATUS_ALIASES[key] || key
}

export function bucketForTaskStatus(status) {
  return TASK_STATUS_BUCKET[normaliseTaskStatus(status)] || UNKNOWN_STATUS_BUCKET
}

export function isRecognisedTaskStatus(status) {
  return Object.prototype.hasOwnProperty.call(
    TASK_STATUS_BUCKET,
    normaliseTaskStatus(status),
  )
}

/**
 * Count a list of tasks into the buckets. The returned object ALWAYS carries
 * every bucket plus `total` and `unrecognised`, and the buckets always sum to
 * `total` — that identity is the whole point and is asserted by the tests.
 */
export function countTaskBuckets(tasks = []) {
  const counts = { needs_you: 0, working: 0, waiting: 0, finished: 0, total: 0, unrecognised: 0 }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = typeof task === 'string' ? task : task?.status
    counts[bucketForTaskStatus(status)] += 1
    if (!isRecognisedTaskStatus(status)) counts.unrecognised += 1
    counts.total += 1
  }
  return counts
}

/**
 * The terminal OUTCOME of a finished task — a different question from its
 * bucket, and the one a "Finished" card has to answer. "Finished" is not a
 * result; `submitted` and `cancelled` are opposite results wearing it.
 */
export const TERMINAL_OUTCOME = Object.freeze({
  submitted: 'submitted',
  completed: 'completed',
  draft_completed: 'drafted',
  failed: 'failed',
  cancelled: 'cancelled',
})

export function terminalOutcome(status) {
  return TERMINAL_OUTCOME[normaliseTaskStatus(status)] || null
}

/**
 * The tracker (`grant_applications`) vocabulary. Kept here beside the bucket
 * map so the two can never drift apart again.
 *
 * `cancelled` deliberately does NOT map to `withdrawn`: withdrawn is a claim
 * that the applicant changed their mind, and the overwhelming majority of
 * production cancellations were made by a system sweep. `unknown` — the
 * tracker's "Needs review" lane — is where a blocked or unrecognised task
 * belongs, and until now nothing could ever reach it.
 */
export const TRACKER_STATUS_BY_BUCKET = Object.freeze({
  needs_you: 'unknown',
  working: 'in_progress',
  waiting: 'in_progress',
  finished: 'closed',
})

export default {
  TASK_BUCKETS,
  BUCKET_ORDER,
  TASK_STATUS_BUCKET,
  TASK_STATUS_ALIASES,
  UNKNOWN_STATUS_BUCKET,
  TRACKER_STATUS_BY_BUCKET,
  TERMINAL_OUTCOME,
  bucketForTaskStatus,
  isRecognisedTaskStatus,
  countTaskBuckets,
  normaliseTaskStatus,
  terminalOutcome,
}
