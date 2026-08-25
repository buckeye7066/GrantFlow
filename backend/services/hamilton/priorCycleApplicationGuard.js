/**
 * priorCycleApplicationGuard.js
 *
 * Cross-cycle duplicate-application guard.
 *
 * THE PROBLEM THIS EXISTS TO CATCH
 * `ux_application_tasks_profile_subject` guarantees one live task per
 * (profile, opportunity-or-grant). It cannot catch the two cases that actually
 * get an applicant disqualified by the funder:
 *
 *   1. A recurring program re-crawled as a NEW funding_opportunities row each
 *      cycle. Different subject id, same program, second submission.
 *   2. A submission the applicant made outside GrantFlow entirely.
 *
 * Both are answered by PROGRAM IDENTITY (canonicalOpportunityKey), which is
 * deliberately stable across cycles for the same title+sponsor, rather than by
 * row id.
 *
 * HONESTY POSTURE
 * This module reports a RISK, never a fact. It distinguishes:
 *   - 'grantflow_verified' — mirrored from a task that passed
 *     submissionProofPredicate's VERIFIED_EXTERNAL bar. GrantFlow watched it
 *     happen and holds retrievable proof.
 *   - 'owner_attested'     — a human asserted it. Believed, not verified.
 * Callers MUST surface which one blocked. An attestation must never be rendered
 * as a confirmed submission, in exactly the way a generated packet PDF is never
 * rendered as submission proof.
 *
 * It also never silently drops work. A blocked create raises a typed 422 with a
 * handoff payload, matching PointerResearchLeadTaskError — the owner's standing
 * rule that a stopped task must explain itself and offer a next action, rather
 * than becoming a silent dead row.
 */

import { randomUUID } from 'node:crypto'

import { canonicalOpportunityKey } from '../../crawler-os/contract.js'

export const PRIOR_CLAIM_ORIGIN = Object.freeze({
  GRANTFLOW_VERIFIED: 'grantflow_verified',
  OWNER_ATTESTED: 'owner_attested',
})

export const PRIOR_CLAIM_ORIGIN_LABELS = Object.freeze({
  [PRIOR_CLAIM_ORIGIN.GRANTFLOW_VERIFIED]:
    'GrantFlow submitted this program for you and holds the portal confirmation',
  [PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED]:
    'You told us you already applied to this program (your report — not verified by GrantFlow)',
})

export class DuplicateApplicationRiskError extends Error {
  constructor(risk) {
    super(risk?.instructions || 'This profile may have already applied to this program.')
    this.name = 'DuplicateApplicationRiskError'
    this.code = 'prior_cycle_application_risk'
    this.status = 422
    this.statusCode = 422
    this.handoff = risk ?? null
  }
}

/**
 * Program identity for an opportunity row.
 *
 * SCHEMA TRUTH (measured against production 2026-08-25, 27,642 rows):
 * `funding_opportunities` has NO `external_id` column — it has `source_id` —
 * and it ALREADY PERSISTS `canonical_opportunity_key`, which carries a UNIQUE
 * index (`idx_fo_canonical_key`). That stored value is the authoritative
 * program identity, so we READ it rather than recomputing.
 *
 * Recomputing would be actively WRONG: canonicalOpportunityKey() prefers an
 * `ext:` tier built from `external_id`, a field that does not exist on a row
 * read back out of this table. A JS recomputation therefore always falls to the
 * `t:` (title+sponsor) tier and would MISS the 2,806 rows (10%) whose stored key
 * is `ext:`-tier. Prefer the column; compute only when it is absent (2 rows).
 *
 * KNOWN LIMIT, stated rather than hidden: cross-cycle matching only works where
 * the identity is stable across cycles. That holds for the `t:` tier (24,832
 * rows / 90%) unless the funder embeds the year in the title, and does NOT hold
 * for the `ext:` tier, whose key embeds a per-cycle opportunity number. This
 * guard is a safety net over the owner-attested path, not a complete solution
 * to recurring-award identity.
 */
export function programIdentityKey(opportunity = {}) {
  const persisted = String(opportunity.canonical_opportunity_key ?? '').trim()
  if (persisted) return persisted

  return canonicalOpportunityKey({
    ...opportunity,
    external_id: opportunity.external_id ?? opportunity.source_id ?? null,
    apply_url: opportunity.apply_url ?? opportunity.application_url ?? opportunity.url ?? null,
    info_url: opportunity.source_url ?? opportunity.info_url ?? null,
  })
}

function normalizeCycle(value) {
  const cycle = String(value ?? '').trim()
  return cycle || null
}

/**
 * Two cycles conflict when we cannot PROVE they are different. An unknown cycle
 * on either side conflicts with everything: the conservative reading, because
 * the cost of a false block (one extra confirmation click) is far below the
 * cost of a false pass (funder-side disqualification).
 */
export function cyclesConflict(claimCycle, candidateCycle) {
  const a = normalizeCycle(claimCycle)
  const b = normalizeCycle(candidateCycle)
  if (!a || !b) return true
  return a.toLowerCase() === b.toLowerCase()
}

async function loadOpportunity(db, opportunityId) {
  if (!db || !opportunityId) return null
  // Only columns that exist on funding_opportunities (verified against the
  // production schema). The delivered draft selected `external_id` and
  // `cycle_label`; NEITHER exists, so BOTH the primary and the fallback query
  // threw, loadOpportunity returned null, and the guard degraded into a
  // permanent silent no-op — the exact failure class this codebase treats as
  // its worst defect. Do not add a column here without checking the schema.
  try {
    return await db
      .prepare(
        `SELECT id, source_id, title, sponsor, apply_url, application_url, url,
                source_url, canonical_opportunity_key
           FROM funding_opportunities WHERE id = ?`,
      )
      .get(String(opportunityId))
  } catch {
    return null
  }
}

async function loadActiveClaims(db, profileId, identityKey) {
  if (!db || !profileId || !identityKey) return []
  try {
    const rows = await db
      .prepare(
        `SELECT id, identity_key, cycle_label, origin, submitted_at, confirmation_reference,
                opportunity_id, task_id, note
           FROM prior_cycle_application_claims
          WHERE profile_id = ? AND identity_key = ? AND status = 'active'
          ORDER BY COALESCE(submitted_at, created_at) DESC`,
      )
      .all(String(profileId), String(identityKey))
    return rows || []
  } catch {
    // Table absent on a rolling deploy: fail OPEN. This guard is a safety net,
    // not an authority — it must never block legitimate applications because a
    // migration has not landed yet. The enforcement test asserts the table
    // exists in a migrated database, so a missing table is a deploy-order
    // issue, not a silent permanent bypass.
    return []
  }
}

/**
 * Assess whether creating an application task for this (profile, opportunity)
 * risks a duplicate submission to a program the profile already applied to.
 *
 * @returns {Promise<null|{
 *   identity_key: string,
 *   cycle_label: string|null,
 *   claims: Array<object>,
 *   blocking_origin: string,
 *   independently_verified: boolean,
 *   headline: string,
 *   instructions: string,
 *   next_actions: Array<{action: string, label: string}>,
 * }>} null when there is no risk.
 */
export async function assessDuplicateApplicationRisk(db, {
  profileId,
  opportunityId = null,
  opportunity = null,
  cycleLabel = null,
} = {}) {
  if (!profileId) return null

  const row = opportunity ?? (await loadOpportunity(db, opportunityId))
  if (!row) return null

  const identityKey = programIdentityKey(row)
  if (!identityKey || identityKey.startsWith('id:')) return null

  // `funding_opportunities` has no cycle column (cycle_json is populated on 0
  // of 27,642 production rows), so the cycle is whatever the CALLER states.
  // Absent one, candidateCycle stays null and cyclesConflict() treats it as
  // conflicting with everything — the deliberate conservative reading.
  const candidateCycle = normalizeCycle(cycleLabel)
  const claims = await loadActiveClaims(db, profileId, identityKey)
  const conflicting = claims.filter((claim) => cyclesConflict(claim.cycle_label, candidateCycle))
  if (conflicting.length === 0) return null

  // A verified claim outranks an attestation when deciding what to tell the
  // user, so the strongest available evidence is the one shown.
  const verified = conflicting.find((c) => c.origin === PRIOR_CLAIM_ORIGIN.GRANTFLOW_VERIFIED)
  const blocking = verified ?? conflicting[0]
  const independentlyVerified = blocking.origin === PRIOR_CLAIM_ORIGIN.GRANTFLOW_VERIFIED

  const when = blocking.submitted_at ? ` on ${String(blocking.submitted_at).slice(0, 10)}` : ''
  const cycleText = blocking.cycle_label ? ` for the ${blocking.cycle_label} cycle` : ''

  return {
    identity_key: identityKey,
    cycle_label: candidateCycle,
    claims: conflicting,
    blocking_origin: blocking.origin,
    independently_verified: independentlyVerified,
    headline: independentlyVerified
      ? 'Already submitted to this program'
      : 'You may have already applied to this program',
    instructions: [
      `${PRIOR_CLAIM_ORIGIN_LABELS[blocking.origin]}${cycleText}${when}.`,
      'Many funders disqualify duplicate entries, so GrantFlow stopped before creating a second application.',
      independentlyVerified
        ? 'If this is genuinely a new cycle the funder treats as a separate award, confirm below and GrantFlow will proceed.'
        : 'If that report was wrong, retract it below and GrantFlow will proceed.',
    ].join(' '),
    next_actions: [
      { action: 'confirm_new_cycle', label: 'This is a separate cycle — apply anyway' },
      { action: 'retract_claim', label: 'I have not applied to this — retract that record' },
      { action: 'view_prior', label: 'View the prior application' },
    ],
  }
}

/**
 * Mirror a task that reached VERIFIED_EXTERNAL proof into the claim ledger, so
 * a later cycle of the same program is guarded. Idempotent: the active unique
 * index collapses repeats.
 *
 * Call this from the SAME place that records verified submission proof — never
 * from a status write. A claim must only ever be born from proof, or from an
 * explicit human attestation.
 */
export async function recordVerifiedSubmissionClaim(db, {
  id = null,
  profileId,
  opportunity = null,
  opportunityId = null,
  taskId = null,
  cycleLabel = null,
  submittedAt = null,
  confirmationReference = null,
}) {
  if (!db || !profileId) return null
  // Callers at the proof-birth site hold an opportunity ID, not a hydrated row.
  const row = opportunity ?? (await loadOpportunity(db, opportunityId))
  if (!row) return null
  const identityKey = programIdentityKey(row)
  if (!identityKey || identityKey.startsWith('id:')) return null

  try {
    await db
      .prepare(
        `INSERT INTO prior_cycle_application_claims
           (id, profile_id, identity_key, cycle_label, opportunity_id, task_id,
            origin, submitted_at, confirmation_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(id || randomUUID()),
        String(profileId),
        identityKey,
        normalizeCycle(cycleLabel),
        row.id ? String(row.id) : null,
        taskId ? String(taskId) : null,
        PRIOR_CLAIM_ORIGIN.GRANTFLOW_VERIFIED,
        submittedAt,
        confirmationReference,
      )
    return identityKey
  } catch {
    // Unique-index collision means the claim already exists — the desired end
    // state. Any other failure must not break the submission path.
    return identityKey
  }
}


/**
 * Record an OWNER-ATTESTED prior application: a human stating "I already
 * applied to this program", typically outside GrantFlow entirely.
 *
 * This is the case no index can catch, and it is the guard's primary value:
 * measured against production (27,642 opportunities), `canonical_opportunity_key`
 * carries a UNIQUE index, so a re-crawled recurring program COLLAPSES into the
 * existing row rather than minting a second one — meaning the in-GrantFlow
 * duplicate case is already largely handled. The outside submission is not.
 *
 * The origin is NEVER 'grantflow_verified' here, and confirmation_reference is
 * never populated from an attestation: a claim the owner asserts must not be
 * renderable as proof GrantFlow holds.
 */
export async function attestPriorApplication(db, {
  profileId,
  opportunityId = null,
  opportunity = null,
  cycleLabel = null,
  note = null,
  attestedByUserId = null,
}) {
  if (!db || !profileId) throw new Error('profileId required')
  const row = opportunity ?? (await loadOpportunity(db, opportunityId))
  if (!row) {
    const err = new Error('That opportunity could not be found, so there is nothing to attest against.')
    err.status = 404
    err.statusCode = 404
    err.code = 'opportunity_not_found'
    throw err
  }
  const identityKey = programIdentityKey(row)
  if (!identityKey || identityKey.startsWith('id:')) {
    const err = new Error('This opportunity has no stable program identity, so a prior-application claim cannot be matched across cycles.')
    err.status = 422
    err.statusCode = 422
    err.code = 'no_program_identity'
    throw err
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  try {
    await db
      .prepare(
        `INSERT INTO prior_cycle_application_claims
           (id, profile_id, identity_key, cycle_label, opportunity_id,
            origin, attested_by_user_id, attested_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(profileId),
        identityKey,
        normalizeCycle(cycleLabel),
        row.id ? String(row.id) : null,
        PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED,
        attestedByUserId ? String(attestedByUserId) : null,
        now,
        note ? String(note) : null,
      )
    return { id, identity_key: identityKey, origin: PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED, duplicate: false }
  } catch (error) {
    // The active unique index means "already attested" — the desired end state,
    // reported honestly as a duplicate rather than as a fresh write.
    const existing = await loadActiveClaims(db, profileId, identityKey)
    if (existing.length > 0) {
      return { id: existing[0].id, identity_key: identityKey, origin: existing[0].origin, duplicate: true }
    }
    throw error
  }
}

/**
 * Retract a claim. Append-only: the row is never deleted, the original
 * assertion stays auditable, and the DB trigger rejects any update that is not
 * a well-formed retraction carrying a reason and an actor.
 */
export async function retractPriorApplicationClaim(db, {
  profileId,
  claimId,
  reason,
  retractedByUserId = null,
}) {
  if (!db || !profileId || !claimId) throw new Error('profileId and claimId required')
  const cleanReason = String(reason ?? '').trim()
  if (!cleanReason) {
    const err = new Error('A retraction reason is required.')
    err.status = 400
    err.statusCode = 400
    err.code = 'retraction_reason_required'
    throw err
  }
  if (!retractedByUserId) {
    const err = new Error('A retracting user is required.')
    err.status = 400
    err.statusCode = 400
    err.code = 'retraction_actor_required'
    throw err
  }

  const claim = await db
    .prepare(`SELECT id, status FROM prior_cycle_application_claims WHERE id = ? AND profile_id = ?`)
    .get(String(claimId), String(profileId))
  if (!claim) {
    const err = new Error('Claim not found for this profile.')
    err.status = 404
    err.statusCode = 404
    err.code = 'claim_not_found'
    throw err
  }
  if (claim.status === 'retracted') return { id: claim.id, status: 'retracted', already: true }

  await db
    .prepare(
      `UPDATE prior_cycle_application_claims
          SET status = 'retracted', retracted_at = ?, retraction_reason = ?, retracted_by_user_id = ?
        WHERE id = ? AND profile_id = ? AND status = 'active'`,
    )
    .run(new Date().toISOString(), cleanReason, String(retractedByUserId), String(claimId), String(profileId))
  return { id: claim.id, status: 'retracted', already: false }
}

/**
 * List a profile's claims for display. Callers MUST render `origin` — an
 * attestation may never be shown as a verified submission.
 */
export async function listPriorApplicationClaims(db, { profileId, includeRetracted = false }) {
  if (!db || !profileId) return []
  const sql = includeRetracted
    ? `SELECT * FROM prior_cycle_application_claims WHERE profile_id = ? ORDER BY created_at DESC`
    : `SELECT * FROM prior_cycle_application_claims WHERE profile_id = ? AND status = 'active' ORDER BY created_at DESC`
  try {
    const rows = await db.prepare(sql).all(String(profileId))
    return (rows || []).map((r) => ({
      ...r,
      origin_label: PRIOR_CLAIM_ORIGIN_LABELS[r.origin] || r.origin,
      independently_verified: r.origin === PRIOR_CLAIM_ORIGIN.GRANTFLOW_VERIFIED,
    }))
  } catch {
    return []
  }
}

export default {
  PRIOR_CLAIM_ORIGIN,
  PRIOR_CLAIM_ORIGIN_LABELS,
  DuplicateApplicationRiskError,
  programIdentityKey,
  cyclesConflict,
  assessDuplicateApplicationRisk,
  recordVerifiedSubmissionClaim,
  attestPriorApplication,
  retractPriorApplicationClaim,
  listPriorApplicationClaims,
}
