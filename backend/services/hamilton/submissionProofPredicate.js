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
 * The proof-reality check is delegated to `assessStoredConfirmationProof`
 * (hamiltonConfirmationArtifacts.js, #1114) so this predicate and the durable
 * proof pipeline can never drift on what "retrievable proof" means. A
 * packet/draft/proposal `output_document_id` NEVER qualifies here — only a
 * `hamilton_submission_confirmation` document (with bytes), or a submitted
 * autopilot run whose confirmation is retrievable, or a captured portal
 * confirmation reference on such a run.
 */

import {
  assessStoredConfirmationProof,
  _internal as confirmationInternal,
} from './hamiltonConfirmationArtifacts.js'

const CONFIRMATION_DOCUMENT_TYPE = confirmationInternal.CONFIRMATION_DOCUMENT_TYPE

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
const SUBMITTED_TASK_STATUSES = new Set(['submitted'])

function isSubmittedStatus(status) {
  return SUBMITTED_TASK_STATUSES.has(String(status || '').trim().toLowerCase())
}

function safeJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw || '{}') } catch { return {} }
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

async function loadSubmittedRunsForTask(db, taskId) {
  if (!db || !taskId) return []
  try {
    const rows = await db
      .prepare(
        `SELECT id, status, confirmation_reference, confirmation_screenshot_path, result_json
           FROM hamilton_autopilot_runs
          WHERE task_id = ? AND status = 'submitted'`,
      )
      .all(String(taskId))
    return (rows || []).map(runRowForAssessment)
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

  // 1) A submitted autopilot run whose confirmation is durably retrievable, or
  //    which carries a captured portal confirmation reference. This is the
  //    strongest, most-honest evidence: the #1114 pipeline's own proof check.
  let runs = opts.runs
  if (!Array.isArray(runs)) runs = await loadSubmittedRunsForTask(db, task.id)
  else runs = runs.map((r) => (r && r.result !== undefined ? r : runRowForAssessment(r)))

  for (const run of runs) {
    const proof = await assessStoredConfirmationProof(db, run)
    if (proof.proof_retrievable) {
      return verified({
        source: `run_${proof.source}`,
        proof_document_id: proof.document_id || null,
        confirmation_reference: run.confirmation_reference || null,
      })
    }
    const ref = String(run.confirmation_reference || '').trim()
    if (ref) {
      // A portal-issued confirmation reference stored on a submitted run is
      // itself a durable, captured portal fact (survives a filesystem wipe).
      return verified({ source: 'confirmation_reference', confirmation_reference: ref })
    }
  }

  // 2) The task's output_document_id — ONLY a confirmation-kind document counts.
  //    A packet/draft/proposal (`hamilton_generated_application`, etc.) is the
  //    thing we would submit, never proof that we did.
  if (task.output_document_id) {
    const { isConfirmation, type } = await outputDocumentIsConfirmation(db, task.output_document_id)
    if (isConfirmation) {
      return verified({ source: 'output_confirmation_doc', proof_document_id: String(task.output_document_id), output_document_kind: type })
    }
    return {
      ...base,
      state: SUBMISSION_PROOF_STATE.INTERNAL_ONLY,
      label: SUBMISSION_PROOF_LABELS[SUBMISSION_PROOF_STATE.INTERNAL_ONLY],
      unverified_reason: type ? `output_document_is_${type}` : 'output_document_not_confirmation',
      output_document_kind: type,
    }
  }

  // 3) Submitted, but nothing retrievable: an internal record only.
  return {
    ...base,
    state: SUBMISSION_PROOF_STATE.INTERNAL_ONLY,
    label: SUBMISSION_PROOF_LABELS[SUBMISSION_PROOF_STATE.INTERNAL_ONLY],
    unverified_reason: runs.length > 0 ? 'run_without_captured_evidence' : 'no_run_no_confirmation_doc',
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
  CONFIRMATION_DOCUMENT_TYPE,
  isSubmittedStatus,
  runRowForAssessment,
}
