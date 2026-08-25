/**
 * hamiltonConfirmationArtifacts.js
 *
 * Durable, owner-retrievable PROOF of an external portal submission.
 *
 * The confirmation screenshot the autopilot engine captures used to land in
 * `os.tmpdir()` (the orchestrator never passed a `screenshotsDir`), so on
 * Railway's ephemeral filesystem every screenshot was wiped on the next
 * deploy/restart — while `hamilton_autopilot_runs.confirmation_screenshot_path`
 * kept pointing at a file that no longer existed. A genuine submission's proof
 * evaporated, and the DB read as if proof existed when it did not.
 *
 * This module closes that gap two ways:
 *   1. `resolveConfirmationCaptureDir` resolves a PERSISTENT capture directory
 *      under UPLOADS_DIR (the same volume that holds the runtime-secrets key),
 *      never `os.tmpdir()` in production.
 *   2. `registerConfirmationArtifact` registers the captured portal outcome
 *      (screenshot + saved page HTML/text) as retrievable `documents` rows via
 *      the SAME `insertDocumentRecord` helper the mail/fax packet and proposal
 *      PDF paths use — bytes land in `documents.file_bytes` (BYTEA), so the
 *      owner can open the evidence at `/api/documents/<id>/download` even after
 *      the ephemeral on-disk copy is gone. Captures without a genuinely new
 *      portal reference use an attempt-evidence document type, never proof.
 *   3. `assessStoredConfirmationProof` is the read/verify helper: it reports
 *      proof as PRESENT only when it is ACTUALLY retrievable (durable document
 *      bytes, or an on-disk file that still exists) — so a run whose
 *      `confirmation_screenshot_path` points at a now-missing tmp file no longer
 *      reads as if proof exists.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIRMATION_DIR_NAME = 'hamilton-confirmations'
// Mirrors runtimeSecrets.DEFAULT_PRODUCTION_KEY_FILE's directory: the Railway
// persistent volume. Used only as the production floor when UPLOADS_DIR is unset
// so a production capture can NEVER fall back to ephemeral tmp.
const DEFAULT_PRODUCTION_UPLOADS_DIR = '/data/uploads'
// Kept identical to the engine's historical fallback name so existing dev/test
// captures land in the same place.
const EPHEMERAL_DIR_NAME = 'hamilton-autopilot-screens'

const CONFIRMATION_DOCUMENT_TYPE = 'hamilton_submission_confirmation'
const ATTEMPT_EVIDENCE_DOCUMENT_TYPE = 'hamilton_submission_attempt_evidence'

function isProduction(env = process.env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
}

function isTestLikeRuntime(env = process.env) {
  const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || '').trim())
  return (
    String(env.NODE_ENV || '').trim().toLowerCase() === 'test' ||
    truthy(env.SMOKE_MODE) ||
    truthy(env.ALLOW_EPHEMERAL_SQLITE)
  )
}

/**
 * Resolve the directory the confirmation screenshot + saved page are written to.
 * Resolution order (mirrors runtimeSecrets' key-file resolution):
 *   1. HAMILTON_CONFIRMATION_DIR (explicit override, absolute).
 *   2. UPLOADS_DIR (the persistent volume) → `<UPLOADS_DIR>/hamilton-confirmations`.
 *   3. Production with no UPLOADS_DIR → `/data/uploads/hamilton-confirmations`
 *      (never tmp in prod).
 *   4. Otherwise (dev/test) → `os.tmpdir()/hamilton-autopilot-screens`.
 */
export function confirmationCaptureDirPath(env = process.env) {
  const explicit = String(env.HAMILTON_CONFIRMATION_DIR || '').trim()
  if (explicit) return path.resolve(explicit)

  const uploadsDir = String(env.UPLOADS_DIR || '').trim()
  if (uploadsDir && path.isAbsolute(uploadsDir)) {
    return path.join(uploadsDir, CONFIRMATION_DIR_NAME)
  }
  if (isProduction(env) && !isTestLikeRuntime(env)) {
    return path.join(DEFAULT_PRODUCTION_UPLOADS_DIR, CONFIRMATION_DIR_NAME)
  }
  return path.join(os.tmpdir(), EPHEMERAL_DIR_NAME)
}

export function resolveConfirmationCaptureDir(env = process.env) {
  const dir = confirmationCaptureDirPath(env)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* best-effort; capture handles a write failure */ }
  return dir
}

/** True when `dir` is the ephemeral tmp fallback (nothing persists it). */
export function isEphemeralCaptureDir(dir) {
  if (!dir) return true
  const resolved = path.resolve(dir)
  return resolved.startsWith(path.join(os.tmpdir(), EPHEMERAL_DIR_NAME))
}

function readFileBytesSafe(filePath) {
  if (!filePath) return null
  try {
    if (!fs.existsSync(filePath)) return null
    const buf = fs.readFileSync(filePath)
    return buf.length > 0 ? buf : null
  } catch {
    return null
  }
}

/**
 * Register the captured portal outcome as owner-retrievable `documents` rows.
 * Reuses the packet generator's `insertDocumentRecord` (bytes → BYTEA), so the
 * proof survives an ephemeral-filesystem wipe and serves at
 * `/api/documents/<id>/download`. Best-effort: a registration failure NEVER
 * fails the run — the caller keeps the filesystem-path fields regardless.
 *
 * @returns {Promise<{screenshot_document_id: string|null, page_document_id: string|null, evidence_classification: 'confirmation_proof'|'attempt_evidence'}>}
 */
export async function registerConfirmationArtifact(db, {
  profileId,
  grantId = null,
  opportunityId = null,
  taskId = null,
  title = 'Application',
  screenshotPath = null,
  pageHtmlPath = null,
  pageText = null,
  reference = null,
  referenceIsNew = null,
  receivedAcknowledgement = false,
  receivedAcknowledgementIsNew = false,
  capturedUrl = null,
} = {}) {
  const confirmedReference = Boolean(reference) && referenceIsNew === true
  const confirmedAcknowledgement = receivedAcknowledgement === true
    && receivedAcknowledgementIsNew === true
  const confirmedReceipt = confirmedReference || confirmedAcknowledgement
  const evidenceClassification = confirmedReceipt ? 'confirmation_proof' : 'attempt_evidence'
  const documentType = confirmedReceipt
    ? CONFIRMATION_DOCUMENT_TYPE
    : ATTEMPT_EVIDENCE_DOCUMENT_TYPE
  const out = {
    screenshot_document_id: null,
    page_document_id: null,
    evidence_classification: evidenceClassification,
  }
  if (!db || !profileId) return out

  let insertDocumentRecord
  try {
    ({ _internal: { insertDocumentRecord } } = await import('./hamiltonApplicationPacketGenerator.js'))
  } catch {
    return out
  }
  if (typeof insertDocumentRecord !== 'function') return out

  const safeTitle = String(title || 'Application').slice(0, 120).trim() || 'Application'
  const extracted = pageText ? String(pageText).slice(0, 20000) : null
  const notes = [
    confirmedReceipt
      ? confirmedReference
        ? 'External portal submission confirmation with a new portal reference.'
        : 'External portal submission confirmation with a newly appearing receipt acknowledgement.'
      : 'External portal submit-attempt evidence; receipt is not confirmed.',
    taskId ? `task_id=${taskId}.` : '',
    reference ? `reference=${reference}.` : '',
    capturedUrl ? `url=${capturedUrl}` : '',
  ].filter(Boolean).join(' ')

  const shotBytes = readFileBytesSafe(screenshotPath)
  if (shotBytes) {
    try {
      out.screenshot_document_id = await insertDocumentRecord(db, {
        profileId,
        grantId,
        opportunityId,
        name: confirmedReceipt
          ? `${safeTitle} — Portal submission confirmation (screenshot)`
          : `${safeTitle} — Portal submit attempt (screenshot)`,
        type: documentType,
        filePath: screenshotPath,
        mimeType: 'image/png',
        fileSize: shotBytes.length,
        notes,
        extractedText: extracted,
        fileBytes: shotBytes,
      })
    } catch { /* best-effort; the run is still recorded honestly */ }
  }

  const htmlBytes = readFileBytesSafe(pageHtmlPath)
  if (htmlBytes) {
    try {
      out.page_document_id = await insertDocumentRecord(db, {
        profileId,
        grantId,
        opportunityId,
        name: confirmedReceipt
          ? `${safeTitle} — Portal submission confirmation (page)`
          : `${safeTitle} — Portal submit attempt (page)`,
        type: documentType,
        filePath: pageHtmlPath,
        mimeType: 'text/html',
        fileSize: htmlBytes.length,
        notes,
        extractedText: extracted,
        fileBytes: htmlBytes,
      })
    } catch { /* best-effort */ }
  }

  // MIRROR VERIFIED SUBMISSION -> cross-cycle claim ledger.
  //
  // This is the BIRTH of proof, not a status write: `confirmedReceipt` is only
  // true when a genuinely NEW portal reference or acknowledgement was captured,
  // which is the same bar submissionProofPredicate reads back as
  // VERIFIED_EXTERNAL. Mirroring here (rather than in assessTaskSubmissionProof)
  // keeps the claim ledger a write-once consequence of proof instead of a side
  // effect of every tracker read.
  //
  // Best-effort by construction: a ledger failure must never break a submission
  // that actually succeeded. The unique active index makes repeats idempotent.
  if (confirmedReceipt) {
    try {
      const { recordVerifiedSubmissionClaim } = await import('./priorCycleApplicationGuard.js')
      await recordVerifiedSubmissionClaim(db, {
        profileId,
        opportunityId,
        taskId,
        submittedAt: new Date().toISOString(),
        confirmationReference: reference || null,
      })
    } catch {
      // Ledger is a safety net, never an authority over the submission path.
    }
  }

  return out
}

/**
 * Read/verify helper (backfill honesty): report proof PRESENT only when a run
 * records a genuinely new portal reference or receipt acknowledgement and its
 * confirmation artifact is ACTUALLY retrievable. Ambiguous screenshots/pages
 * remain attempt evidence. A
 * `confirmation_screenshot_path` pointing at a now-missing file is NOT proof.
 * Reports; never deletes.
 *
 * @param {object} db
 * @param {object} run  a `hamilton_autopilot_runs` row (as returned by rowToRun)
 * @returns {Promise<{proof_retrievable: boolean, source: string, document_id?: string, screenshot_path?: string|null, reason?: string}>}
 */
export async function assessStoredConfirmationProof(db, run) {
  const result = (run && typeof run.result === 'object' && run.result) || {}
  const docIds = [result.confirmation_document_id, result.confirmation_page_document_id].filter(Boolean)
  const reference = String(
    result.confirmation_reference || run?.confirmation_reference || '',
  ).trim()
  const referenceIsNew = result.confirmation_reference_is_new === true
    && result.confirmation_evidence === 'portal_reference'
  const acknowledgementIsNew = result.confirmation_received_acknowledgement_is_new === true
    && result.confirmation_received_acknowledgement === true
    && result.confirmation_evidence === 'portal_acknowledgement'
  const classifiedAsProof = Boolean((reference && referenceIsNew) || acknowledgementIsNew)
  let attemptDocumentId = null

  if (db && docIds.length > 0) {
    for (const docId of docIds) {
      try {
        const doc = await db.prepare('SELECT id, type, file_bytes, file_path FROM documents WHERE id = ?').get(docId)
        if (!doc) continue
        const bytes = doc.file_bytes
        const hasBytes = Buffer.isBuffer(bytes) ? bytes.length > 0 : Boolean(bytes)
        const retrievable = hasBytes || Boolean(doc.file_path && fs.existsSync(doc.file_path))
        if (!retrievable) continue
        if (classifiedAsProof && doc.type === CONFIRMATION_DOCUMENT_TYPE) {
          if (hasBytes) return { proof_retrievable: true, source: 'document', document_id: String(doc.id) }
          return { proof_retrievable: true, source: 'document_disk', document_id: String(doc.id) }
        }
        attemptDocumentId ||= String(doc.id)
      } catch { /* fall through to disk check */ }
    }
  }

  const screenshotPath = run?.confirmation_screenshot_path || result.confirmation_screenshot_path || null
  const pageHtmlPath = result.confirmation_page_html_path || null
  const screenshotExists = Boolean(screenshotPath && fs.existsSync(screenshotPath))
  const pageExists = Boolean(pageHtmlPath && fs.existsSync(pageHtmlPath))
  if (classifiedAsProof && screenshotExists) {
    return { proof_retrievable: true, source: 'disk', screenshot_path: screenshotPath }
  }

  if (attemptDocumentId || screenshotExists || pageExists) {
    return {
      proof_retrievable: false,
      attempt_evidence_retrievable: true,
      source: attemptDocumentId ? 'attempt_document' : 'attempt_disk',
      document_id: attemptDocumentId,
      screenshot_path: screenshotPath || null,
      page_html_path: pageHtmlPath || null,
      reason: 'attempt_evidence_is_not_confirmation_proof',
    }
  }

  return {
    proof_retrievable: false,
    source: 'none',
    screenshot_path: screenshotPath || null,
    reason: screenshotPath ? 'screenshot_path_missing_on_disk' : 'no_evidence_recorded',
  }
}

export const _internal = {
  CONFIRMATION_DIR_NAME,
  CONFIRMATION_DOCUMENT_TYPE,
  ATTEMPT_EVIDENCE_DOCUMENT_TYPE,
  EPHEMERAL_DIR_NAME,
  DEFAULT_PRODUCTION_UPLOADS_DIR,
  readFileBytesSafe,
}
