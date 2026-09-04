import { isPointerOpportunityRow } from '../config/linkLifecycleKinds.js'

export const LINK_PROOF_MAX_AGE_DAYS = 30
export const SUCCESSFUL_LINK_STATUSES = Object.freeze(['ok', 'redirect', 'verified'])

const SUCCESS = new Set(SUCCESSFUL_LINK_STATUSES)
const UNKNOWN = new Set(['', 'unknown', 'unverified'])

function text(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizedStatus(row = {}) {
  return text(row.link_status).toLowerCase()
}

function timestampMs(row = {}) {
  const parsed = Date.parse(text(row.last_verified_at))
  return Number.isFinite(parsed) ? parsed : null
}

export function effectiveLinkVerificationTarget(row = {}) {
  return text(row.application_url) || text(row.source_url) || null
}

export function hasCurrentSuccessfulLinkProof(row = {}, nowMs = Date.now()) {
  if (!SUCCESS.has(normalizedStatus(row))) return false
  const verifiedAt = timestampMs(row)
  if (verifiedAt === null) return false
  const maxAgeMs = LINK_PROOF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  return verifiedAt >= nowMs - maxAgeMs && verifiedAt <= nowMs + 5 * 60 * 1000
}

export function hasFreshLinkVerificationVerdict(row = {}, nowMs = Date.now()) {
  const status = normalizedStatus(row)
  if (UNKNOWN.has(status)) return false
  const verifiedAt = timestampMs(row)
  if (verifiedAt === null) return false
  const maxAgeMs = LINK_PROOF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  return verifiedAt >= nowMs - maxAgeMs && verifiedAt <= nowMs + 5 * 60 * 1000
}

function sameTarget(a, b) {
  return effectiveLinkVerificationTarget(a) === effectiveLinkVerificationTarget(b)
}

// A successful proof can only be accepted for a CHANGED target when:
// - it is fresh AND successful (checked by caller), AND
// - the proof's final_url matches the new effective target, AND
// - the proof timestamp is strictly newer than any prior proof on the row.
function successProofMatchesNewTarget(incoming = {}, currentRow = {}, beforeRow = null) {
  const newTarget = effectiveLinkVerificationTarget(currentRow)
  const finalUrl = text(incoming.final_url)
  const verifiedAt = timestampMs(incoming)
  const beforeVerifiedAt = beforeRow ? timestampMs(beforeRow) : null
  const newerThanBefore = beforeVerifiedAt === null ? verifiedAt !== null : (verifiedAt !== null && verifiedAt > beforeVerifiedAt)
  return Boolean(newTarget) && finalUrl === newTarget && newerThanBefore
}

function proofFields(row = {}) {
  return {
    last_verified_at: row.last_verified_at ?? null,
    link_status: row.link_status ?? 'unverified',
    link_status_code: row.link_status_code ?? null,
    verification_method: row.verification_method ?? null,
    verified_by: row.verified_by ?? null,
    verification_error: row.verification_error ?? null,
    final_url: row.final_url ?? null,
    http_status: row.http_status ?? null,
  }
}

/**
 * Resolve the link-proof state after a catalog writer has persisted its normal
 * business fields. This is intentionally independent of any one writer: the
 * inserter, Crawler OS persistence, and admin opportunity routes all call the
 * repository projection hook that invokes this guard.
 *
 * Rules:
 * - pointers/resources are outside direct-link proof and are left alone;
 * - a changed effective target cannot inherit proof from the old target;
 * - a same-target recrawl that did not perform a new probe preserves a still-
 *   current successful proof instead of downgrading it to "unverified";
 * - a fresh negative verdict wins over historical success and quarantines;
 * - every direct row without current successful proof is hidden fail-closed.
 */
export function resolveOpportunityLinkProofState({
  beforeRow = null,
  currentRow = null,
  input = null,
  nowMs = Date.now(),
} = {}) {
  if (!currentRow || typeof currentRow !== 'object') {
    return { action: 'none', reason: 'missing_current_row', updates: null }
  }
  if (isPointerOpportunityRow(currentRow)) {
    return { action: 'none', reason: 'pointer_resource', updates: null }
  }

  const incoming = input && typeof input === 'object' ? input : {}
  const targetChanged = Boolean(beforeRow) && !sameTarget(beforeRow, currentRow)
  const incomingFreshVerdict = hasFreshLinkVerificationVerdict(incoming, nowMs)
  const incomingCurrentSuccess = hasCurrentSuccessfulLinkProof(incoming, nowMs)
  const beforeCurrentSuccess = Boolean(beforeRow) && hasCurrentSuccessfulLinkProof(beforeRow, nowMs)
  const currentSuccess = hasCurrentSuccessfulLinkProof(currentRow, nowMs)

  if (targetChanged) {
    if (incomingCurrentSuccess && successProofMatchesNewTarget(incoming, currentRow, beforeRow)) {
      return { action: 'none', reason: 'changed_target_with_fresh_success', updates: null }
    }

    if (incomingFreshVerdict) {
      return {
        action: 'update',
        reason: 'changed_target_with_fresh_non_success',
        updates: {
          ...proofFields(incoming),
          final_url: incoming.final_url ?? null,
          http_status: incoming.http_status ?? incoming.link_status_code ?? null,
          is_hidden: true,
        },
      }
    }

    return {
      action: 'update',
      reason: 'changed_target_requires_reverification',
      updates: {
        last_verified_at: null,
        link_status: 'unverified',
        link_status_code: null,
        verification_method: null,
        verified_by: null,
        verification_error: 'url_changed_requires_reverification',
        final_url: null,
        http_status: null,
        is_hidden: true,
      },
    }
  }

  // A new probe is authoritative. A successful probe needs no correction;
  // every other fresh verdict remains evidence but is quarantined.
  if (incomingFreshVerdict) {
    if (incomingCurrentSuccess) {
      return { action: 'none', reason: 'fresh_success', updates: null }
    }
    return {
      action: 'update',
      reason: 'fresh_non_success_quarantine',
      updates: { ...proofFields(incoming), is_hidden: true },
    }
  }

  // No new probe occurred. Preserve a still-current proof for the same target.
  if (beforeCurrentSuccess) {
    return {
      action: 'update',
      reason: 'same_target_preserve_current_proof',
      updates: {
        ...proofFields(beforeRow),
        is_hidden: Boolean(currentRow.is_hidden),
      },
    }
  }

  if (currentSuccess) {
    return { action: 'none', reason: 'current_success', updates: null }
  }

  // Stale/missing proof is historical evidence only. Keep a stale timestamp for
  // audit, but demote a stale success status so the verifier will re-check it.
  const status = normalizedStatus(currentRow)
  const staleSuccessful = SUCCESS.has(status)
  return {
    action: 'update',
    reason: staleSuccessful ? 'stale_success_quarantine' : 'missing_success_quarantine',
    updates: {
      ...proofFields(currentRow),
      link_status: staleSuccessful ? 'unverified' : (currentRow.link_status ?? 'unverified'),
      verification_error: staleSuccessful
        ? 'stale_verification_proof_requires_recheck'
        : (currentRow.verification_error ?? null),
      is_hidden: true,
    },
  }
}

function missingLifecycleSchema(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return (
    message.includes('is_hidden') ||
    message.includes('link_status') ||
    message.includes('last_verified_at') ||
    message.includes('verification_method') ||
    message.includes('verification_error') ||
    message.includes('final_url') ||
    message.includes('http_status')
  ) && (
    message.includes('no such column') ||
    message.includes('has no column named') ||
    message.includes('does not exist')
  )
}

/**
 * Apply the pure resolver against the just-written database row. Missing
 * lifecycle columns are tolerated only for minimal/rolling-deploy fixtures;
 * production schemas include them and any other database error is fatal.
 */
export async function enforceOpportunityLinkProofAfterWrite(
  db,
  opportunityId,
  { beforeRow = null, input = null, nowMs = Date.now() } = {},
) {
  if (!db || !opportunityId) return { supported: false, changed: false, reason: 'missing_database_or_id' }
  try {
    const currentRow = await db.prepare(
      'SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1',
    ).get(opportunityId)
    if (!currentRow) return { supported: true, changed: false, reason: 'row_missing', row: null }

    const resolution = resolveOpportunityLinkProofState({ beforeRow, currentRow, input, nowMs })
    if (resolution.action !== 'update' || !resolution.updates) {
      return { supported: true, changed: false, reason: resolution.reason, row: currentRow }
    }

    const u = resolution.updates
    const hidden = db?.dialect === 'postgres' ? Boolean(u.is_hidden) : (u.is_hidden ? 1 : 0)
    await db.prepare(`
      UPDATE funding_opportunities
         SET last_verified_at = ?,
             link_status = ?,
             link_status_code = ?,
             verification_method = ?,
             verified_by = ?,
             verification_error = ?,
             final_url = ?,
             http_status = ?,
             is_hidden = ?
       WHERE id = ?
    `).run(
      u.last_verified_at ?? null,
      u.link_status ?? 'unverified',
      u.link_status_code ?? null,
      u.verification_method ?? null,
      u.verified_by ?? null,
      u.verification_error ?? null,
      u.final_url ?? null,
      u.http_status ?? null,
      hidden,
      opportunityId,
    )

    const row = await db.prepare(
      'SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1',
    ).get(opportunityId)
    return { supported: true, changed: true, reason: resolution.reason, row }
  } catch (error) {
    if (missingLifecycleSchema(error)) {
      return { supported: false, changed: false, reason: 'lifecycle_schema_not_applied' }
    }
    throw error
  }
}

export default {
  LINK_PROOF_MAX_AGE_DAYS,
  SUCCESSFUL_LINK_STATUSES,
  effectiveLinkVerificationTarget,
  hasCurrentSuccessfulLinkProof,
  hasFreshLinkVerificationVerdict,
  resolveOpportunityLinkProofState,
  enforceOpportunityLinkProofAfterWrite,
}
