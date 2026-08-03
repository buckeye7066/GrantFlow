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
 *   2. `registerConfirmationArtifact` registers the captured confirmation
 *      (screenshot + saved page HTML/text) as retrievable `documents` rows via
 *      the SAME `insertDocumentRecord` helper the mail/fax packet and proposal
 *      PDF paths use — bytes land in `documents.file_bytes` (BYTEA), so the
 *      owner can open the proof at `/api/documents/<id>/download` even after the
 *      ephemeral on-disk copy is gone.
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
 * Register the captured confirmation as owner-retrievable `documents` rows.
 * Reuses the packet generator's `insertDocumentRecord` (bytes → BYTEA), so the
 * proof survives an ephemeral-filesystem wipe and serves at
 * `/api/documents/<id>/download`. Best-effort: a registration failure NEVER
 * fails the run — the caller keeps the filesystem-path fields regardless.
 *
 * @returns {Promise<{screenshot_document_id: string|null, page_document_id: string|null}>}
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
  capturedUrl = null,
} = {}) {
  const out = { screenshot_document_id: null, page_document_id: null }
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
    'External portal submission confirmation.',
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
        name: `${safeTitle} — Portal submission confirmation (screenshot)`,
        type: CONFIRMATION_DOCUMENT_TYPE,
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
        name: `${safeTitle} — Portal submission confirmation (page)`,
        type: CONFIRMATION_DOCUMENT_TYPE,
        filePath: pageHtmlPath,
        mimeType: 'text/html',
        fileSize: htmlBytes.length,
        notes,
        extractedText: extracted,
        fileBytes: htmlBytes,
      })
    } catch { /* best-effort */ }
  }

  return out
}

/**
 * Read/verify helper (backfill honesty): report proof PRESENT only when it is
 * ACTUALLY retrievable. A durable `documents` row with bytes is the strongest
 * evidence; an on-disk screenshot that still exists is next; a
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

  if (db && docIds.length > 0) {
    for (const docId of docIds) {
      try {
        const doc = await db.prepare('SELECT id, file_bytes, file_path FROM documents WHERE id = ?').get(docId)
        if (!doc) continue
        const bytes = doc.file_bytes
        const hasBytes = Buffer.isBuffer(bytes) ? bytes.length > 0 : Boolean(bytes)
        if (hasBytes) return { proof_retrievable: true, source: 'document', document_id: String(doc.id) }
        if (doc.file_path && fs.existsSync(doc.file_path)) {
          return { proof_retrievable: true, source: 'document_disk', document_id: String(doc.id) }
        }
      } catch { /* fall through to disk check */ }
    }
  }

  const screenshotPath = run?.confirmation_screenshot_path || result.confirmation_screenshot_path || null
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    return { proof_retrievable: true, source: 'disk', screenshot_path: screenshotPath }
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
  EPHEMERAL_DIR_NAME,
  DEFAULT_PRODUCTION_UPLOADS_DIR,
  readFileBytesSafe,
}
