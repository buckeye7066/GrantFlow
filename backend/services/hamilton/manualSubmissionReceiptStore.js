/**
 * Durable binding for a receipt uploaded after the owner completes a real
 * portal submission by hand. This module never launches or drives a browser.
 * A confirmation-kind document is not proof by itself: only an active binding
 * in hamilton_manual_submission_receipts can authorize the canonical proof
 * predicate.
 */

import crypto from 'node:crypto'
import { isPlaceholderUrl } from '../../config/urlRules.js'
import { isSafeUrl } from '../../crawler-os/safeUrl.js'
import { isReservedSyntheticUserId } from '../../middleware/syntheticServiceTokens.js'
import { isControlledBetaSyntheticBrowserUrl } from './controlledBetaBrowserPolicy.js'

export const MANUAL_RECEIPT_ATTESTATION_VERSION = 'hamilton-manual-submit-v1'
export const MANUAL_RECEIPT_DOCUMENT_TYPE = 'hamilton_submission_confirmation'
export const MAX_MANUAL_RECEIPT_BYTES = 10 * 1024 * 1024

const ALLOWED_RECEIPT_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
])

const RECEIPT_ELIGIBLE_TASK_STATUSES = Object.freeze([
  'draft_completed',
  'waiting_for_review',
  'ready_to_submit',
  'submission_verification_required',
  // A legacy/internal "Mark submitted" row may be reconciled with real proof.
  'submitted',
])

const RECEIPT_ELIGIBLE_TASK_STATUS_SET = new Set(RECEIPT_ELIGIBLE_TASK_STATUSES)
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const MAX_REFERENCE_LENGTH = 200
const MAX_REVOCATION_REASON_LENGTH = 500
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export class ManualSubmissionReceiptError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ManualSubmissionReceiptError'
    this.code = code
    this.status = status
    this.statusCode = status
  }
}

function fail(code, message, status = 400) {
  throw new ManualSubmissionReceiptError(code, message, status)
}

function isMissingReceiptSchemaError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  const code = String(error?.code || '')
  return (
    code === '42P01'
    || code === '42703'
    || message.includes('no such table: hamilton_manual_submission_receipts')
    || message.includes('relation "hamilton_manual_submission_receipts" does not exist')
    || message.includes('no such column: file_bytes')
    || message.includes('no column named file_bytes')
    || message.includes('has no column named file_bytes')
    || message.includes('column "file_bytes" does not exist')
  )
}

function isUniqueConstraintError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return String(error?.code || '') === '23505' || message.includes('unique constraint')
}

function schemaUnavailable(error) {
  if (!isMissingReceiptSchemaError(error)) throw error
  throw new ManualSubmissionReceiptError(
    'manual_receipt_schema_unavailable',
    'Manual submission receipts are temporarily unavailable while the database update completes.',
    503,
  )
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeMimeType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized
}

export function detectManualReceiptMimeType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null
  if (bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return 'application/pdf'
  }
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  return null
}

export function validateManualReceiptFile(file) {
  const bytes = file?.buffer
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail('receipt_file_required', 'A PDF, PNG, or JPEG portal confirmation is required.')
  }
  if (bytes.length > MAX_MANUAL_RECEIPT_BYTES) {
    fail('receipt_file_too_large', 'The receipt must be 10 MiB or smaller.', 413)
  }

  const declaredMimeType = normalizeMimeType(file?.mimetype)
  if (!ALLOWED_RECEIPT_MIME_TYPES.has(declaredMimeType)) {
    fail('receipt_file_type_unsupported', 'Only PDF, PNG, and JPEG receipts are accepted.', 415)
  }
  const detectedMimeType = detectManualReceiptMimeType(bytes)
  if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
    fail('receipt_file_signature_mismatch', 'The uploaded receipt does not match its declared file type.', 415)
  }

  return {
    bytes,
    mimeType: detectedMimeType,
    fileSize: bytes.length,
    receiptSha256: sha256(bytes),
  }
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim()
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    fail(
      'idempotency_key_required',
      'A valid Idempotency-Key header (8–128 safe characters) is required.',
    )
  }
  return key
}

function hasControlCharacters(value) {
  for (const character of String(value || '')) {
    const codePoint = character.codePointAt(0)
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function normalizeConfirmationReference(value) {
  const reference = String(value || '').trim()
  if (!reference) return null
  if (reference.length > MAX_REFERENCE_LENGTH || hasControlCharacters(reference)) {
    fail('confirmation_reference_invalid', 'The confirmation reference is invalid.')
  }
  return reference
}

function normalizeSubmittedAt(value) {
  const parsed = new Date(String(value || ''))
  if (!value || Number.isNaN(parsed.getTime())) {
    fail('submitted_at_invalid', 'A valid submission timestamp is required.')
  }
  if (parsed.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
    fail('submitted_at_invalid', 'The submission timestamp cannot be in the future.')
  }
  return parsed.toISOString()
}

function normalizeAttestationVersion(value) {
  if (String(value || '').trim() !== MANUAL_RECEIPT_ATTESTATION_VERSION) {
    fail('attestation_required', 'The current manual-submission attestation is required.')
  }
  return MANUAL_RECEIPT_ATTESTATION_VERSION
}

function normalizeActorUserId(value) {
  const actorUserId = String(value || '').trim()
  if (!actorUserId || isReservedSyntheticUserId(actorUserId)) {
    fail('human_actor_required', 'A resolved human actor is required.', 403)
  }
  return actorUserId
}

async function resolveHumanActorAuthority(db, profileId, actorUserId) {
  const row = await db.prepare(
    `SELECT p.user_id AS owner_user_id,
            (SELECT u.is_admin FROM users u WHERE u.id = ?) AS actor_is_admin
       FROM profiles p
      WHERE p.id = ?
      LIMIT 1`,
  ).get(String(actorUserId), String(profileId))
  const isAdmin = row?.actor_is_admin === true || row?.actor_is_admin === 1
  if (!row || (String(row.owner_user_id || '') !== String(actorUserId) && !isAdmin)) {
    fail('human_owner_required', 'The current profile owner or a DB-resolved human admin is required.', 403)
  }
  return { actorRole: isAdmin ? 'admin' : 'user' }
}

function parseRealExternalPortalUrl(value) {
  const serverValue = String(value || '').trim()
  if (!serverValue) return null
  let parsed
  try {
    parsed = new URL(serverValue)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    return null
  }
  const safety = isSafeUrl(serverValue, { kind: 'apply' })
  const hostname = parsed.hostname.toLowerCase()
  if (
    !safety.ok
    || isPlaceholderUrl(serverValue)
    || isControlledBetaSyntheticBrowserUrl(serverValue)
    || hostname.endsWith('.invalid')
    || hostname.endsWith('.test')
  ) {
    return null
  }
  return parsed
}

function deriveTaskPortalBinding(task) {
  const serverValue = String(task?.portal_url || task?.application_url || '').trim()
  if (!serverValue) {
    fail('portal_origin_unavailable', 'This task has no server-recorded portal URL to bind.', 422)
  }
  const parsed = parseRealExternalPortalUrl(serverValue)
  if (!parsed) {
    fail('portal_origin_not_external', 'Manual submission proof requires a real server-recorded HTTPS portal.', 422)
  }
  // Fragments are browser-only navigation state, not part of the external
  // submission target. Preserve the full normalized path + query in a
  // privacy-preserving hash so two applications on the same portal cannot
  // share proof while query-string tokens are never duplicated in evidence.
  parsed.hash = ''
  return {
    portalOrigin: parsed.origin,
    portalTargetSha256: sha256(parsed.href),
  }
}

function deriveTaskIdentitySha256(task, portalTargetSha256) {
  const normalized = (value) => {
    const text = String(value ?? '').trim()
    return text || null
  }
  return sha256(JSON.stringify({
    task_id: normalized(task?.id),
    profile_id: normalized(task?.profile_id),
    user_id: normalized(task?.user_id),
    opportunity_id: normalized(task?.opportunity_id),
    grant_id: normalized(task?.grant_id),
    portal_id: normalized(task?.portal_id),
    application_id: normalized(task?.application_id),
    university_application_id: normalized(task?.university_application_id),
    automation_type: normalized(task?.automation_type),
    output_document_id: normalized(task?.output_document_id),
    output_pdf_document_id: normalized(task?.output_pdf_document_id),
    output_docx_document_id: normalized(task?.output_docx_document_id),
    output_proposal_document_id: normalized(task?.output_proposal_document_id),
    portal_target_sha256: normalized(portalTargetSha256),
  }))
}

function requestFingerprint({
  taskId,
  profileId,
  portalOrigin,
  portalTargetSha256,
  taskIdentitySha256,
  submittedAt,
  confirmationReference,
  receiptSha256,
  mimeType,
  fileSize,
  attestationVersion,
  actorUserId,
}) {
  return sha256(JSON.stringify({
    task_id: taskId,
    profile_id: profileId,
    portal_origin: portalOrigin,
    portal_target_sha256: portalTargetSha256,
    task_identity_sha256: taskIdentitySha256,
    submitted_at: submittedAt,
    confirmation_reference: confirmationReference,
    receipt_sha256: receiptSha256,
    mime_type: mimeType,
    file_size: fileSize,
    attestation_version: attestationVersion,
    attested_by_user_id: actorUserId,
  }))
}

function rowToReceipt(row) {
  if (!row) return null
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    profile_id: String(row.profile_id),
    document_id: String(row.document_id),
    channel: row.channel,
    portal_origin: row.portal_origin,
    confirmation_reference: row.confirmation_reference ?? null,
    submitted_at: row.submitted_at,
    attestation_version: row.attestation_version,
    attested_by_user_id: row.attested_by_user_id,
    attested_at: row.attested_at,
    receipt_sha256: row.receipt_sha256,
    file_size: Number(row.file_size),
    mime_type: row.mime_type,
    idempotency_key: row.idempotency_key,
    request_fingerprint: row.request_fingerprint,
    status: row.status,
    revoked_at: row.revoked_at ?? null,
    revoked_by_user_id: row.revoked_by_user_id ?? null,
    revocation_reason: row.revocation_reason ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function loadTaskForReceipt(db, taskId, profileId) {
  const lockClause = db?.dialect === 'postgres' ? ' FOR UPDATE' : ''
  return db.prepare(
    `SELECT id, user_id, profile_id, grant_id, opportunity_id, portal_id,
            application_id, university_application_id, automation_type,
            status, portal_url, application_url, output_document_id,
            output_pdf_document_id, output_docx_document_id,
            output_proposal_document_id,
            submitted_at, completed_at, current_step, auto_submit_enabled,
            allow_auto_submit, created_at
       FROM application_tasks
      WHERE id = ? AND profile_id = ?
      LIMIT 1${lockClause}`,
  ).get(String(taskId), String(profileId))
}

async function loadReceiptByIdempotencyKey(db, taskId, profileId, idempotencyKey) {
  try {
    const row = await db.prepare(
      `SELECT *
         FROM hamilton_manual_submission_receipts
        WHERE task_id = ? AND profile_id = ? AND idempotency_key = ?
        LIMIT 1`,
    ).get(String(taskId), String(profileId), idempotencyKey)
    return rowToReceipt(row)
  } catch (error) {
    return schemaUnavailable(error)
  }
}

async function loadActiveReceipt(db, taskId, profileId) {
  try {
    const row = await db.prepare(
      `SELECT *
         FROM hamilton_manual_submission_receipts
        WHERE task_id = ? AND profile_id = ? AND status = 'active'
        LIMIT 1`,
    ).get(String(taskId), String(profileId))
    return rowToReceipt(row)
  } catch (error) {
    return schemaUnavailable(error)
  }
}

function receiptDocumentName(submittedAt) {
  return `Portal submission confirmation — ${String(submittedAt).slice(0, 10)}`
}

function safeReceiptResponse(receipt, { idempotent = false } = {}) {
  if (!receipt) return null
  const { idempotency_key: _idempotencyKey, request_fingerprint: _fingerprint, ...safe } = receipt
  return { ...safe, idempotent }
}

async function appendReceiptEvent(db, {
  taskId,
  eventType,
  status,
  step,
  message,
  actorUserId,
  actorRole,
  details,
}) {
  await db.prepare(
    `INSERT INTO application_task_events
       (id, task_id, event_type, status, step, message, details_json,
        actor_user_id, actor_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).run(
    crypto.randomUUID(),
    taskId,
    eventType,
    status,
    step,
    message,
    JSON.stringify(details || {}),
    actorUserId,
    actorRole,
  )
}

/**
 * Atomically insert immutable evidence, bind it to the exact task/profile, and
 * advance the task. No caller-provided URL is accepted; portal_origin is
 * derived from the task row re-read inside the transaction.
 */
export async function recordManualSubmissionReceipt(db, {
  taskId,
  profileId,
  file,
  submittedAt,
  confirmationReference = null,
  attestationVersion,
  idempotencyKey,
  actorUserId,
} = {}) {
  if (!db?.withTransaction) fail('database_unavailable', 'Database unavailable.', 503)
  const normalizedTaskId = String(taskId || '').trim()
  const normalizedProfileId = String(profileId || '').trim()
  if (!normalizedTaskId || !normalizedProfileId) {
    fail('task_scope_required', 'An exact task and profile are required.')
  }

  const evidence = validateManualReceiptFile(file)
  const normalizedSubmittedAt = normalizeSubmittedAt(submittedAt)
  const normalizedReference = normalizeConfirmationReference(confirmationReference)
  const normalizedAttestation = normalizeAttestationVersion(attestationVersion)
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey)
  const normalizedActorId = normalizeActorUserId(actorUserId)

  try {
    return await db.withTransaction(async (tx) => {
      const task = await loadTaskForReceipt(tx, normalizedTaskId, normalizedProfileId)
      if (!task) fail('task_not_found', 'Application task not found.', 404)
      const { actorRole: authoritativeActorRole } = await resolveHumanActorAuthority(
        tx,
        normalizedProfileId,
        normalizedActorId,
      )
      const { portalOrigin, portalTargetSha256 } = deriveTaskPortalBinding(task)
      const taskIdentitySha256 = deriveTaskIdentitySha256(task, portalTargetSha256)
      const fingerprint = requestFingerprint({
        taskId: normalizedTaskId,
        profileId: normalizedProfileId,
        portalOrigin,
        portalTargetSha256,
        taskIdentitySha256,
        submittedAt: normalizedSubmittedAt,
        confirmationReference: normalizedReference,
        receiptSha256: evidence.receiptSha256,
        mimeType: evidence.mimeType,
        fileSize: evidence.fileSize,
        attestationVersion: normalizedAttestation,
        actorUserId: normalizedActorId,
      })

      const byKey = await loadReceiptByIdempotencyKey(
        tx,
        normalizedTaskId,
        normalizedProfileId,
        normalizedIdempotencyKey,
      )
      if (byKey) {
        if (byKey.request_fingerprint !== fingerprint) {
          fail('idempotency_key_reused', 'This idempotency key was already used for a different receipt.', 409)
        }
        if (byKey.status !== 'active') {
          fail('manual_receipt_revoked', 'That receipt was revoked; use a new idempotency key after review.', 409)
        }
        const proof = await assessManualSubmissionReceiptProof(tx, {
          id: normalizedTaskId,
          profile_id: normalizedProfileId,
        })
        if (!proof || proof.receipt_id !== byKey.id) {
          fail('manual_receipt_evidence_invalid', 'The existing receipt evidence requires human review.', 409)
        }
        return safeReceiptResponse(byKey, { idempotent: true })
      }

      const active = await loadActiveReceipt(tx, normalizedTaskId, normalizedProfileId)
      if (active) {
        fail('manual_receipt_already_bound', 'This task already has an active manual submission receipt.', 409)
      }
      if (!RECEIPT_ELIGIBLE_TASK_STATUS_SET.has(String(task.status || ''))) {
        fail('task_status_not_receipt_eligible', 'This task is not ready for manual submission proof.', 409)
      }

      const documentId = crypto.randomUUID()
      const receiptId = crypto.randomUUID()
      const attestedAt = new Date().toISOString()

      try {
        await tx.prepare(
          `INSERT INTO documents
             (id, grant_id, profile_id, name, type, file_url, file_path,
              file_size, mime_type, file_bytes, processing_status, status,
              content_hash, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'completed', 'submitted',
                   ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ).run(
          documentId,
          task.grant_id || null,
          normalizedProfileId,
          receiptDocumentName(normalizedSubmittedAt),
          MANUAL_RECEIPT_DOCUMENT_TYPE,
          evidence.fileSize,
          evidence.mimeType,
          evidence.bytes,
          evidence.receiptSha256,
          `Immutable owner-attested portal receipt bound to task ${normalizedTaskId}.`,
        )
      } catch (error) {
        schemaUnavailable(error)
      }

      const eligiblePlaceholders = RECEIPT_ELIGIBLE_TASK_STATUSES.map(() => '?').join(', ')
      const transition = await tx.prepare(
        `UPDATE application_tasks
            SET status = 'submitted',
                current_step = 'manual_submission_receipt_recorded',
                submitted_at = ?,
                completed_at = ?,
                auto_submit_enabled = ?,
                allow_auto_submit = ?,
                last_agent_message = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND profile_id = ? AND status IN (${eligiblePlaceholders})`,
      ).run(
        normalizedSubmittedAt,
        attestedAt,
        false,
        false,
        'Manual portal submission recorded with owner-attested confirmation evidence.',
        normalizedTaskId,
        normalizedProfileId,
        ...RECEIPT_ELIGIBLE_TASK_STATUSES,
      )
      if (Number(transition?.changes || 0) !== 1) {
        fail('task_state_conflict', 'The task changed while the receipt was being recorded.', 409)
      }

      // Establish the canonical task state before activating the binding. The
      // DB task-identity trigger intentionally blocks proof-critical task
      // changes once an active receipt exists; the surrounding transaction
      // keeps this transition + binding insert indivisible.
      await tx.prepare(
        `INSERT INTO hamilton_manual_submission_receipts
           (id, task_id, profile_id, document_id, channel, portal_origin,
            portal_target_sha256, task_identity_sha256,
            confirmation_reference, submitted_at, attestation_version,
            attested_by_user_id, attested_at, receipt_sha256, file_size,
            mime_type, idempotency_key,
            request_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'portal_manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run(
        receiptId,
        normalizedTaskId,
        normalizedProfileId,
        documentId,
        portalOrigin,
        portalTargetSha256,
        taskIdentitySha256,
        normalizedReference,
        normalizedSubmittedAt,
        normalizedAttestation,
        normalizedActorId,
        attestedAt,
        evidence.receiptSha256,
        evidence.fileSize,
        evidence.mimeType,
        normalizedIdempotencyKey,
        fingerprint,
      )

      await appendReceiptEvent(tx, {
        taskId: normalizedTaskId,
        eventType: 'submitted',
        status: 'submitted',
        step: 'manual_submission_receipt_recorded',
        message: 'Owner-attested portal confirmation evidence was bound to this task.',
        actorUserId: normalizedActorId,
        actorRole: authoritativeActorRole,
        details: {
          receipt_id: receiptId,
          document_id: documentId,
          channel: 'portal_manual',
          binding_authority: 'hamilton_manual_submission_receipts',
          attestation_version: normalizedAttestation,
          external_receipt_verified: true,
          independently_verified: false,
        },
      })

      return safeReceiptResponse(rowToReceipt({
        id: receiptId,
        task_id: normalizedTaskId,
        profile_id: normalizedProfileId,
        document_id: documentId,
        channel: 'portal_manual',
        portal_origin: portalOrigin,
        portal_target_sha256: portalTargetSha256,
        task_identity_sha256: taskIdentitySha256,
        confirmation_reference: normalizedReference,
        submitted_at: normalizedSubmittedAt,
        attestation_version: normalizedAttestation,
        attested_by_user_id: normalizedActorId,
        attested_at: attestedAt,
        receipt_sha256: evidence.receiptSha256,
        file_size: evidence.fileSize,
        mime_type: evidence.mimeType,
        idempotency_key: normalizedIdempotencyKey,
        request_fingerprint: fingerprint,
        status: 'active',
        created_at: attestedAt,
        updated_at: attestedAt,
      }))
    })
  } catch (error) {
    if (error instanceof ManualSubmissionReceiptError) throw error
    if (isMissingReceiptSchemaError(error)) return schemaUnavailable(error)
    if (isUniqueConstraintError(error)) {
      await resolveHumanActorAuthority(db, normalizedProfileId, normalizedActorId)
      const existing = await loadReceiptByIdempotencyKey(
        db,
        normalizedTaskId,
        normalizedProfileId,
        normalizedIdempotencyKey,
      )
      if (existing) {
        // Recompute against the authoritative task origin before treating a
        // concurrent insert as the same request.
        const task = await loadTaskForReceipt(db, normalizedTaskId, normalizedProfileId)
        const { portalOrigin, portalTargetSha256 } = deriveTaskPortalBinding(task)
        const taskIdentitySha256 = deriveTaskIdentitySha256(task, portalTargetSha256)
        const fingerprint = requestFingerprint({
          taskId: normalizedTaskId,
          profileId: normalizedProfileId,
          portalOrigin,
          portalTargetSha256,
          taskIdentitySha256,
          submittedAt: normalizedSubmittedAt,
          confirmationReference: normalizedReference,
          receiptSha256: evidence.receiptSha256,
          mimeType: evidence.mimeType,
          fileSize: evidence.fileSize,
          attestationVersion: normalizedAttestation,
          actorUserId: normalizedActorId,
        })
        if (existing.status === 'active' && existing.request_fingerprint === fingerprint) {
          const proof = await assessManualSubmissionReceiptProof(db, {
            id: normalizedTaskId,
            profile_id: normalizedProfileId,
          })
          if (!proof || proof.receipt_id !== existing.id) {
            fail('manual_receipt_evidence_invalid', 'The existing receipt evidence requires human review.', 409)
          }
          return safeReceiptResponse(existing, { idempotent: true })
        }
      }
      fail('manual_receipt_conflict', 'A receipt was concurrently bound to this task.', 409)
    }
    throw error
  }
}

/**
 * Append-only revocation. The binding and document remain for audit; the task
 * returns to an explicit verification-required state because the external
 * action may still have occurred.
 */
export async function revokeManualSubmissionReceipt(db, {
  taskId,
  profileId,
  receiptId,
  reason,
  actorUserId,
} = {}) {
  if (!db?.withTransaction) fail('database_unavailable', 'Database unavailable.', 503)
  const normalizedTaskId = String(taskId || '').trim()
  const normalizedProfileId = String(profileId || '').trim()
  const normalizedReceiptId = String(receiptId || '').trim()
  const normalizedActorId = normalizeActorUserId(actorUserId)
  const normalizedReason = String(reason || '').trim()
  if (!normalizedTaskId || !normalizedProfileId || !normalizedReceiptId) {
    fail('receipt_scope_required', 'An exact receipt, task, and profile are required.')
  }
  if (
    !normalizedReason
    || normalizedReason.length > MAX_REVOCATION_REASON_LENGTH
    || hasControlCharacters(normalizedReason)
  ) {
    fail('revocation_reason_required', 'A brief revocation reason is required.')
  }

  try {
    return await db.withTransaction(async (tx) => {
      const task = await loadTaskForReceipt(tx, normalizedTaskId, normalizedProfileId)
      if (!task) fail('task_not_found', 'Application task not found.', 404)
      const { actorRole: authoritativeActorRole } = await resolveHumanActorAuthority(
        tx,
        normalizedProfileId,
        normalizedActorId,
      )

      let receipt
      try {
        receipt = rowToReceipt(await tx.prepare(
          `SELECT *
             FROM hamilton_manual_submission_receipts
            WHERE id = ? AND task_id = ? AND profile_id = ?
            LIMIT 1`,
        ).get(normalizedReceiptId, normalizedTaskId, normalizedProfileId))
      } catch (error) {
        return schemaUnavailable(error)
      }
      if (!receipt) fail('manual_receipt_not_found', 'Manual submission receipt not found.', 404)
      if (receipt.status === 'revoked') return safeReceiptResponse(receipt, { idempotent: true })

      const revokedAt = new Date().toISOString()
      const revoked = await tx.prepare(
        `UPDATE hamilton_manual_submission_receipts
            SET status = 'revoked',
                revoked_at = ?,
                revoked_by_user_id = ?,
                revocation_reason = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND task_id = ? AND profile_id = ? AND status = 'active'`,
      ).run(
        revokedAt,
        normalizedActorId,
        normalizedReason,
        normalizedReceiptId,
        normalizedTaskId,
        normalizedProfileId,
      )
      if (Number(revoked?.changes || 0) !== 1) {
        fail('manual_receipt_conflict', 'The receipt changed while it was being revoked.', 409)
      }

      const transitioned = await tx.prepare(
        `UPDATE application_tasks
            SET status = 'submission_verification_required',
                current_step = 'manual_submission_receipt_revoked',
                submitted_at = NULL,
                completed_at = NULL,
                auto_submit_enabled = ?,
                allow_auto_submit = ?,
                last_agent_message = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND profile_id = ?`,
      ).run(
        false,
        false,
        'Manual submission receipt revoked; external submission requires human verification.',
        normalizedTaskId,
        normalizedProfileId,
      )
      if (Number(transitioned?.changes || 0) !== 1) {
        fail('task_state_conflict', 'The task changed while the receipt was being revoked.', 409)
      }

      await appendReceiptEvent(tx, {
        taskId: normalizedTaskId,
        eventType: 'note',
        status: 'submission_verification_required',
        step: 'manual_submission_receipt_revoked',
        message: 'The owner-attested portal receipt binding was revoked; human verification is required.',
        actorUserId: normalizedActorId,
        actorRole: authoritativeActorRole,
        details: {
          receipt_id: normalizedReceiptId,
          document_id: receipt.document_id,
          binding_authority: 'hamilton_manual_submission_receipts',
          external_receipt_verified: false,
          external_action_may_have_occurred: true,
        },
      })

      return safeReceiptResponse({
        ...receipt,
        status: 'revoked',
        revoked_at: revokedAt,
        revoked_by_user_id: normalizedActorId,
        revocation_reason: normalizedReason,
        updated_at: revokedAt,
      })
    })
  } catch (error) {
    if (error instanceof ManualSubmissionReceiptError) throw error
    if (isMissingReceiptSchemaError(error)) return schemaUnavailable(error)
    throw error
  }
}

/**
 * Read-only proof adapter. Missing rolling-deploy schema or any malformed /
 * tampered binding returns null: it can never promote a task to external proof.
 */
export async function assessManualSubmissionReceiptProof(db, task) {
  if (!db || !task?.id || !task?.profile_id) return null
  let row
  try {
    row = await db.prepare(
      `SELECT r.id, r.task_id, r.profile_id, r.document_id, r.channel,
              r.portal_origin, r.portal_target_sha256, r.task_identity_sha256,
              r.confirmation_reference, r.submitted_at,
              r.attestation_version, r.attested_by_user_id, r.attested_at,
              r.receipt_sha256, r.file_size, r.mime_type, r.status,
              r.request_fingerprint,
              r.revoked_at, r.revoked_by_user_id,
              d.profile_id AS document_profile_id, d.type AS document_type,
              d.content_hash AS document_content_hash,
              d.file_size AS document_file_size, d.mime_type AS document_mime_type,
              length(d.file_bytes) AS document_stored_bytes,
              t.status AS task_status, t.portal_url AS task_portal_url,
              t.application_url AS task_application_url,
              t.user_id AS task_user_id,
              t.opportunity_id AS task_opportunity_id,
              t.grant_id AS task_grant_id,
              t.portal_id AS task_portal_id,
              t.application_id AS task_application_id,
              t.university_application_id AS task_university_application_id,
              t.automation_type AS task_automation_type,
              t.output_document_id AS task_output_document_id,
              t.output_pdf_document_id AS task_output_pdf_document_id,
              t.output_docx_document_id AS task_output_docx_document_id,
              t.output_proposal_document_id AS task_output_proposal_document_id,
              t.submitted_at AS task_submitted_at,
              t.completed_at AS task_completed_at,
              t.current_step AS task_current_step,
              t.auto_submit_enabled AS task_auto_submit_enabled,
              t.allow_auto_submit AS task_allow_auto_submit
         FROM hamilton_manual_submission_receipts r
         JOIN documents d ON d.id = r.document_id
         JOIN application_tasks t ON t.id = r.task_id AND t.profile_id = r.profile_id
        WHERE r.task_id = ? AND r.profile_id = ? AND r.status = 'active'
        LIMIT 1`,
    ).get(String(task.id), String(task.profile_id))
  } catch {
    return null
  }
  if (!row) return null

  const fileSize = Number(row.file_size)
  const documentFileSize = Number(row.document_file_size)
  const storedBytes = Number(row.document_stored_bytes)
  const hash = String(row.receipt_sha256 || '').toLowerCase()
  const documentHash = String(row.document_content_hash || '').toLowerCase()
  const parsedOrigin = parseRealExternalPortalUrl(row.portal_origin)
  const submittedAtMs = Date.parse(String(row.submitted_at || ''))
  const attestedAtMs = Date.parse(String(row.attested_at || ''))
  const taskSubmittedAtMs = Date.parse(String(row.task_submitted_at || ''))
  const taskCompletedAtMs = Date.parse(String(row.task_completed_at || ''))
  let currentPortalBinding
  try {
    currentPortalBinding = deriveTaskPortalBinding({
      portal_url: row.task_portal_url,
      application_url: row.task_application_url,
    })
  } catch {
    return null
  }
  const portalTargetSha256 = String(row.portal_target_sha256 || '').toLowerCase()
  const taskIdentitySha256 = String(row.task_identity_sha256 || '').toLowerCase()
  const currentTaskIdentitySha256 = deriveTaskIdentitySha256({
    id: row.task_id,
    profile_id: row.profile_id,
    user_id: row.task_user_id,
    opportunity_id: row.task_opportunity_id,
    grant_id: row.task_grant_id,
    portal_id: row.task_portal_id,
    application_id: row.task_application_id,
    university_application_id: row.task_university_application_id,
    automation_type: row.task_automation_type,
    output_document_id: row.task_output_document_id,
    output_pdf_document_id: row.task_output_pdf_document_id,
    output_docx_document_id: row.task_output_docx_document_id,
    output_proposal_document_id: row.task_output_proposal_document_id,
  }, currentPortalBinding.portalTargetSha256)
  const expectedFingerprint = requestFingerprint({
    taskId: String(row.task_id),
    profileId: String(row.profile_id),
    portalOrigin: String(row.portal_origin),
    portalTargetSha256,
    taskIdentitySha256,
    submittedAt: Number.isFinite(submittedAtMs)
      ? new Date(submittedAtMs).toISOString()
      : String(row.submitted_at || ''),
    confirmationReference: row.confirmation_reference ?? null,
    receiptSha256: hash,
    mimeType: row.mime_type,
    fileSize,
    attestationVersion: row.attestation_version,
    actorUserId: row.attested_by_user_id,
  })

  if (
    String(row.task_id) !== String(task.id)
    || String(row.profile_id) !== String(task.profile_id)
    || String(row.document_profile_id) !== String(task.profile_id)
    || row.status !== 'active'
    || row.task_status !== 'submitted'
    || row.task_current_step !== 'manual_submission_receipt_recorded'
    || row.revoked_at
    || row.revoked_by_user_id
    || row.channel !== 'portal_manual'
    || row.document_type !== MANUAL_RECEIPT_DOCUMENT_TYPE
    || row.attestation_version !== MANUAL_RECEIPT_ATTESTATION_VERSION
    || !String(row.attested_by_user_id || '').trim()
    || !Number.isFinite(submittedAtMs)
    || !Number.isFinite(attestedAtMs)
    || !Number.isFinite(taskSubmittedAtMs)
    || !Number.isFinite(taskCompletedAtMs)
    || taskSubmittedAtMs !== submittedAtMs
    || taskCompletedAtMs !== attestedAtMs
    || submittedAtMs > attestedAtMs + MAX_CLOCK_SKEW_MS
    || attestedAtMs > Date.now() + MAX_CLOCK_SKEW_MS
    || !/^[a-f0-9]{64}$/.test(hash)
    || hash !== documentHash
    || !/^[a-f0-9]{64}$/.test(portalTargetSha256)
    || portalTargetSha256 !== currentPortalBinding.portalTargetSha256
    || currentPortalBinding.portalOrigin !== row.portal_origin
    || !/^[a-f0-9]{64}$/.test(taskIdentitySha256)
    || taskIdentitySha256 !== currentTaskIdentitySha256
    || !/^[a-f0-9]{64}$/.test(String(row.request_fingerprint || '').toLowerCase())
    || String(row.request_fingerprint).toLowerCase() !== expectedFingerprint
    || !ALLOWED_RECEIPT_MIME_TYPES.has(String(row.mime_type || ''))
    || row.mime_type !== row.document_mime_type
    || !Number.isInteger(fileSize)
    || fileSize <= 0
    || fileSize > MAX_MANUAL_RECEIPT_BYTES
    || documentFileSize !== fileSize
    || storedBytes !== fileSize
    || !parsedOrigin
    || parsedOrigin.origin !== row.portal_origin
    || ![false, 0, '0'].includes(row.task_auto_submit_enabled)
    || ![false, 0, '0'].includes(row.task_allow_auto_submit)
  ) return null

  return {
    receipt_id: String(row.id),
    document_id: String(row.document_id),
    portal_origin: row.portal_origin,
    confirmation_reference: row.confirmation_reference ?? null,
    submitted_at: row.submitted_at,
    attested_at: row.attested_at,
    attested_by_user_id: row.attested_by_user_id,
    attestation_version: row.attestation_version,
    receipt_sha256: hash,
    mime_type: row.mime_type,
    file_size: fileSize,
    evidence_authority: 'owner_attestation',
    independently_verified: false,
  }
}

export const _internal = {
  ALLOWED_RECEIPT_MIME_TYPES,
  RECEIPT_ELIGIBLE_TASK_STATUSES,
  deriveTaskPortalBinding,
  deriveTaskIdentitySha256,
  isMissingReceiptSchemaError,
  normalizeIdempotencyKey,
  requestFingerprint,
}
