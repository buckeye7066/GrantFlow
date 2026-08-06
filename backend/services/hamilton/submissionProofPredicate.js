/**
 * submissionProofPredicate.js
 *
 * THE single canonical answer to one question: does an `application_tasks` row
 * that reads `status='submitted'` represent an application that was actually
 * transmitted to the funder AND left a durable, owner-retrievable confirmation
 * artifact — or is it merely an INTERNAL record (a Mark-Submitted click, an
 * import, or an autopilot run that captured no evidence)?
 *
 * Owner North Star (2026-08-03): the system must NEVER present something as
 * "externally submitted with proof" when it isn't. A generated application
 * PACKET/DRAFT/PROPOSAL PDF is NOT proof of submission — it is the thing we would
 * submit. The verbatim prod case this module exists to catch: a task stamped
 * `submitted` whose `output_document_id` points at "NAEMT EMS Scholarships — PDF"
 * (a `hamilton_generated_application` packet from the draft step), with NO
 * autopilot run carrying a confirmation reference or a durable confirmation doc.
 *
 * Only the fenced v2 submission-attempt ledger may establish external receipt.
 * Legacy task/run status, confirmation-looking documents, screenshots, and
 * references are not bound to the exact owner/profile/source/portal/application
 * attempt and therefore remain internal-only. The v2 attempt proof must pass
 * `assessExternalReceiptProof`; artifact-only proof remains disabled until the
 * DB-backed owner/profile/bytes/hash verification contract is implemented.
 */

import {
  assessExternalReceiptProof,
  normalizeSubmissionAttemptRow,
} from './hamiltonSubmissionAttemptStore.js'

const CONFIRMATION_DOCUMENT_TYPE = 'hamilton_submission_confirmation'

export const SUBMISSION_PROOF_STATE = Object.freeze({
  // Hamilton (or the user) actually transmitted to the funder AND a durable
  // confirmation artifact exists.
  VERIFIED_EXTERNAL: 'externally_submitted_with_proof',
  // The status flag was set, but no captured external-submission proof exists.
  INTERNAL_ONLY: 'marked_submitted_internal',
  // The task is not in a submitted state at all.
  NOT_SUBMITTED: 'not_submitted',
})

export const SUBMISSION_PROOF_LABELS = Object.freeze({
  [SUBMISSION_PROOF_STATE.VERIFIED_EXTERNAL]: 'Externally submitted — portal confirmation on file',
  [SUBMISSION_PROOF_STATE.INTERNAL_ONLY]: 'Marked submitted (internal record — not confirmed sent to the funder)',
  [SUBMISSION_PROOF_STATE.NOT_SUBMITTED]: 'Not submitted',
})

// Statuses that assert "this application was submitted". `application_tasks`
// only uses 'submitted'; a Hamilton autopilot run additionally uses 'submitted'.
const SUBMITTED_TASK_STATUSES = new Set(['submitted', 'externally_received', 'externally_validated'])

function isSubmittedStatus(status) {
  return SUBMITTED_TASK_STATUSES.has(String(status || '').trim().toLowerCase())
}

function safeJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

function attemptRowForAssessment(row) {
  return normalizeSubmissionAttemptRow(row)
}

/**
 * Map a raw `hamilton_autopilot_runs` DB row to the shape
 * `assessStoredConfirmationProof` reads (`result` object +
 * `confirmation_screenshot_path`).
 */
function runRowForAssessment(row) {
  return {
    id: row.id,
    status: row.status,
    confirmation_reference: row.confirmation_reference ?? null,
    confirmation_screenshot_path: row.confirmation_screenshot_path ?? null,
    result: safeJsonObject(row.result_json),
  }
}

async function loadExternallyReceivedAttempts(db, taskId) {
  if (!db || !taskId) return []
  try {
    const rows = db?.dialect === 'postgres'
      ? await db.prepare(
        `SELECT * FROM hamilton_submission_attempts
          WHERE state IN ('externally_received','externally_validated')
            AND (task_id = ? OR task_references_json @> CAST(? AS JSONB))
          ORDER BY external_received_at DESC`,
      ).all(String(taskId), JSON.stringify([String(taskId)]))
      : await db.prepare(
        `SELECT * FROM hamilton_submission_attempts
          WHERE state IN ('externally_received','externally_validated')
            AND (task_id = ? OR EXISTS (
              SELECT 1 FROM json_each(task_references_json) refs WHERE refs.value = ?
            ))
          ORDER BY external_received_at DESC`,
      ).all(String(taskId), String(taskId))
    return rows || []
  } catch {
    return []
  }
}

async function outputDocumentIsConfirmation(db, documentId) {
  if (!db || !documentId) return { isConfirmation: false, type: null }
  try {
    const doc = await db
      .prepare('SELECT id, type, file_bytes FROM documents WHERE id = ?')
      .get(String(documentId))
    if (!doc) return { isConfirmation: false, type: null, missing: true }
    const bytes = doc.file_bytes
    const hasBytes = Buffer.isBuffer(bytes) ? bytes.length > 0 : Boolean(bytes)
    return {
      isConfirmation: doc.type === CONFIRMATION_DOCUMENT_TYPE && hasBytes,
      type: doc.type || null,
    }
  } catch {
    return { isConfirmation: false, type: null }
  }
}

/**
 * Assess whether a task's `submitted` status is backed by verified external
 * submission proof.
 *
 * @param {object} db
 * @param {object} task  a serialized task (rowToTask shape) — reads `status`,
 *                       `id`, `output_document_id`.
 * @param {object} [opts]
 * @param {Array}  [opts.runs]  pre-loaded submitted run rows (raw DB or mapped);
 *                              avoids a query when the caller already has them.
 * @returns {Promise<{
 *   verified_external: boolean,
 *   state: string,
 *   label: string,
 *   source: string,
 *   proof_document_id: string|null,
 *   confirmation_reference: string|null,
 *   unverified_reason: string|null,
 *   output_document_kind: string|null,
 * }>}
 */
export async function assessTaskSubmissionProof(db, task, opts = {}) {
  const base = {
    verified_external: false,
    state: SUBMISSION_PROOF_STATE.NOT_SUBMITTED,
    label: SUBMISSION_PROOF_LABELS[SUBMISSION_PROOF_STATE.NOT_SUBMITTED],
    source: 'none',
    proof_document_id: null,
    confirmation_reference: null,
    unverified_reason: null,
    output_document_kind: null,
  }
  if (!task || !isSubmittedStatus(task.status)) return base

  const verified = (patch) => ({
    ...base,
    verified_external: true,
    state: SUBMISSION_PROOF_STATE.VERIFIED_EXTERNAL,
    label: SUBMISSION_PROOF_LABELS[SUBMISSION_PROOF_STATE.VERIFIED_EXTERNAL],
    ...patch,
  })

  // Only the v2 attempt ledger can establish external receipt. A legacy run
  // marked submitted, arbitrary confirmation_reference, generic success page,
  // or confirmation-looking output document is insufficient because it is not
  // bound to the exact user/profile/source/portal/application attempt.
  const attempts = Array.isArray(opts.attempts)
    ? opts.attempts
    : await loadExternallyReceivedAttempts(db, task.id)
  for (const row of attempts) {
    const attempt = attemptRowForAssessment(row)
    if (!attempt?.integrity_valid) continue
    const proof = safeJsonObject(row.proof_json ?? row.proof)
    let assessment
    try { assessment = assessExternalReceiptProof(attempt, proof) } catch { continue }
    if (!assessment.verified) continue
    return verified({
      source: 'fenced_submission_attempt',
      proof_document_id: proof.proof_document_id || null,
      confirmation_reference: proof.confirmation_reference || null,
    })
  }

  let outputType = null
  if (task.output_document_id) {
    const document = await outputDocumentIsConfirmation(db, task.output_document_id)
    outputType = document.type
  }
  return {
    ...base,
    state: SUBMISSION_PROOF_STATE.INTERNAL_ONLY,
    label: SUBMISSION_PROOF_LABELS[SUBMISSION_PROOF_STATE.INTERNAL_ONLY],
    unverified_reason: task.status === 'submitted'
      ? 'legacy_submitted_status_without_bound_attempt_proof'
      : 'externally_received_state_without_valid_bound_proof',
    output_document_kind: outputType,
  }
}

/**
 * True ONLY when a task represents a real external submission with retrievable
 * proof. Thin boolean wrapper around `assessTaskSubmissionProof` for call sites
 * that just need the gate.
 */
export async function taskHasVerifiedExternalSubmission(db, task, opts = {}) {
  const assessment = await assessTaskSubmissionProof(db, task, opts)
  return assessment.verified_external === true
}

export const _internal = {
  isSubmittedStatus,
  runRowForAssessment,
  attemptRowForAssessment,
}
