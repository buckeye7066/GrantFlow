/**
 * Durable, fenced lifecycle for one external portal application attempt.
 *
 * This is deliberately separate from `hamilton_autopilot_runs`: runs are
 * operational history and may be retried, while one submission attempt owns
 * the irreversible click and its proof.  All callers converge on the same
 * idempotency key, and every mutation requires the current fencing token.
 */
import crypto from 'node:crypto'
import {
  HAMILTON_HUMAN_ACTION_KINDS,
  HAMILTON_SUBMISSION_LIFECYCLE,
  HAMILTON_TERMINAL_RECEIPT_STATES,
} from '../../../shared/hamiltonSubmissionContract.js'
import {
  IRREVERSIBLE_ACTION_CONTRACT_VERSION,
  buildExternalActionIdempotencyKey,
  validateEvidenceTimeline,
} from '../../../shared/irreversibleActionContract.js'
import { getPolicyFor, getReviewedSubmissionAdapter } from './hamiltonPortalPolicyRegistry.js'
import { decryptRuntimeSecret, encryptRuntimeSecret } from '../../utils/runtimeSecrets.js'

const DEFAULT_LEASE_MS = 5 * 60_000
const MAX_LEASE_MS = 30 * 60_000
const PROOF_POLICY_VERSION = 'hamilton-external-proof-v2'
const IMPLEMENTATION_VERSION = 'hamilton-external-submit-v2'
const ACTION_TYPE = 'external_application_submit'
const SAFE_PROOF_TYPES = new Set([
  'portal_confirmation_reference',
  'portal_tracking_number',
  'confirmation_pdf',
  'portal_status_verified',
  'agency_api_status',
])
const SAFE_PROOF_SOURCES = new Set(['portal_response', 'authenticated_portal', 'agency_api'])
const SECRET_KEY_RX = /(password|passcode|otp|totp|mfa|secret|credential|cookie|authorization|token)/i

let ensuredSubmissionSchema = new WeakSet()

export function _resetSubmissionAttemptSchemaCache() {
  ensuredSubmissionSchema = new WeakSet()
}

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString()
}

function normalizePortalHost(input) {
  const raw = String(input || '').trim().toLowerCase()
  if (!raw) return null
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
    return host || null
  } catch {
    return null
  }
}

function canonicalEvidencePortalUrl(input, adapter = null) {
  try {
    const parsed = new URL(String(input))
    if (parsed.protocol !== 'https:') return null
    const origin = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
    const path = parsed.pathname || '/'
    const adapterOriginMatches = parsed.protocol === 'https:'
      && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443')
      && parsed.hostname.toLowerCase() === String(adapter?.portal_host || '').toLowerCase()
      && Array.isArray(adapter?.allowed_origins)
      && adapter.allowed_origins.includes(`https://${parsed.hostname.toLowerCase()}`)
    const reviewedPrefix = adapterOriginMatches && Array.isArray(adapter?.allowed_path_prefixes)
      ? adapter.allowed_path_prefixes
        .map((value) => String(value || '').replace(/\/+$/, '') || '/')
        .find((prefix) => prefix === '/' || path === prefix || path.startsWith(`${prefix}/`))
      : null
    // Dynamic path segments frequently contain bearer-like resume or
    // application identifiers. Persist only origin plus a reviewed static
    // adapter prefix; the full locator remains encrypted and hash-bound.
    return `${origin}${reviewedPrefix && reviewedPrefix !== '/' ? reviewedPrefix : '/'}`
  } catch { return null }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value ?? null))
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function safeJson(raw, fallback = {}) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw || '{}') } catch { return fallback }
}

function strictStringArray(raw, field, { maxItems = 250, maxLength = 500 } = {}) {
  let parsed
  try {
    parsed = raw && typeof raw === 'object' ? raw : JSON.parse(raw || '[]')
  } catch {
    return { value: [], error: `${field}_malformed_json` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: `${field}_must_be_array` }
  if (parsed.length > maxItems) return { value: [], error: `${field}_too_many_items` }
  const value = []
  for (const item of parsed) {
    if (typeof item !== 'string') return { value: [], error: `${field}_must_contain_strings` }
    const normalized = item.trim()
    if (!normalized || normalized.length > maxLength) {
      return { value: [], error: `${field}_contains_invalid_string` }
    }
    value.push(normalized)
  }
  return { value: [...new Set(value)].sort(), error: null }
}

function strictTaskScopes(raw, taskReferences) {
  let parsed
  try {
    parsed = raw && typeof raw === 'object' ? raw : JSON.parse(raw || '{}')
  } catch {
    return { value: {}, error: 'task_scopes_malformed_json' }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { value: {}, error: 'task_scopes_must_be_object' }
  }
  const entries = Object.entries(parsed)
  if (entries.length > 250) return { value: {}, error: 'task_scopes_too_many_items' }
  const value = {}
  for (const [taskId, scope] of entries) {
    if (!taskId.trim() || taskId.length > 500 || !scope || Array.isArray(scope) || typeof scope !== 'object') {
      return { value: {}, error: 'task_scopes_contains_invalid_entry' }
    }
    const fundingSourceId = String(scope.funding_source_id || '').trim()
    const authorizationTargetId = String(scope.authorization_target_id || '').trim()
    if (!fundingSourceId || fundingSourceId.length > 500
        || !authorizationTargetId || authorizationTargetId.length > 500) {
      return { value: {}, error: 'task_scopes_contains_invalid_scope' }
    }
    value[taskId] = {
      funding_source_id: fundingSourceId,
      authorization_target_id: authorizationTargetId,
    }
  }
  const referenceSet = new Set(taskReferences || [])
  const scopeKeys = Object.keys(value)
  if (scopeKeys.some((taskId) => !referenceSet.has(taskId))
      || [...referenceSet].some((taskId) => !Object.hasOwn(value, taskId))) {
    return { value: {}, error: 'task_scopes_reference_mismatch' }
  }
  return { value, error: null }
}

function redactAuditValue(value, depth = 0) {
  if (depth > 6) return '[depth-limited]'
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1))
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 1000)
    return value
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_RX.test(key) ? '[redacted]' : redactAuditValue(item, depth + 1)
  }
  return out
}

function rowToAttempt(row) {
  if (!row) return null
  const taskReferences = strictStringArray(row.task_references_json ?? row.task_references, 'task_references')
  const taskScopes = strictTaskScopes(row.task_scopes_json ?? row.task_scopes, taskReferences.value)
  const authorizationIds = strictStringArray(row.authorization_ids_json ?? row.authorization_ids, 'authorization_ids')
  const documentIds = strictStringArray(row.document_ids_json ?? row.document_ids, 'document_ids')
  const integrityErrors = [taskReferences.error, taskScopes.error, authorizationIds.error, documentIds.error].filter(Boolean)
  if (!taskReferences.error && !taskReferences.value.includes(String(row.task_id || ''))) {
    integrityErrors.push('task_references_missing_primary_task')
  }
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    task_id: row.task_id,
    task_references: taskReferences.value,
    task_scopes: taskScopes.value,
    profile_id: row.profile_id,
    user_id: row.user_id,
    funding_source_id: row.funding_source_id,
    authorization_target_id: row.authorization_target_id,
    portal_host: row.portal_host,
    target_url: row.target_url,
    target_locator_sha256: row.target_locator_sha256,
    application_identity: row.application_identity,
    authorization_version: row.authorization_version,
    authorization_ids: authorizationIds.value,
    consent_snapshot_hash: row.consent_snapshot_hash,
    answer_snapshot_hash: row.answer_snapshot_hash,
    answer_provenance: safeJson(row.answer_provenance_json ?? row.answer_provenance, {}),
    document_ids: documentIds.value,
    submission_adapter: safeJson(row.submission_adapter_json ?? row.submission_adapter, null),
    action_type: row.action_type || ACTION_TYPE,
    requested_payload_hash: row.requested_payload_hash,
    policy_version: row.policy_version,
    implementation_version: row.implementation_version,
    attempt_number: Number(row.attempt_number || 1),
    fence_generation: Number(row.fence_generation || 0),
    evidence_required: safeJson(row.evidence_required_json ?? row.evidence_required, {}),
    reconciliation: safeJson(row.reconciliation_json ?? row.reconciliation, {}),
    state: row.state,
    human_action_kind: row.human_action_kind ?? null,
    checkpoint: safeJson(row.checkpoint_json ?? row.checkpoint, {}),
    lease_owner: row.lease_owner ?? null,
    fence_token: row.fence_token ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    submit_dispatched_at: row.submit_dispatched_at ?? null,
    reconciliation_required_at: row.reconciliation_required_at ?? null,
    reconciliation_attempts: Number(row.reconciliation_attempts || 0),
    next_reconcile_at: row.next_reconcile_at ?? null,
    reconciliation_last_error: row.reconciliation_last_error ?? null,
    manual_review_required_at: row.manual_review_required_at ?? null,
    external_received_at: row.external_received_at ?? null,
    external_validated_at: row.external_validated_at ?? null,
    proof: safeJson(row.proof_json ?? row.proof, {}),
    cancelled_reason: row.cancelled_reason ?? null,
    integrity_valid: integrityErrors.length === 0,
    integrity_quarantined: integrityErrors.length > 0,
    integrity_errors: integrityErrors,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function assertAttemptIntegrity(attempt) {
  if (!attempt) return attempt
  if (!attempt?.integrity_valid) {
    const error = new Error('submission_attempt_integrity_quarantined')
    error.code = 'SUBMISSION_ATTEMPT_INTEGRITY_QUARANTINED'
    error.integrity_fields = [...(attempt?.integrity_errors || [])]
    throw error
  }
  return attempt
}

export function normalizeSubmissionAttemptRow(row) {
  return rowToAttempt(row)
}

export function buildSubmissionAttemptIdempotencyKey({
  profileId,
  portalHost,
  applicationIdentity,
} = {}) {
  const normalizedHost = normalizePortalHost(portalHost)
  return buildExternalActionIdempotencyKey('hamilton-submit-v2', {
    profile_id: profileId,
    portal_host: normalizedHost,
    application_identity: applicationIdentity,
  })
}

export async function ensureHamiltonSubmissionAttemptSchema(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('db required')
  if (ensuredSubmissionSchema.has(db)) return
  const isPostgres = db?.dialect === 'postgres'
  const ts = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const json = isPostgres ? 'JSONB' : 'TEXT'
  const emptyObj = isPostgres ? `'{}'::jsonb` : `'{}'`
  const emptyArray = isPostgres ? `'[]'::jsonb` : `'[]'`
  const now = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hamilton_submission_attempts (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      task_references_json ${json} NOT NULL DEFAULT ${emptyArray},
      task_scopes_json ${json} NOT NULL DEFAULT ${emptyObj},
      profile_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      funding_source_id TEXT NOT NULL,
      authorization_target_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      target_url TEXT NOT NULL,
      target_locator_ciphertext TEXT NOT NULL,
      target_locator_iv TEXT NOT NULL,
      target_locator_tag TEXT NOT NULL,
      target_locator_sha256 TEXT NOT NULL,
      application_identity TEXT NOT NULL,
      authorization_version TEXT NOT NULL,
      authorization_ids_json ${json} NOT NULL DEFAULT ${emptyArray},
      consent_snapshot_hash TEXT NOT NULL,
      answer_snapshot_hash TEXT NOT NULL,
      answer_provenance_json ${json} NOT NULL DEFAULT ${emptyObj},
      document_ids_json ${json} NOT NULL DEFAULT ${emptyArray},
      submission_adapter_json ${json} NOT NULL DEFAULT ${emptyObj},
      action_type TEXT NOT NULL DEFAULT '${ACTION_TYPE}',
      requested_payload_hash TEXT NOT NULL,
      policy_version TEXT NOT NULL DEFAULT '${IRREVERSIBLE_ACTION_CONTRACT_VERSION}',
      implementation_version TEXT NOT NULL DEFAULT '${IMPLEMENTATION_VERSION}',
      attempt_number INTEGER NOT NULL DEFAULT 1,
      fence_generation INTEGER NOT NULL DEFAULT 1,
      evidence_required_json ${json} NOT NULL DEFAULT ${emptyObj},
      reconciliation_json ${json} NOT NULL DEFAULT ${emptyObj},
      state TEXT NOT NULL DEFAULT 'prepared',
      human_action_kind TEXT,
      checkpoint_json ${json} NOT NULL DEFAULT ${emptyObj},
      lease_owner TEXT,
      fence_token TEXT,
      lease_expires_at ${ts},
      submit_dispatched_at ${ts},
      reconciliation_required_at ${ts},
      reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
      next_reconcile_at ${ts},
      reconciliation_last_error TEXT,
      manual_review_required_at ${ts},
      external_received_at ${ts},
      external_validated_at ${ts},
      proof_json ${json} NOT NULL DEFAULT ${emptyObj},
      cancelled_reason TEXT,
      created_at ${ts} NOT NULL DEFAULT ${now},
      updated_at ${ts} NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_task
      ON hamilton_submission_attempts(task_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_profile
      ON hamilton_submission_attempts(profile_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_state
      ON hamilton_submission_attempts(state);
    CREATE INDEX IF NOT EXISTS idx_hamilton_submit_attempt_reconcile_due
      ON hamilton_submission_attempts(state, next_reconcile_at, lease_expires_at);

    CREATE TABLE IF NOT EXISTS hamilton_submission_audit_events (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      event_type TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      details_json ${json} NOT NULL DEFAULT ${emptyObj},
      previous_event_hash TEXT,
      event_hash TEXT NOT NULL,
      created_at ${ts} NOT NULL DEFAULT ${now}
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_submit_audit_attempt
      ON hamilton_submission_audit_events(attempt_id, event_sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hamilton_submit_audit_sequence
      ON hamilton_submission_audit_events(attempt_id, event_sequence);

    CREATE TABLE IF NOT EXISTS hamilton_submission_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json ${json} NOT NULL DEFAULT ${emptyObj},
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at ${ts},
      next_attempt_at ${ts},
      last_error TEXT,
      created_at ${ts} NOT NULL DEFAULT ${now},
      updated_at ${ts} NOT NULL DEFAULT ${now},
      processed_at ${ts},
      UNIQUE(attempt_id, event_type)
    );
    CREATE INDEX IF NOT EXISTS idx_hamilton_submit_outbox_pending
      ON hamilton_submission_outbox(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS hamilton_submission_task_projections (
      attempt_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      notification_id TEXT,
      projected_at ${ts} NOT NULL DEFAULT ${now},
      PRIMARY KEY (attempt_id, task_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hamilton_submit_projection_event
      ON hamilton_submission_task_projections(event_id);
  `)
  ensuredSubmissionSchema.add(db)
}

async function withSubmissionTransaction(db, fn) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction((tx) => fn(tx || db))
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = await fn(db)
    db.exec('COMMIT')
    return value
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* original error wins */ }
    throw error
  }
}

async function appendAuditEventTx(tx, attempt, {
  eventType,
  fromState = null,
  toState = null,
  details = {},
  createdAt = new Date(),
} = {}) {
  const cleanDetails = redactAuditValue(details)
  const previous = await tx.prepare(
    `SELECT event_hash, event_sequence FROM hamilton_submission_audit_events
      WHERE attempt_id = ? ORDER BY event_sequence DESC LIMIT 1`,
  ).get(attempt.id)
  const timestamp = nowIso(createdAt)
  const body = stableJson({
    attempt_id: attempt.id,
    task_id: attempt.task_id,
    profile_id: attempt.profile_id,
    user_id: attempt.user_id,
    from_state: fromState,
    to_state: toState,
    event_type: eventType,
    details: cleanDetails,
    created_at: timestamp,
  })
  const previousHash = previous?.event_hash || null
  const sequence = Number(previous?.event_sequence || 0) + 1
  const eventHash = sha256(`${previousHash || ''}\n${body}`)
  const id = crypto.randomUUID()
  await tx.prepare(
    `INSERT INTO hamilton_submission_audit_events
      (id, attempt_id, task_id, profile_id, user_id, from_state, to_state,
       event_type, event_sequence, details_json, previous_event_hash, event_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, attempt.id, attempt.task_id, attempt.profile_id, attempt.user_id,
    fromState, toState, eventType, sequence, JSON.stringify(cleanDetails), previousHash, eventHash, timestamp,
  )
  return { id, event_hash: eventHash }
}

function leaseExpiry(now, leaseMs) {
  const bounded = Math.max(10_000, Math.min(MAX_LEASE_MS, Number(leaseMs) || DEFAULT_LEASE_MS))
  return new Date(new Date(now).getTime() + bounded).toISOString()
}

function leaseIsLive(attempt, at = new Date()) {
  if (!attempt?.fence_token || !attempt?.lease_expires_at) return false
  const expires = Date.parse(attempt.lease_expires_at)
  return Number.isFinite(expires) && expires > new Date(at).getTime()
}

function reconciliationSchedule(now, attempts) {
  const count = Math.max(1, Number(attempts) || 1)
  const delayMs = Math.min(24 * 60 * 60_000, 60_000 * (2 ** Math.min(10, count - 1)))
  return {
    next_reconcile_at: new Date(new Date(now).getTime() + delayMs).toISOString(),
    manual_review_required: count >= 6,
  }
}

export async function createOrClaimSubmissionAttempt(db, {
  taskId,
  profileId,
  userId,
  fundingSourceId,
  authorizationTargetId = fundingSourceId,
  portalHost,
  targetUrl,
  executableTargetUrl = targetUrl,
  applicationIdentity,
  authorizationVersion,
  authorizationIds = [],
  consentSnapshot,
  answerSnapshotHash,
  answerProvenance = {},
  documentIds = [],
  submissionAdapter = null,
  evidenceRequired = { receipt_or_tracking_reference: true, independent_status_allowed: true },
  resumeHumanGate = false,
  mapTerminalReceiptToDuplicateTask = false,
  leaseOwner = 'hamilton-worker',
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const host = normalizePortalHost(portalHost || targetUrl)
  const ids = [...new Set((authorizationIds || []).map(String).filter(Boolean))].sort()
  const docs = [...new Set((documentIds || []).map(String).filter(Boolean))].sort()
  if (!authorizationVersion || !consentSnapshot || !answerSnapshotHash || !host || !targetUrl || !executableTargetUrl) {
    throw new Error('submission attempt requires versioned consent, frozen answers, and exact target')
  }
  const idempotencyKey = buildSubmissionAttemptIdempotencyKey({
    profileId, portalHost: host, applicationIdentity,
  })
  const consentHash = sha256(stableJson(consentSnapshot))
  const targetLocatorSha256 = sha256(String(executableTargetUrl))
  const storedTargetUrl = canonicalEvidencePortalUrl(executableTargetUrl, submissionAdapter)
  if (!storedTargetUrl) throw new Error('submission target must use https')
  const evidenceContract = {
    ...(evidenceRequired || {}),
    target_locator_sha256: targetLocatorSha256,
    submission_adapter: submissionAdapter ? {
      id: submissionAdapter.id,
      version: submissionAdapter.version,
      fixture_contract_sha256: submissionAdapter.fixture_contract_sha256,
    } : null,
  }
  const requestedPayloadHash = sha256(stableJson({
    action_type: ACTION_TYPE,
    profile_id: String(profileId),
    funding_source_id: String(fundingSourceId),
    authorization_target_id: String(authorizationTargetId),
    portal_host: host,
    target_url: storedTargetUrl,
    target_locator_sha256: targetLocatorSha256,
    application_identity: String(applicationIdentity),
    authorization_version: String(authorizationVersion),
    authorization_ids: ids,
    consent_snapshot_hash: consentHash,
    answer_snapshot_hash: String(answerSnapshotHash),
    document_ids: docs,
    submission_adapter: submissionAdapter || null,
  }))
  const timestamp = nowIso(now)
  const expiresAt = leaseExpiry(now, leaseMs)

  return withSubmissionTransaction(db, async (tx) => {
    const existingRow = await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE idempotency_key = ? LIMIT 1',
    ).get(idempotencyKey)
    if (existingRow) {
      const existing = assertAttemptIntegrity(rowToAttempt(existingRow))
      const immutableMatches = (
        existing.profile_id === String(profileId)
        && existing.user_id === String(userId)
        && existing.portal_host === host
        && existing.application_identity === String(applicationIdentity)
      )
      if (!immutableMatches) throw new Error('submission attempt identity collision')
      const snapshotMatches = existing.authorization_version === String(authorizationVersion)
        && existing.consent_snapshot_hash === consentHash
        && existing.answer_snapshot_hash === String(answerSnapshotHash)
        && existing.requested_payload_hash === requestedPayloadHash
      const associateTaskReference = async () => {
        const taskReferences = [...new Set([...(existing.task_references || []), String(taskId)])].sort()
        const taskScopes = {
          ...(existing.task_scopes || {}),
          [String(taskId)]: {
            funding_source_id: String(fundingSourceId),
            authorization_target_id: String(authorizationTargetId),
          },
        }
        if (stableJson(taskReferences) !== stableJson(existing.task_references || [])
            || stableJson(taskScopes) !== stableJson(existing.task_scopes || {})) {
          await tx.prepare(
            `UPDATE hamilton_submission_attempts
                SET task_references_json = ?, task_scopes_json = ?, updated_at = ?
              WHERE id = ?`,
          ).run(JSON.stringify(taskReferences), JSON.stringify(taskScopes), timestamp, existing.id)
          existing.task_references = taskReferences
          existing.task_scopes = taskScopes
        }
      }
      if (HAMILTON_TERMINAL_RECEIPT_STATES.includes(existing.state)) {
        const beforeReferences = [...existing.task_references]
        if (snapshotMatches || mapTerminalReceiptToDuplicateTask === true) await associateTaskReference()
        if (!beforeReferences.includes(String(taskId)) && existing.task_references.includes(String(taskId))) {
          const outbox = await tx.prepare(
            `SELECT id, payload_json FROM hamilton_submission_outbox
              WHERE attempt_id = ? AND event_type = 'external_receipt_verified' LIMIT 1`,
          ).get(existing.id)
          if (outbox) {
            const payload = safeJson(outbox.payload_json, {})
            payload.task_references = existing.task_references
            await tx.prepare(
              `UPDATE hamilton_submission_outbox
                  SET payload_json = ?, status = 'pending', processed_at = NULL,
                      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                      next_attempt_at = ?, updated_at = ?
                WHERE id = ?`,
            ).run(JSON.stringify(payload), timestamp, timestamp, outbox.id)
          }
          await appendAuditEventTx(tx, existing, {
            eventType: 'terminal_receipt_mapped_to_duplicate_task',
            fromState: existing.state,
            toState: existing.state,
            details: {
              task_reference: String(taskId),
              mapping_policy: mapTerminalReceiptToDuplicateTask === true
                ? 'canonical_external_identity_owner_match_v1'
                : 'exact_frozen_snapshot_match',
            },
            createdAt: now,
          })
        }
        return { attempt: existing, claimed: false, reason: 'already_received' }
      }
      if (!snapshotMatches) return { attempt: existing, claimed: false, reason: 'snapshot_changed' }
      await associateTaskReference()
      if (existing.state === HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED) {
        return { attempt: existing, claimed: false, reason: 'reconciliation_required' }
      }
      if (existing.state === HAMILTON_SUBMISSION_LIFECYCLE.CANCELLED) {
        return { attempt: existing, claimed: false, reason: 'cancelled' }
      }
      if (existing.state === HAMILTON_SUBMISSION_LIFECYCLE.FAILED) {
        return { attempt: existing, claimed: false, reason: 'failed_terminal' }
      }
      if (leaseIsLive(existing, now)) {
        return { attempt: existing, claimed: false, reason: 'active_lease' }
      }
      // Once a submit click may have happened, lease expiry is ambiguity—not
      // permission for another worker to click. Move to reconciliation while
      // holding the same transaction and permanently release the stale fence.
      if (existing.state === HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT) {
        await tx.prepare(
          `UPDATE hamilton_submission_attempts
              SET state = 'reconciliation_required', reconciliation_required_at = ?,
                  reconciliation_json = ?, next_reconcile_at = ?, lease_owner = NULL, fence_token = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(
          timestamp,
          JSON.stringify({ reason: 'submission_in_flight_lease_expired' }),
          timestamp,
          timestamp,
          existing.id,
        )
        const reconciled = rowToAttempt(await tx.prepare(
          'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
        ).get(existing.id))
        await appendAuditEventTx(tx, reconciled, {
          eventType: 'in_flight_lease_expired',
          fromState: existing.state,
          toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
          details: { prior_fence_generation: existing.fence_generation },
          createdAt: now,
        })
        return { attempt: reconciled, claimed: false, reason: 'reconciliation_required' }
      }
      if (existing.state === HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED) {
        if (resumeHumanGate !== true) return { attempt: existing, claimed: false, reason: 'human_action_required' }
      }
      const fenceToken = crypto.randomUUID()
      await tx.prepare(
        `UPDATE hamilton_submission_attempts
            SET lease_owner = ?, fence_token = ?, lease_expires_at = ?,
                fence_generation = fence_generation + 1, updated_at = ?
          WHERE id = ?`,
      ).run(String(leaseOwner), fenceToken, expiresAt, timestamp, existing.id)
      const claimed = rowToAttempt(await tx.prepare(
        'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
      ).get(existing.id))
      await appendAuditEventTx(tx, claimed, {
        eventType: 'lease_claimed',
        fromState: existing.state,
        toState: existing.state,
        details: {
          stale_lease_recovered: Boolean(existing.fence_token),
          lease_owner: leaseOwner,
          fence_generation: claimed.fence_generation,
          task_reference: String(taskId),
        },
        createdAt: now,
      })
      return { attempt: claimed, claimed: true, reason: 'stale_lease_recovered' }
    }

    const id = crypto.randomUUID()
    const fenceToken = crypto.randomUUID()
    const insertedStatement = tx.prepare(
      `INSERT INTO hamilton_submission_attempts
        (id, idempotency_key, task_id, task_references_json, task_scopes_json, profile_id, user_id, funding_source_id, authorization_target_id,
         portal_host, target_url, target_locator_ciphertext, target_locator_iv,
         target_locator_tag, target_locator_sha256, application_identity, authorization_version,
         authorization_ids_json, consent_snapshot_hash, answer_snapshot_hash,
         answer_provenance_json, document_ids_json, submission_adapter_json, action_type,
         requested_payload_hash, policy_version, implementation_version,
         attempt_number, fence_generation, evidence_required_json, state, lease_owner,
         fence_token, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    const encryptedTarget = encryptRuntimeSecret(String(executableTargetUrl))
    const inserted = await insertedStatement.run(
      id, idempotencyKey, String(taskId), JSON.stringify([String(taskId)]), JSON.stringify({
        [String(taskId)]: {
          funding_source_id: String(fundingSourceId),
          authorization_target_id: String(authorizationTargetId),
        },
      }), String(profileId), String(userId), String(fundingSourceId),
      String(authorizationTargetId), host, storedTargetUrl, encryptedTarget.value_ciphertext, encryptedTarget.iv,
      encryptedTarget.tag, targetLocatorSha256, String(applicationIdentity), String(authorizationVersion),
      JSON.stringify(ids), consentHash, String(answerSnapshotHash), JSON.stringify(answerProvenance || {}),
      JSON.stringify(docs), JSON.stringify(submissionAdapter || {}), ACTION_TYPE, requestedPayloadHash, IRREVERSIBLE_ACTION_CONTRACT_VERSION,
      IMPLEMENTATION_VERSION, 1, 1, JSON.stringify(evidenceContract),
      HAMILTON_SUBMISSION_LIFECYCLE.PREPARED, String(leaseOwner),
      fenceToken, expiresAt, timestamp, timestamp,
    )
    // A database without transaction serialization (or another process using a
    // separate SQLite connection) can win between our SELECT and INSERT.  The
    // UNIQUE key is the authority: converge on that winner instead of surfacing
    // a retryable uniqueness error or creating a second browser run.
    if (Number(inserted?.changes || 0) !== 1) {
      const winner = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
        'SELECT * FROM hamilton_submission_attempts WHERE idempotency_key = ? LIMIT 1',
      ).get(idempotencyKey)))
      if (!winner) throw new Error('submission_attempt_claim_race')
      const winnerMatches = winner.profile_id === String(profileId)
        && winner.user_id === String(userId)
        && winner.portal_host === host
        && winner.application_identity === String(applicationIdentity)
        && winner.authorization_version === String(authorizationVersion)
        && winner.consent_snapshot_hash === consentHash
        && winner.answer_snapshot_hash === String(answerSnapshotHash)
        && winner.requested_payload_hash === requestedPayloadHash
      if (!winnerMatches) return { attempt: winner, claimed: false, reason: 'snapshot_changed' }
      const taskReferences = [...new Set([...(winner.task_references || []), String(taskId)])].sort()
      const taskScopes = {
        ...(winner.task_scopes || {}),
        [String(taskId)]: {
          funding_source_id: String(fundingSourceId),
          authorization_target_id: String(authorizationTargetId),
        },
      }
      await tx.prepare(
        `UPDATE hamilton_submission_attempts SET task_references_json = ?, task_scopes_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(JSON.stringify(taskReferences), JSON.stringify(taskScopes), timestamp, winner.id)
      winner.task_references = taskReferences
      winner.task_scopes = taskScopes
      return { attempt: winner, claimed: false, reason: 'active_lease' }
    }
    const created = rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
    ).get(id))
    await appendAuditEventTx(tx, created, {
      eventType: 'attempt_created',
      toState: HAMILTON_SUBMISSION_LIFECYCLE.PREPARED,
      details: {
        authorization_version: authorizationVersion,
        authorization_ids: ids,
        consent_snapshot_hash: consentHash,
        answer_snapshot_hash: answerSnapshotHash,
        document_ids: docs,
        portal_host: host,
        application_identity: applicationIdentity,
        action_type: ACTION_TYPE,
        requested_payload_hash: requestedPayloadHash,
        policy_version: IRREVERSIBLE_ACTION_CONTRACT_VERSION,
        implementation_version: IMPLEMENTATION_VERSION,
        fence_generation: 1,
        submission_adapter: submissionAdapter ? {
          id: submissionAdapter.id,
          version: submissionAdapter.version,
          fixture_contract_sha256: submissionAdapter.fixture_contract_sha256,
        } : null,
      },
      createdAt: now,
    })
    return { attempt: created, claimed: true, reason: 'created' }
  })
}

/**
 * Replace frozen consent/answer/document/adapter snapshots only while no final
 * submission could have occurred. This is the explicit recovery path after a
 * user corrects missing information; it rotates the fence so every worker that
 * saw the old snapshot is rejected.
 */
export async function supersedeSubmissionAttemptSnapshots(db, {
  attemptId,
  taskId,
  profileId,
  userId,
  fundingSourceId,
  authorizationTargetId = fundingSourceId,
  portalHost,
  targetUrl,
  executableTargetUrl = targetUrl,
  applicationIdentity,
  authorizationVersion,
  authorizationIds = [],
  consentSnapshot,
  answerSnapshotHash,
  answerProvenance = {},
  documentIds = [],
  submissionAdapter = null,
  evidenceRequired = { receipt_or_tracking_reference: true, independent_status_allowed: true },
  leaseOwner = 'hamilton-worker',
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const host = normalizePortalHost(portalHost || targetUrl)
  if (!attemptId || !taskId || !profileId || !userId || !fundingSourceId || !host
      || !targetUrl || !executableTargetUrl || !applicationIdentity || !authorizationVersion
      || !consentSnapshot || !answerSnapshotHash) {
    throw new Error('complete supersede scope and frozen snapshots required')
  }
  const ids = [...new Set((authorizationIds || []).map(String).filter(Boolean))].sort()
  const docs = [...new Set((documentIds || []).map(String).filter(Boolean))].sort()
  const consentHash = sha256(stableJson(consentSnapshot))
  const targetLocatorSha256 = sha256(String(executableTargetUrl))
  const storedTargetUrl = canonicalEvidencePortalUrl(executableTargetUrl, submissionAdapter)
  if (!storedTargetUrl) throw new Error('submission target must use https')
  const encryptedTarget = encryptRuntimeSecret(String(executableTargetUrl))
  const evidenceContract = {
    ...(evidenceRequired || {}),
    target_locator_sha256: targetLocatorSha256,
    submission_adapter: submissionAdapter ? {
      id: submissionAdapter.id,
      version: submissionAdapter.version,
      fixture_contract_sha256: submissionAdapter.fixture_contract_sha256,
    } : null,
  }
  const requestedPayloadHash = sha256(stableJson({
    action_type: ACTION_TYPE,
    profile_id: String(profileId),
    funding_source_id: String(fundingSourceId),
    authorization_target_id: String(authorizationTargetId),
    portal_host: host,
    target_url: storedTargetUrl,
    target_locator_sha256: targetLocatorSha256,
    application_identity: String(applicationIdentity),
    authorization_version: String(authorizationVersion),
    authorization_ids: ids,
    consent_snapshot_hash: consentHash,
    answer_snapshot_hash: String(answerSnapshotHash),
    document_ids: docs,
    submission_adapter: submissionAdapter || null,
  }))
  const timestamp = nowIso(now)
  return withSubmissionTransaction(db, async (tx) => {
    const current = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!current) throw new Error('submission_attempt_not_found')
    if (current.profile_id !== String(profileId) || current.user_id !== String(userId)
        || current.funding_source_id !== String(fundingSourceId)
        || current.authorization_target_id !== String(authorizationTargetId)
        || current.portal_host !== host || current.application_identity !== String(applicationIdentity)) {
      throw new Error('submission_attempt_supersede_scope_mismatch')
    }
    const safeStates = new Set([
      HAMILTON_SUBMISSION_LIFECYCLE.PREPARED,
      HAMILTON_SUBMISSION_LIFECYCLE.PORTAL_DRAFT_SAVED,
      HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED,
    ])
    if (!safeStates.has(current.state) || current.submit_dispatched_at) {
      throw new Error(`submission_attempt_cannot_be_superseded_from_${current.state}`)
    }
    if (leaseIsLive(current, now)) throw new Error('submission_attempt_active_lease')
    const taskReferences = [...new Set([...(current.task_references || []), String(taskId)])].sort()
    const fenceToken = crypto.randomUUID()
    const updatedResult = await tx.prepare(
      `UPDATE hamilton_submission_attempts
          SET task_references_json = ?, authorization_version = ?, authorization_ids_json = ?,
              consent_snapshot_hash = ?, answer_snapshot_hash = ?, answer_provenance_json = ?,
              document_ids_json = ?, submission_adapter_json = ?, requested_payload_hash = ?,
              target_url = ?, target_locator_ciphertext = ?, target_locator_iv = ?,
              target_locator_tag = ?, target_locator_sha256 = ?,
              evidence_required_json = ?, attempt_number = attempt_number + 1,
              fence_generation = fence_generation + 1, state = 'prepared',
              human_action_kind = NULL, checkpoint_json = ?, reconciliation_json = ?,
              lease_owner = ?, fence_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('prepared','portal_draft_saved','human_action_required')
          AND submit_dispatched_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).run(
      JSON.stringify(taskReferences), String(authorizationVersion), JSON.stringify(ids),
      consentHash, String(answerSnapshotHash), JSON.stringify(answerProvenance || {}),
      JSON.stringify(docs), JSON.stringify(submissionAdapter || {}), requestedPayloadHash,
      storedTargetUrl, encryptedTarget.value_ciphertext, encryptedTarget.iv,
      encryptedTarget.tag, targetLocatorSha256,
      JSON.stringify(evidenceContract), JSON.stringify({}), JSON.stringify({}),
      String(leaseOwner), fenceToken, leaseExpiry(now, leaseMs), timestamp,
      current.id, timestamp,
    )
    if (Number(updatedResult?.changes ?? updatedResult?.rowCount ?? 0) !== 1) {
      throw new Error('submission_attempt_supersede_race')
    }
    const updated = rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(current.id))
    await appendAuditEventTx(tx, updated, {
      eventType: 'attempt_snapshots_superseded',
      fromState: current.state,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.PREPARED,
      details: {
        prior_consent_snapshot_hash: current.consent_snapshot_hash,
        consent_snapshot_hash: consentHash,
        prior_answer_snapshot_hash: current.answer_snapshot_hash,
        answer_snapshot_hash: String(answerSnapshotHash),
        prior_fence_generation: current.fence_generation,
        fence_generation: updated.fence_generation,
        task_reference: String(taskId),
      },
      createdAt: now,
    })
    return { attempt: updated, claimed: true, reason: 'snapshots_superseded' }
  })
}

export async function getSubmissionAttempt(db, attemptId) {
  if (!db || !attemptId) return null
  await ensureHamiltonSubmissionAttemptSchema(db)
  return rowToAttempt(await db.prepare(
    'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
  ).get(String(attemptId)))
}

export async function getSubmissionAttemptExecutableTarget(db, {
  attemptId,
  fenceToken,
  profileId,
  userId,
  taskId,
} = {}) {
  if (!db || !attemptId || !fenceToken || !profileId || !userId || !taskId) {
    throw new Error('scoped fenced executable target request required')
  }
  await ensureHamiltonSubmissionAttemptSchema(db)
  const row = await db.prepare(
    'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
  ).get(String(attemptId))
  const attempt = assertAttemptIntegrity(rowToAttempt(row))
  if (!attempt || attempt.fence_token !== String(fenceToken)
      || attempt.profile_id !== String(profileId) || attempt.user_id !== String(userId)
      || !attempt.task_references.includes(String(taskId))) {
    throw new Error('submission_attempt_executable_target_scope_mismatch')
  }
  const plaintext = decryptRuntimeSecret({
    value_ciphertext: row.target_locator_ciphertext,
    iv: row.target_locator_iv,
    tag: row.target_locator_tag,
  })
  if (sha256(plaintext) !== attempt.target_locator_sha256) throw new Error('submission_target_locator_hash_mismatch')
  let parsed
  try { parsed = new URL(plaintext) } catch { throw new Error('submission_target_locator_invalid') }
  if (parsed.protocol !== 'https:' || normalizePortalHost(parsed.hostname) !== attempt.portal_host) {
    throw new Error('submission_target_locator_portal_mismatch')
  }
  return plaintext
}

export async function assertSubmissionAttemptFence(db, {
  attemptId,
  fenceToken,
  fenceGeneration,
  taskId,
  profileId,
  userId,
  fundingSourceId,
  portalHost,
  at = new Date(),
} = {}) {
  const attempt = await getSubmissionAttempt(db, attemptId)
  if (!attempt) throw new Error('submission_attempt_not_found')
  assertAttemptIntegrity(attempt)
  const expected = {
    profile_id: profileId,
    user_id: userId,
    funding_source_id: fundingSourceId,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!value || attempt[key] !== String(value)) throw new Error(`submission_attempt_${key}_mismatch`)
  }
  if (!taskId || !attempt.task_references.includes(String(taskId))) {
    throw new Error('submission_attempt_task_reference_mismatch')
  }
  const host = normalizePortalHost(portalHost)
  if (!host || attempt.portal_host !== host) throw new Error('submission_attempt_portal_mismatch')
  if (!fenceToken || attempt.fence_token !== String(fenceToken)) throw new Error('submission_attempt_fenced')
  if (fenceGeneration !== undefined && attempt.fence_generation !== Number(fenceGeneration)) {
    throw new Error('submission_attempt_fenced')
  }
  if (!leaseIsLive(attempt, at)) throw new Error('submission_attempt_lease_expired')
  if ([
    HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
    HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED,
    HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_VALIDATED,
    HAMILTON_SUBMISSION_LIFECYCLE.CANCELLED,
    HAMILTON_SUBMISSION_LIFECYCLE.FAILED,
  ].includes(attempt.state)) throw new Error(`submission_attempt_${attempt.state}`)
  return attempt
}

export async function renewSubmissionAttemptLease(db, {
  attemptId,
  fenceToken,
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const current = assertAttemptIntegrity(await getSubmissionAttempt(db, attemptId))
  if (!current || current.fence_token !== String(fenceToken || '')) throw new Error('submission_attempt_fenced')
  const result = await db.prepare(
    `UPDATE hamilton_submission_attempts
        SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND fence_token = ?
        AND state NOT IN ('reconciliation_required','externally_received','externally_validated','cancelled','failed')`,
  ).run(leaseExpiry(now, leaseMs), nowIso(now), String(attemptId), String(fenceToken))
  if (Number(result?.changes || 0) !== 1) throw new Error('submission_attempt_fenced')
  return getSubmissionAttempt(db, attemptId)
}

/** Claim a reconciliation lease. This fence is read-only: the normal external
 * mutation guard rejects reconciliation_required, while receipt persistence
 * and observation recording explicitly accept it. */
export async function claimSubmissionReconciliation(db, {
  attemptId,
  taskId,
  profileId,
  userId,
  leaseOwner = 'hamilton-reconciler',
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  return withSubmissionTransaction(db, async (tx) => {
    const current = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!current) throw new Error('submission_attempt_not_found')
    if (current.state !== HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED) {
      return { attempt: current, claimed: false, reason: `state_${current.state}` }
    }
    if (current.profile_id !== String(profileId) || current.user_id !== String(userId)
        || !current.task_references.includes(String(taskId))) {
      throw new Error('submission_reconciliation_scope_mismatch')
    }
    if (leaseIsLive(current, now)) return { attempt: current, claimed: false, reason: 'active_lease' }
    if (current.next_reconcile_at && Date.parse(current.next_reconcile_at) > new Date(now).getTime()) {
      return { attempt: current, claimed: false, reason: 'not_due' }
    }
    const fenceToken = crypto.randomUUID()
    const timestamp = nowIso(now)
    const claimedResult = await tx.prepare(
      `UPDATE hamilton_submission_attempts
          SET lease_owner = ?, fence_token = ?, lease_expires_at = ?,
              fence_generation = fence_generation + 1,
              reconciliation_attempts = reconciliation_attempts + 1,
              next_reconcile_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'reconciliation_required'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)`,
    ).run(
      String(leaseOwner), fenceToken, leaseExpiry(now, leaseMs), timestamp,
      current.id, timestamp, timestamp,
    )
    if (Number(claimedResult?.changes ?? claimedResult?.rowCount ?? 0) !== 1) {
      return { attempt: await getSubmissionAttempt(tx, current.id), claimed: false, reason: 'claim_race' }
    }
    const claimed = rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
    ).get(current.id))
    await appendAuditEventTx(tx, claimed, {
      eventType: 'reconciliation_claimed',
      fromState: current.state,
      toState: current.state,
      details: { lease_owner: leaseOwner, fence_generation: claimed.fence_generation },
      createdAt: now,
    })
    return { attempt: claimed, claimed: true, reason: 'claimed' }
  })
}

export async function listSubmissionAttemptsNeedingReconciliation(db, { limit = 50, now = new Date() } = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50))
  const rows = await db.prepare(
    `SELECT * FROM hamilton_submission_attempts
      WHERE state = 'reconciliation_required'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
      ORDER BY COALESCE(next_reconcile_at, reconciliation_required_at, updated_at) ASC,
               reconciliation_attempts ASC, updated_at ASC LIMIT ?`,
  ).all(nowIso(now), nowIso(now), bounded)
  return (rows || []).map(rowToAttempt)
}

/**
 * Crash recovery for the irreversible dispatch window. A worker can commit the
 * durable SUBMISSION_IN_FLIGHT fence and then die before it records a receipt
 * or explicitly enters reconciliation. Once that lease expires, the only safe
 * recovery is reconciliation: never reclaim the attempt for another click.
 *
 * The conditional UPDATE is the cross-process authority. Concurrent sweepers
 * may select the same row, but only one can transition/audit it.
 */
export async function recoverExpiredSubmissionInflightAttempts(db, {
  limit = 100,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const timestamp = nowIso(now)
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100))
  return withSubmissionTransaction(db, async (tx) => {
    const rows = await tx.prepare(
      `SELECT * FROM hamilton_submission_attempts
        WHERE state = 'submission_in_flight'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY COALESCE(lease_expires_at, submit_dispatched_at, updated_at) ASC
        LIMIT ?`,
    ).all(timestamp, bounded)
    const recovered = []
    for (const row of rows || []) {
      const attempt = rowToAttempt(row)
      const reconciliation = {
        ...(attempt.reconciliation || {}),
        outcome: 'worker_crash_or_lease_expiry_after_dispatch',
        reason: 'submission_in_flight_lease_expired',
        no_retry: true,
        original_submit_dispatched_at: attempt.submit_dispatched_at || null,
        integrity_quarantined: attempt.integrity_valid !== true,
      }
      const result = await tx.prepare(
        `UPDATE hamilton_submission_attempts
            SET state = 'reconciliation_required', reconciliation_required_at = ?,
                reconciliation_json = ?, next_reconcile_at = ?,
                lease_owner = NULL, fence_token = NULL, lease_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND state = 'submission_in_flight'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).run(
        timestamp,
        JSON.stringify(reconciliation),
        timestamp,
        timestamp,
        attempt.id,
        timestamp,
      )
      if (Number(result?.changes ?? result?.rowCount ?? 0) !== 1) continue
      const updated = rowToAttempt(await tx.prepare(
        'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
      ).get(attempt.id))
      await appendAuditEventTx(tx, updated, {
        eventType: 'in_flight_worker_expired_to_reconciliation',
        fromState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT,
        toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
        details: {
          no_retry: true,
          submit_dispatched_at: attempt.submit_dispatched_at || null,
          prior_fence_generation: attempt.fence_generation,
          integrity_quarantined: attempt.integrity_valid !== true,
        },
        createdAt: now,
      })
      recovered.push(updated)
    }
    return recovered
  })
}

export async function releaseSubmissionReconciliationLease(db, {
  attemptId,
  fenceToken,
  fenceGeneration,
  reason = 'reconciliation_deferred',
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const timestamp = nowIso(now)
    const cleanReason = sha256(String(reason || 'reconciliation_deferred'))
  return withSubmissionTransaction(db, async (tx) => {
    const current = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!current || current.state !== HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED
        || current.fence_token !== String(fenceToken || '')
        || current.fence_generation !== Number(fenceGeneration)) {
      throw new Error('submission_attempt_fenced')
    }
    const schedule = reconciliationSchedule(now, current.reconciliation_attempts)
    const manualReviewAt = schedule.manual_review_required
      ? (current.manual_review_required_at || timestamp)
      : current.manual_review_required_at
    const reconciliation = {
      ...(current.reconciliation || {}),
      outcome: 'deferred',
      reason_sha256: cleanReason,
      retry_count: current.reconciliation_attempts,
      manual_review_required: schedule.manual_review_required,
    }
    await tx.prepare(
      `UPDATE hamilton_submission_attempts
          SET lease_owner = NULL, fence_token = NULL, lease_expires_at = NULL,
              reconciliation_json = ?, reconciliation_last_error = ?,
              next_reconcile_at = ?, manual_review_required_at = ?, updated_at = ?
        WHERE id = ? AND fence_token = ?`,
    ).run(
      JSON.stringify(reconciliation), cleanReason, schedule.next_reconcile_at,
      manualReviewAt, timestamp, current.id, String(fenceToken),
    )
    await appendAuditEventTx(tx, current, {
      eventType: 'reconciliation_deferred',
      fromState: current.state,
      toState: current.state,
      details: {
        reason_sha256: cleanReason,
        retry_count: current.reconciliation_attempts,
        next_reconcile_at: schedule.next_reconcile_at,
        manual_review_required: schedule.manual_review_required,
      },
      createdAt: now,
    })
    return getSubmissionAttempt(tx, current.id)
  })
}

const RECONCILIATION_SOURCES = new Set(['authenticated_portal', 'agency_api'])

export function buildReconciliationStatusArtifactHash(attempt, adapter, observation) {
  return sha256(stableJson({
    attempt_id: attempt.id,
    application_identity: attempt.application_identity,
    target_locator_sha256: attempt.target_locator_sha256,
    adapter_id: adapter.id,
    adapter_version: adapter.version,
    fixture_contract_sha256: adapter.fixture_contract_sha256,
    status_path_prefix_sha256: sha256(adapter.status_query?.path_prefix || ''),
    container_selector_sha256: sha256(adapter.status_query?.container_selector || ''),
    identity_selector_sha256: sha256(adapter.status_query?.identity_selector || ''),
    status_selector_sha256: sha256(adapter.status_query?.status_selector || ''),
    status_sha256: observation.status_observation?.status_sha256 || null,
    identity_sha256: observation.status_observation?.identity_sha256 || null,
    outcome: observation.outcome,
    checked_at: new Date(Date.parse(observation.checked_at)).toISOString(),
  }))
}

export function buildReconciliationResponseDigest(attempt, observation) {
  return sha256(stableJson({
    target_locator_sha256: attempt.target_locator_sha256,
    status_artifact_sha256: String(observation.status_artifact_sha256 || '').toLowerCase(),
    portal_correlation_id: observation.portal_correlation_id || null,
  }))
}

export function buildReconciliationResponseBinding(attempt, observation) {
  return sha256(stableJson({
    attempt_id: attempt.id,
    application_identity: attempt.application_identity,
    portal_host: attempt.portal_host,
    target_locator_sha256: attempt.target_locator_sha256,
    source: observation.source,
    query_kind: observation.query_kind,
    checked_at: new Date(Date.parse(observation.checked_at)).toISOString(),
    observation_id: observation.observation_id || null,
    portal_correlation_id: observation.portal_correlation_id || null,
    response_sha256: String(observation.response_sha256).toLowerCase(),
    status_artifact_sha256: String(observation.status_artifact_sha256 || '').toLowerCase(),
    outcome: String(observation.outcome),
  }))
}

export async function recordReconciliationObservation(db, {
  attemptId,
  fenceToken,
  fenceGeneration,
  observation,
  now = new Date(),
} = {}) {
  if (observation?.outcome === 'received') {
    await ensureHamiltonSubmissionAttemptSchema(db)
    const current = assertAttemptIntegrity(rowToAttempt(await db.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!current || current.state !== HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED
        || current.fence_token !== String(fenceToken || '')
        || current.fence_generation !== Number(fenceGeneration)) {
      throw new Error('submission_reconciliation_not_active')
    }
    if (!RECONCILIATION_SOURCES.has(observation?.source)) throw new Error('untrusted_reconciliation_source')
    const frozenAdapter = current.submission_adapter
    const currentPolicy = await getPolicyFor(db, current.portal_host)
    const currentAdapter = getReviewedSubmissionAdapter(currentPolicy, { portalUrl: current.target_url })
    if (!currentAdapter || !frozenAdapter
        || currentAdapter.id !== frozenAdapter.id
        || currentAdapter.version !== frozenAdapter.version
        || currentAdapter.fixture_contract_sha256 !== frozenAdapter.fixture_contract_sha256
        || currentAdapter.reconciliation_mode !== 'authenticated_exact_application_lookup_v1') {
      throw new Error('reviewed_reconciliation_adapter_required')
    }
    if (observation?.adapter_id !== frozenAdapter.id
        || observation?.adapter_version !== frozenAdapter.version
        || String(observation?.fixture_contract_sha256 || '').toLowerCase() !== frozenAdapter.fixture_contract_sha256) {
      throw new Error('reconciliation_adapter_mismatch')
    }
    const timeline = validateEvidenceTimeline({
      executedAt: current.submit_dispatched_at,
      capturedAt: observation.checked_at,
      now,
    })
    if (!timeline.ok) throw new Error(timeline.reason)
    if (observation.query_kind !== 'exact_application_status' || !observation.portal_url) {
      throw new Error('reconciliation_query_provenance_required')
    }
    if (normalizePortalHost(observation.portal_url) !== current.portal_host) throw new Error('reconciliation_portal_mismatch')
    if (String(observation.application_identity || '') !== current.application_identity) {
      throw new Error('reconciliation_application_identity_mismatch')
    }
    if (!validHexDigest(observation.response_sha256)) throw new Error('reconciliation_response_hash_required')
    if (!validHexDigest(observation.status_artifact_sha256)) throw new Error('reconciliation_status_artifact_hash_required')
    const expectedStatusArtifact = buildReconciliationStatusArtifactHash(current, frozenAdapter, observation)
    if (String(observation.status_artifact_sha256).toLowerCase() !== expectedStatusArtifact) {
      throw new Error('reconciliation_status_artifact_mismatch')
    }
    if (String(observation.response_sha256).toLowerCase() !== buildReconciliationResponseDigest(current, observation)) {
      throw new Error('reconciliation_response_digest_mismatch')
    }
    const expectedResponseBinding = buildReconciliationResponseBinding(current, observation)
    if (String(observation.response_binding_sha256 || '').toLowerCase() !== expectedResponseBinding) {
      throw new Error('reconciliation_response_binding_mismatch')
    }
    const independent = observation.proof?.independent_verification
    if (!independent
        || independent.outcome !== 'received'
        || independent.source !== observation.source
        || independent.query_kind !== observation.query_kind
        || independent.checked_at !== observation.checked_at
        || independent.observation_id !== observation.observation_id
        || (independent.portal_correlation_id || null) !== (observation.portal_correlation_id || null)
        || String(independent.response_sha256 || '').toLowerCase() !== String(observation.response_sha256).toLowerCase()
        || String(independent.status_artifact_sha256 || '').toLowerCase() !== String(observation.status_artifact_sha256).toLowerCase()
        || String(independent.response_binding_sha256 || '').toLowerCase() !== expectedResponseBinding
        || !validHexDigest(independent.status_artifact_sha256)) {
      throw new Error('reconciliation_receipt_proof_binding_required')
    }
    return recordExternalReceipt(db, {
      attemptId, fenceToken, fenceGeneration, proof: observation.proof, now,
    })
  }
  await ensureHamiltonSubmissionAttemptSchema(db)
  return withSubmissionTransaction(db, async (tx) => {
    const current = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!current || current.state !== HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED) {
      throw new Error('submission_reconciliation_not_active')
    }
    if (current.fence_token !== String(fenceToken || '')
        || current.fence_generation !== Number(fenceGeneration)) throw new Error('submission_attempt_fenced')
    const outcome = String(observation?.outcome || '')
    if (!['absent', 'inconclusive'].includes(outcome)) throw new Error('invalid_reconciliation_outcome')
    if (!RECONCILIATION_SOURCES.has(observation?.source)) throw new Error('untrusted_reconciliation_source')
    const currentPolicy = await getPolicyFor(tx, current.portal_host)
    const currentAdapter = getReviewedSubmissionAdapter(currentPolicy, { portalUrl: current.target_url })
    const frozenAdapter = current.submission_adapter
    if (!currentAdapter || !frozenAdapter
        || currentAdapter.id !== frozenAdapter.id
        || currentAdapter.version !== frozenAdapter.version
        || currentAdapter.fixture_contract_sha256 !== frozenAdapter.fixture_contract_sha256
        || currentAdapter.reconciliation_mode !== 'authenticated_exact_application_lookup_v1') {
      throw new Error('reviewed_reconciliation_adapter_required')
    }
    if (observation?.adapter_id !== frozenAdapter.id
        || observation?.adapter_version !== frozenAdapter.version
        || String(observation?.fixture_contract_sha256 || '').toLowerCase() !== frozenAdapter.fixture_contract_sha256) {
      throw new Error('reconciliation_adapter_mismatch')
    }
    const timeline = validateEvidenceTimeline({
      executedAt: current.submit_dispatched_at,
      capturedAt: observation.checked_at,
      now,
    })
    if (!timeline.ok) throw new Error(timeline.reason)
    if (observation.query_kind !== 'exact_application_status' || !observation.portal_url) {
      throw new Error('reconciliation_query_provenance_required')
    }
    if (normalizePortalHost(observation.portal_url) !== current.portal_host) throw new Error('reconciliation_portal_mismatch')
    if (String(observation.application_identity || '') !== current.application_identity) {
      throw new Error('reconciliation_application_identity_mismatch')
    }
    if (!validHexDigest(observation.response_sha256)) throw new Error('reconciliation_response_hash_required')
    if (!validHexDigest(observation.status_artifact_sha256)) throw new Error('reconciliation_status_artifact_hash_required')
    const expectedStatusArtifact = buildReconciliationStatusArtifactHash(current, frozenAdapter, observation)
    if (String(observation.status_artifact_sha256).toLowerCase() !== expectedStatusArtifact) {
      throw new Error('reconciliation_status_artifact_mismatch')
    }
    if (String(observation.response_sha256).toLowerCase() !== buildReconciliationResponseDigest(current, observation)) {
      throw new Error('reconciliation_response_digest_mismatch')
    }
    const expectedResponseBinding = buildReconciliationResponseBinding(current, observation)
    if (String(observation.response_binding_sha256 || '').toLowerCase() !== expectedResponseBinding) {
      throw new Error('reconciliation_response_binding_mismatch')
    }
    const cleanObservation = redactAuditValue({
      outcome,
      source: observation.source,
      checked_at: new Date(Date.parse(observation.checked_at)).toISOString(),
      query_kind: String(observation.query_kind).slice(0, 120),
      portal_url: canonicalEvidencePortalUrl(observation.portal_url, frozenAdapter),
      observation_id: observation.observation_id ? String(observation.observation_id).slice(0, 160) : null,
      portal_correlation_id: observation.portal_correlation_id
        ? String(observation.portal_correlation_id).slice(0, 160)
        : null,
      response_sha256: String(observation.response_sha256).toLowerCase(),
      status_artifact_sha256: String(observation.status_artifact_sha256).toLowerCase(),
      status_observation: {
        status_sha256: validHexDigest(observation.status_observation?.status_sha256)
          ? String(observation.status_observation.status_sha256).toLowerCase()
          : null,
        identity_sha256: validHexDigest(observation.status_observation?.identity_sha256)
          ? String(observation.status_observation.identity_sha256).toLowerCase()
          : null,
      },
      response_binding_sha256: expectedResponseBinding,
      adapter_id: frozenAdapter.id,
      adapter_version: frozenAdapter.version,
      fixture_contract_sha256: frozenAdapter.fixture_contract_sha256,
    })
    const timestamp = nowIso(now)
    if (outcome === 'inconclusive') {
      const schedule = reconciliationSchedule(now, current.reconciliation_attempts)
      await tx.prepare(
        `UPDATE hamilton_submission_attempts
            SET reconciliation_json = ?, lease_owner = NULL, fence_token = NULL,
                lease_expires_at = NULL, reconciliation_last_error = NULL,
                next_reconcile_at = ?, manual_review_required_at = ?, updated_at = ?
          WHERE id = ? AND fence_token = ?`,
      ).run(
        JSON.stringify({
          ...cleanObservation,
          retry_count: current.reconciliation_attempts,
          manual_review_required: schedule.manual_review_required,
        }),
        schedule.next_reconcile_at,
        schedule.manual_review_required ? (current.manual_review_required_at || timestamp) : current.manual_review_required_at,
        timestamp,
        current.id,
        String(fenceToken),
      )
      await appendAuditEventTx(tx, current, {
        eventType: 'reconciliation_inconclusive',
        fromState: current.state,
        toState: current.state,
        details: {
          ...cleanObservation,
          retry_count: current.reconciliation_attempts,
          next_reconcile_at: schedule.next_reconcile_at,
          manual_review_required: schedule.manual_review_required,
        },
        createdAt: now,
      })
      return { attempt: await getSubmissionAttempt(tx, current.id), retry_allowed: false, outcome }
    }
    if (!observation.observation_id) throw new Error('conclusive_absence_observation_id_required')
    // A browser-rendered "not found" is not strong enough to re-arm an
    // irreversible click. Portals can be eventually consistent, stale, or
    // partially rendered. Preserve the original dispatch timestamp and require
    // an explicit human final-review handoff; only a future official API/S2S
    // channel with external idempotency may define an automatic absence retry.
    const nextState = HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED
    const storedObservation = {
      ...cleanObservation,
      outcome: 'absence_observed_manual_review_required',
      retry_prohibited: true,
      no_retry: true,
      original_submit_dispatched_at: current.submit_dispatched_at,
      consent_revoked: current.reconciliation?.consent_revoked === true,
    }
    await tx.prepare(
      `UPDATE hamilton_submission_attempts
          SET state = ?, reconciliation_json = ?,
              human_action_kind = 'final_review_submit',
              lease_owner = NULL, fence_token = NULL, lease_expires_at = NULL,
              next_reconcile_at = NULL,
              manual_review_required_at = COALESCE(manual_review_required_at, ?),
              updated_at = ?
        WHERE id = ? AND fence_token = ?`,
    ).run(
      nextState,
      JSON.stringify(storedObservation),
      timestamp,
      timestamp,
      current.id,
      String(fenceToken),
    )
    const updated = rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
    ).get(current.id))
    await appendAuditEventTx(tx, updated, {
      eventType: 'browser_absence_observed_manual_review_required',
      fromState: current.state,
      toState: nextState,
      details: storedObservation,
      createdAt: now,
    })
    return { attempt: updated, retry_allowed: false, outcome: 'absence_observed' }
  })
}

const ALLOWED_TRANSITIONS = Object.freeze({
  prepared: new Set(['portal_draft_saved', 'human_action_required', 'ready_for_final_submit', 'cancelled', 'failed']),
  portal_draft_saved: new Set(['human_action_required', 'ready_for_final_submit', 'cancelled', 'failed']),
  human_action_required: new Set(['human_action_required', 'portal_draft_saved', 'ready_for_final_submit', 'cancelled', 'failed']),
  ready_for_final_submit: new Set(['submission_in_flight', 'human_action_required', 'portal_draft_saved', 'cancelled', 'failed']),
  submission_in_flight: new Set(['reconciliation_required', 'externally_received']),
  reconciliation_required: new Set(['externally_received', 'human_action_required', 'cancelled']),
  externally_received: new Set(['externally_validated']),
  externally_validated: new Set(),
  cancelled: new Set(),
  failed: new Set(),
})

export async function transitionSubmissionAttempt(db, {
  attemptId,
  fenceToken,
  toState,
  eventType = 'state_transition',
  details = {},
  humanActionKind = null,
  checkpoint = undefined,
  proof = undefined,
  now = new Date(),
  releaseLease = false,
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  return withSubmissionTransaction(db, async (tx) => {
    const current = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!current) throw new Error('submission_attempt_not_found')
    if (!fenceToken || current.fence_token !== String(fenceToken)) throw new Error('submission_attempt_fenced')
    if (!ALLOWED_TRANSITIONS[current.state]?.has(toState)) {
      throw new Error(`invalid_submission_transition:${current.state}->${toState}`)
    }
    if (toState === HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED) {
      if (!HAMILTON_HUMAN_ACTION_KINDS.includes(humanActionKind)) throw new Error('human_action_kind_required')
    } else if (humanActionKind) {
      throw new Error('human_action_kind_only_valid_for_handoff')
    }
    const timestamp = nowIso(now)
    const sets = ['state = ?', 'human_action_kind = ?', 'updated_at = ?']
    const params = [toState, humanActionKind, timestamp]
    if (checkpoint !== undefined) { sets.push('checkpoint_json = ?'); params.push(JSON.stringify(checkpoint || {})) }
    if (proof !== undefined) { sets.push('proof_json = ?'); params.push(JSON.stringify(proof || {})) }
    if (toState === HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT) {
      sets.push('submit_dispatched_at = ?'); params.push(timestamp)
    }
    if (toState === HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED) {
      sets.push('reconciliation_required_at = ?'); params.push(timestamp)
      sets.push('next_reconcile_at = ?'); params.push(timestamp)
    }
    if (toState === HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED) {
      sets.push('external_received_at = ?'); params.push(timestamp)
    }
    if (toState === HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_VALIDATED) {
      sets.push('external_validated_at = ?'); params.push(timestamp)
    }
    if (releaseLease) {
      sets.push('lease_owner = NULL', 'fence_token = NULL', 'lease_expires_at = NULL')
    }
    params.push(current.id, String(fenceToken))
    const result = await tx.prepare(
      `UPDATE hamilton_submission_attempts SET ${sets.join(', ')}
        WHERE id = ? AND fence_token = ?`,
    ).run(...params)
    if (Number(result?.changes || 0) !== 1) throw new Error('submission_attempt_fenced')
    const updated = rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
    ).get(current.id))
    await appendAuditEventTx(tx, updated, {
      eventType,
      fromState: current.state,
      toState,
      details: { ...details, human_action_kind: humanActionKind, checkpoint: checkpoint || undefined },
      createdAt: now,
    })
    return updated
  })
}

export async function cancelSubmissionAttemptsForAuthorization(db, {
  authorizationId,
  profileId,
  userId,
  reason = 'authorization_revoked',
  now = new Date(),
} = {}) {
  if (!authorizationId || !profileId || !userId) throw new Error('authorization cancellation scope required')
  await ensureHamiltonSubmissionAttemptSchema(db)
  const timestamp = nowIso(now)
  return withSubmissionTransaction(db, async (tx) => {
    const rows = await tx.prepare(
      `SELECT * FROM hamilton_submission_attempts
        WHERE profile_id = ? AND user_id = ?
          AND state NOT IN ('externally_received','externally_validated','cancelled','failed')`,
    ).all(String(profileId), String(userId))
    const affected = []
    for (const row of rows || []) {
      const attempt = rowToAttempt(row)
      if (!attempt.integrity_valid) {
        // A malformed authorization snapshot cannot safely prove that this
        // revocation does or does not apply. Fence the worker and preserve the
        // possibility of an external dispatch for operator reconciliation.
        await tx.prepare(
          `UPDATE hamilton_submission_attempts
              SET state = 'reconciliation_required', reconciliation_required_at = ?,
                  reconciliation_json = ?, next_reconcile_at = ?,
                  lease_owner = NULL, fence_token = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(
          timestamp,
          JSON.stringify({
            outcome: 'integrity_quarantined',
            no_retry: true,
            consent_revoked: true,
            reason: 'malformed_immutable_attempt_fields',
            integrity_fields: attempt.integrity_errors,
          }),
          timestamp,
          timestamp,
          attempt.id,
        )
        await appendAuditEventTx(tx, attempt, {
          eventType: 'attempt_integrity_quarantined',
          fromState: attempt.state,
          toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
          details: { integrity_fields: attempt.integrity_errors },
          createdAt: now,
        })
        affected.push(attempt.id)
        continue
      }
      if (!attempt.authorization_ids.includes(String(authorizationId))) continue
      const dispatchedOrAmbiguous = [
        HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT,
        HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
      ].includes(attempt.state) || Boolean(attempt.submit_dispatched_at)
      const nextState = dispatchedOrAmbiguous
        ? HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED
        : HAMILTON_SUBMISSION_LIFECYCLE.CANCELLED
      const reconciliation = dispatchedOrAmbiguous ? {
        ...(attempt.reconciliation || {}),
        outcome: 'authorization_revoked_pending_reconciliation',
        consent_revoked: true,
        no_retry: true,
        revoked_authorization_id: String(authorizationId),
      } : attempt.reconciliation
      await tx.prepare(
        `UPDATE hamilton_submission_attempts
            SET state = ?, cancelled_reason = ?, reconciliation_required_at = ?,
                reconciliation_json = ?, next_reconcile_at = ?,
                lease_owner = NULL, fence_token = NULL,
                lease_expires_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(
        nextState,
        dispatchedOrAmbiguous ? null : String(reason).slice(0, 500),
        dispatchedOrAmbiguous ? (attempt.reconciliation_required_at || timestamp) : null,
        JSON.stringify(reconciliation || {}),
        dispatchedOrAmbiguous ? timestamp : null,
        timestamp,
        attempt.id,
      )
      await appendAuditEventTx(tx, attempt, {
        eventType: dispatchedOrAmbiguous
          ? 'authorization_revoked_reconciliation_preserved'
          : 'authorization_revoked',
        fromState: attempt.state,
        toState: nextState,
        details: {
          authorization_id: authorizationId,
          reason,
          possible_external_dispatch_preserved: dispatchedOrAmbiguous,
          retry_prohibited: dispatchedOrAmbiguous,
        },
        createdAt: now,
      })
      affected.push(attempt.id)
    }
    return affected
  })
}

function validHexDigest(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''))
}

function validReference(value) {
  const normalized = String(value || '').trim()
  return normalized.length >= 6 && normalized.length <= 160 && /[a-z]/i.test(normalized) && /\d/.test(normalized)
}

const EXTERNAL_REFERENCE_KINDS = new Set(['confirmation', 'receipt', 'tracking', 'submission'])

/**
 * Validate typed, source-proven external receipt evidence.  This function is
 * pure so fixture portals and reconciliation adapters share the same boundary.
 */
export function assessExternalReceiptProof(attempt, proof, { now = new Date() } = {}) {
  const fail = (reason) => ({ verified: false, reason, normalized: null })
  if (!attempt || !proof || typeof proof !== 'object') return fail('missing_proof')
  if (!SAFE_PROOF_TYPES.has(proof.evidence_type)) return fail('unsupported_evidence_type')
  if (!SAFE_PROOF_SOURCES.has(proof.source)) return fail('untrusted_proof_source')
  const bindings = {
    attempt_id: attempt.id,
    profile_id: attempt.profile_id,
    user_id: attempt.user_id,
    funding_source_id: attempt.funding_source_id,
    application_identity: attempt.application_identity,
    target_locator_sha256: attempt.target_locator_sha256,
  }
  for (const [key, value] of Object.entries(bindings)) {
    if (!proof[key] || String(proof[key]) !== String(value)) return fail(`proof_${key}_mismatch`)
  }
  if (!proof.task_id || !attempt.task_references.includes(String(proof.task_id))) return fail('proof_task_id_mismatch')
  const portalHost = normalizePortalHost(proof.portal_url)
  if (!portalHost || portalHost !== attempt.portal_host) return fail('proof_portal_mismatch')
  if (!/^https:\/\//i.test(String(proof.portal_url || ''))) return fail('proof_url_must_be_https')
  const timeline = validateEvidenceTimeline({
    executedAt: attempt.submit_dispatched_at,
    capturedAt: proof.captured_at,
    checkedAt: proof.independent_verification?.checked_at || null,
    now,
  })
  if (!timeline.ok) return fail(timeline.reason)
  const capturedAt = Date.parse(proof.captured_at)
  if (!proof.extraction_rule || !proof.portal_policy_version) return fail('missing_proof_provenance')

  const adapter = attempt.submission_adapter
  if (!adapter?.id || !adapter?.version || !validHexDigest(adapter?.fixture_contract_sha256)) {
    return fail('attempt_has_no_reviewed_submission_adapter')
  }
  const evidenceAdapter = attempt.evidence_required?.submission_adapter
  if (attempt.evidence_required?.target_locator_sha256 !== attempt.target_locator_sha256
      || evidenceAdapter?.id !== adapter.id
      || evidenceAdapter?.version !== adapter.version
      || String(evidenceAdapter?.fixture_contract_sha256 || '').toLowerCase()
        !== String(adapter.fixture_contract_sha256).toLowerCase()) {
    return fail('attempt_evidence_contract_mismatch')
  }
  const proofAdapter = proof.portal_adapter
  if (!proofAdapter
      || String(proofAdapter.id) !== String(adapter.id)
      || String(proofAdapter.version) !== String(adapter.version)
      || String(proofAdapter.fixture_contract_sha256).toLowerCase() !== String(adapter.fixture_contract_sha256).toLowerCase()) {
    return fail('proof_adapter_mismatch')
  }
  const expectedPolicyVersion = `${adapter.id}@${adapter.version}:${String(adapter.fixture_contract_sha256).toLowerCase()}`
  if (String(proof.portal_policy_version) !== expectedPolicyVersion) return fail('proof_policy_version_mismatch')

  const hasReference = validReference(proof.confirmation_reference)
  const expectedArtifactBindingHash = sha256(stableJson({
    attempt_id: attempt.id,
    task_id: String(proof.task_id),
    profile_id: attempt.profile_id,
    funding_source_id: attempt.funding_source_id,
    application_identity: attempt.application_identity,
    portal_host: attempt.portal_host,
    target_locator_sha256: attempt.target_locator_sha256,
    artifact_sha256: proof.artifact_sha256 || null,
    confirmation_reference: proof.confirmation_reference || null,
  }))
  const claimedDurableArtifact = Boolean(proof.proof_document_id)
    && validHexDigest(proof.artifact_sha256)
    && validHexDigest(proof.artifact_manifest_sha256)
    && String(proof.artifact_binding_sha256 || '').toLowerCase() === expectedArtifactBindingHash
  // Artifact-only confirmation is deliberately disabled until the proof store
  // can load owner/profile-scoped bytes and transactionally verify their hash,
  // manifest, type, retention state, and retrievability. Syntactically valid
  // IDs/hashes are not evidence.
  const hasDurableArtifact = false
  const independent = proof.independent_verification
  const independentObservation = independent ? {
    outcome: independent.outcome,
    source: independent.source,
    query_kind: independent.query_kind,
    checked_at: independent.checked_at,
    observation_id: independent.observation_id || null,
    portal_correlation_id: independent.portal_correlation_id || null,
    response_sha256: independent.response_sha256,
    status_artifact_sha256: independent.status_artifact_sha256,
  } : null
  const expectedIndependentBinding = independentObservation
    ? buildReconciliationResponseBinding(attempt, independentObservation)
    : null
  const independentlyVerified = proof.independent_verification?.outcome === 'received'
    && ['authenticated_portal', 'agency_api'].includes(proof.independent_verification?.source)
    && proof.independent_verification?.query_kind === 'exact_application_status'
    && Boolean(proof.independent_verification?.checked_at)
    && validHexDigest(proof.independent_verification?.response_sha256)
    && validHexDigest(proof.independent_verification?.status_artifact_sha256)
    && String(proof.independent_verification?.response_binding_sha256 || '').toLowerCase()
      === expectedIndependentBinding
  if (!hasReference && !hasDurableArtifact && !independentlyVerified) {
    return fail(claimedDurableArtifact ? 'durable_artifact_verification_unavailable' : 'no_durable_external_receipt')
  }

  if (hasReference) {
    if (!EXTERNAL_REFERENCE_KINDS.has(String(proof.reference_kind || '').toLowerCase())) {
      return fail('untrusted_reference_kind')
    }
    if (String(proof.reference_kind).toLowerCase() === 'application') return fail('draft_application_id_not_receipt')
    if (proof.pre_click_reference && String(proof.pre_click_reference).trim() === String(proof.confirmation_reference).trim()) {
      return fail('reference_existed_before_submit')
    }
  }

  // Unknown/generic portal extraction is accepted only when a new, explicitly
  // receipt-like reference appears with receipt acknowledgement after the
  // click. A route change, Application ID, or unchanged SPA page is ambiguous.
  if (proof.source === 'portal_response' && !hasDurableArtifact) {
    if (!hasReference || proof.received_acknowledgement !== true) return fail('receipt_acknowledgement_required')
    if (!validHexDigest(proof.pre_click_page_fingerprint) || !validHexDigest(proof.post_click_page_fingerprint)) {
      return fail('page_change_provenance_required')
    }
    if (proof.pre_click_page_fingerprint === proof.post_click_page_fingerprint) return fail('unchanged_portal_state')
  }

  if (attempt.portal_host === 'grants.gov' || attempt.portal_host.endsWith('.grants.gov')) {
    const grantsTracking = proof.evidence_type === 'portal_tracking_number'
      && /grants?\.gov tracking number/i.test(String(proof.extraction_rule || ''))
      && hasReference
    if (!grantsTracking && !hasDurableArtifact && !independentlyVerified) {
      return fail('grants_gov_tracking_or_confirmation_required')
    }
  }

  const storedPortalUrl = canonicalEvidencePortalUrl(proof.portal_url, attempt.submission_adapter)
  if (!storedPortalUrl) return fail('proof_url_must_be_https')
  const normalized = {
    ...proof,
    portal_url: storedPortalUrl,
    captured_at: new Date(capturedAt).toISOString(),
    confirmation_reference: hasReference ? String(proof.confirmation_reference).trim() : null,
    proof_policy_version: PROOF_POLICY_VERSION,
  }
  return { verified: true, reason: null, normalized }
}

export async function recordExternalReceipt(db, {
  attemptId,
  fenceToken,
  fenceGeneration,
  proof,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  return withSubmissionTransaction(db, async (tx) => {
    const attempt = assertAttemptIntegrity(rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ? LIMIT 1',
    ).get(String(attemptId))))
    if (!attempt || attempt.fence_token !== String(fenceToken || '')) throw new Error('submission_attempt_fenced')
    if (fenceGeneration !== undefined && attempt.fence_generation !== Number(fenceGeneration)) {
      throw new Error('submission_attempt_fenced')
    }
    if (![HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT, HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED].includes(attempt.state)) {
      throw new Error(`receipt_not_allowed_from_${attempt.state}`)
    }
    const currentPolicy = await getPolicyFor(tx, attempt.portal_host)
    const currentAdapter = getReviewedSubmissionAdapter(currentPolicy, { portalUrl: attempt.target_url })
    if (!currentAdapter
        || currentAdapter.id !== attempt.submission_adapter?.id
        || currentAdapter.version !== attempt.submission_adapter?.version
        || currentAdapter.fixture_contract_sha256 !== attempt.submission_adapter?.fixture_contract_sha256) {
      return { attempt, recorded: false, reason: 'submission_adapter_changed_or_disabled' }
    }
    const assessment = assessExternalReceiptProof(attempt, proof, { now })
    if (!assessment.verified) return { attempt, recorded: false, reason: assessment.reason }
    const timestamp = nowIso(now)
    const updatedResult = await tx.prepare(
      `UPDATE hamilton_submission_attempts
          SET state = 'externally_received', proof_json = ?, external_received_at = ?,
              lease_owner = NULL, fence_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND fence_token = ?`,
    ).run(JSON.stringify(assessment.normalized), timestamp, timestamp, attempt.id, String(fenceToken))
    if (Number(updatedResult?.changes || 0) !== 1) throw new Error('submission_attempt_fenced')
    const updated = rowToAttempt(await tx.prepare(
      'SELECT * FROM hamilton_submission_attempts WHERE id = ?',
    ).get(attempt.id))
    const proofSummary = {
      evidence_type: assessment.normalized.evidence_type,
      source: assessment.normalized.source,
      portal_url: assessment.normalized.portal_url,
      confirmation_reference: assessment.normalized.confirmation_reference,
      proof_document_id: assessment.normalized.proof_document_id || null,
      artifact_sha256: assessment.normalized.artifact_sha256 || null,
      artifact_manifest_sha256: assessment.normalized.artifact_manifest_sha256 || null,
      extraction_rule: assessment.normalized.extraction_rule,
      portal_policy_version: assessment.normalized.portal_policy_version,
    }
    await appendAuditEventTx(tx, updated, {
      eventType: 'external_receipt_verified',
      fromState: attempt.state,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.EXTERNALLY_RECEIVED,
      details: proofSummary,
      createdAt: now,
    })
    const outboxId = crypto.randomUUID()
    await tx.prepare(
      `INSERT INTO hamilton_submission_outbox
        (id, attempt_id, event_type, payload_json, status, delivery_attempts,
         next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'external_receipt_verified', ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(attempt_id, event_type) DO NOTHING`,
    ).run(outboxId, attempt.id, JSON.stringify({
      attempt_id: attempt.id,
      task_references: attempt.task_references,
      profile_id: attempt.profile_id,
      user_id: attempt.user_id,
      funding_source_id: attempt.funding_source_id,
      proof: proofSummary,
    }), timestamp, timestamp, timestamp)
    return { attempt: updated, recorded: true, reason: null, outbox_event_id: outboxId }
  })
}

export async function listPendingSubmissionOutbox(db, { attemptId = null, limit = 100 } = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = attemptId
    ? await db.prepare(
      `SELECT * FROM hamilton_submission_outbox
        WHERE attempt_id = ? AND status IN ('pending','processing') ORDER BY created_at LIMIT ?`,
    ).all(String(attemptId), bounded)
    : await db.prepare(
      `SELECT * FROM hamilton_submission_outbox
        WHERE status IN ('pending','processing') ORDER BY created_at LIMIT ?`,
    ).all(bounded)
  return (rows || []).map((row) => ({ ...row, payload: safeJson(row.payload_json, {}) }))
}

export async function claimSubmissionOutbox(db, {
  attemptId = null,
  leaseOwner = 'hamilton-receipt-projector',
  leaseMs = 60_000,
  now = new Date(),
} = {}) {
  await ensureHamiltonSubmissionAttemptSchema(db)
  const timestamp = nowIso(now)
  const expiresAt = leaseExpiry(now, leaseMs)
  return withSubmissionTransaction(db, async (tx) => {
    const scopeSql = attemptId ? 'AND attempt_id = ?' : ''
    const selectParams = attemptId
      ? [timestamp, timestamp, String(attemptId)]
      : [timestamp, timestamp]
    const candidate = await tx.prepare(
      `SELECT * FROM hamilton_submission_outbox
        WHERE (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        ) ${scopeSql}
        ORDER BY created_at ASC LIMIT 1`,
    ).get(...selectParams)
    if (!candidate) return null
    const leaseToken = crypto.randomUUID()
    const updateParams = [
      String(leaseOwner), leaseToken, expiresAt, timestamp, candidate.id,
      timestamp, timestamp,
    ]
    const result = await tx.prepare(
      `UPDATE hamilton_submission_outbox
          SET status = 'processing', lease_owner = ?, lease_token = ?,
              lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND (
          (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`,
    ).run(...updateParams)
    const changed = Number(result?.changes ?? result?.rowCount ?? 0)
    if (changed !== 1) return null
    const claimed = await tx.prepare(
      'SELECT * FROM hamilton_submission_outbox WHERE id = ? LIMIT 1',
    ).get(candidate.id)
    return claimed ? { ...claimed, payload: safeJson(claimed.payload_json, {}) } : null
  })
}

export async function markSubmissionOutboxDelivered(db, {
  outboxEventId,
  leaseToken,
  now = new Date(),
} = {}) {
  if (!outboxEventId || !leaseToken) throw new Error('outboxEventId and leaseToken required')
  await ensureHamiltonSubmissionAttemptSchema(db)
  const timestamp = nowIso(now)
  const result = await db.prepare(
      `UPDATE hamilton_submission_outbox
        SET status = 'processed', delivery_attempts = delivery_attempts + 1,
            processed_at = ?, updated_at = ?, last_error = NULL,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'processing' AND lease_token = ?`,
  ).run(timestamp, timestamp, String(outboxEventId), String(leaseToken))
  return Number(result?.changes ?? result?.rowCount ?? 0) === 1
}

export async function recordSubmissionOutboxFailure(db, {
  outboxEventId,
  leaseToken,
  error,
  now = new Date(),
} = {}) {
  if (!outboxEventId || !leaseToken) return false
  await ensureHamiltonSubmissionAttemptSchema(db)
  const timestamp = nowIso(now)
  const row = await db.prepare(
    `SELECT delivery_attempts FROM hamilton_submission_outbox
      WHERE id = ? AND status = 'processing' AND lease_token = ? LIMIT 1`,
  ).get(String(outboxEventId), String(leaseToken))
  if (!row) return false
  const attempts = Number(row.delivery_attempts || 0) + 1
  const delayMs = Math.min(15 * 60_000, 1_000 * (2 ** Math.min(8, Math.max(0, attempts - 1))))
  const nextAttemptAt = new Date(new Date(now).getTime() + delayMs).toISOString()
  const result = await db.prepare(
    `UPDATE hamilton_submission_outbox
        SET status = 'pending', delivery_attempts = delivery_attempts + 1,
            last_error = ?, next_attempt_at = ?, updated_at = ?,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'processing' AND lease_token = ?`,
  ).run(
    String(error || 'projection_failed').slice(0, 500), nextAttemptAt, timestamp,
    String(outboxEventId), String(leaseToken),
  )
  return Number(result?.changes ?? result?.rowCount ?? 0) === 1
}

export async function listSubmissionAuditEvents(db, { attemptId } = {}) {
  if (!attemptId) return []
  await ensureHamiltonSubmissionAttemptSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM hamilton_submission_audit_events
      WHERE attempt_id = ? ORDER BY event_sequence ASC`,
  ).all(String(attemptId))
  return (rows || []).map((row) => ({ ...row, details: safeJson(row.details_json, {}) }))
}

export const _internal = Object.freeze({
  PROOF_POLICY_VERSION,
  normalizePortalHost,
  canonicalEvidencePortalUrl,
  stableJson,
  sha256,
  leaseIsLive,
  redactAuditValue,
  ALLOWED_TRANSITIONS,
})
