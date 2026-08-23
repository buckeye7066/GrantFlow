/**
 * pipelineGuardEscapeAudit.js — Amy's reap-cycle PIPELINE GUARD-ESCAPE AUDIT.
 *
 * OWNER DIRECTIVE (2026-08-23): "when she deletes the [synthetic] profiles she
 * created after they've been crawled and learned from, she ALSO goes through
 * each pipeline of ALL profiles and cleans out sources that DO NOT MEET THE
 * CRITERIA but have somehow made it past our guards — and let her LEARN how they
 * did, so that particular blind spot is filled."
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This module adds ZERO removal logic. It calls the CANONICAL four-gate audit
 * (`robertPipelineAudit.auditAllPipelines`) over every REAL (non-synthetic)
 * profile's pipeline, which removes escapes through the SAME canonical tombstone
 * path (`recordDismissal` + `reconcileDismissedGrants`) that the boot net
 * (`enforcePipelinePrecision`), the owner-delete route, and Robert's own audit
 * use. Amy's contribution is the DIAGNOSIS/LEARNING layer on top: for every
 * removed escape it names WHICH admission gate should have caught it and WHY it
 * did not, so the blind spot can be closed.
 *
 * COMPOSITION WITH THE OTHER REMOVERS (the invariant that keeps them from
 * fighting): every remover here uses the SAME canonical criteria. A source
 * sibling #4 / Robert legitimately AUTO-ADDS passes the four gates, so Amy will
 * not remove it; a source Amy removes FAILS the four gates, so Robert will not
 * re-add it. Diverge from the canonical criteria and that invariant breaks — so
 * this module never invents a bar of its own.
 *
 * WHY MOST ESCAPES ARE ALREADY GONE AT REAP TIME (an honest success, not a
 * reason to manufacture removals): `enforcePipelinePrecision` runs the same
 * gates over every pipeline at every boot, bounded to `PIPELINE_PRECISION_LIMIT`
 * (2000) writes. Amy's reap catches the RESIDUAL escapes that bound did not
 * reach and — the distinctly-Amy part — turns each into a durable, ledger-aged
 * finding. Few escapes = the guards are working; that is what to report.
 *
 * THE REAL GATE IS DETERMINISTIC-OR-OFF AT REAP (no network by default). The
 * boot net already sweeps the deterministic REAL checks (title-sunset /
 * past-deadline / no-URL) over every pipeline, and a networked REAL gate would
 * spend minutes on live HEAD requests during the nightly reap. So `realGate`
 * defaults OFF here; Robert's own scheduled run does the networked REAL pass.
 * Flip it with `AMY_GUARD_ESCAPE_REAL_GATE=1`.
 */

import { auditAllPipelines } from '../robert/robertPipelineAudit.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('amy:guard-escape')

/** Networked REAL gate at reap is OFF by default — see the module header. */
export const GUARD_ESCAPE_REAL_GATE =
  String(process.env.AMY_GUARD_ESCAPE_REAL_GATE ?? '0').toLowerCase() === '1'

/**
 * The blind-spot diagnosis per escaped gate: which admission gate SHOULD have
 * caught the source at admission, the file + symbol to review, and the ASSERTION
 * that would prove the fix. Keyed by the `GATES.*` value robertPipelineAudit
 * records on each removal (`relatable` / `qualifies` / `covers_need` / `real`,
 * plus `duplicate`).
 */
export const GATE_BLIND_SPOTS = Object.freeze({
  relatable: {
    gate_file: 'backend/config/fundingResultFilters.js',
    symbol: 'classifyFundingResult / detectForeignOpportunity / isPointerKind',
    blind_spot:
      'a non-grant / info-only pointer / foreign / lead-gen source was admitted — the RELATABLE reality-and-junk chain did not refuse it at admission',
    assertion:
      'assert classifyFundingResult(row) is NOT_A_GRANT/RESOURCE (or detectForeignOpportunity fires) so admitToPipeline refuses this row',
  },
  qualifies: {
    gate_file: 'backend/services/applicantTypeGate.js',
    symbol: 'evaluateApplicantTypeEligibility / stageOfLifeConflictForSections / isRelevantGeo',
    blind_spot:
      "the profile does not QUALIFY (applicant type / stage of life / eligibility / geography) yet the source was admitted — a qualification gate has a blind spot",
    assertion:
      'assert computeMatchDecision REJECTs this opportunity for this profile (eligible: "no")',
  },
  covers_need: {
    gate_file: 'backend/services/pipelinePrecision.js',
    symbol: 'evaluateDeclaredNeedCoverage',
    blind_spot:
      "the source covers NONE of the profile's DECLARED needs yet was admitted — the NEED_COVERAGE admission gate (1.9) did not fire",
    assertion:
      'assert admitToPipeline Gate 1.9 NEED_COVERAGE denies this pair (declared vs opportunity need vocabularies do not intersect)',
  },
  real: {
    gate_file: 'backend/config/fundingResultFilters.js',
    symbol: 'isClearlyExpiredProgram / isPastDeadline',
    blind_spot:
      'the source is dead / expired / has no application URL yet stayed in the pipeline — a REAL-gate check did not run at admission',
    assertion:
      'assert this row is refused as expired/dead at admission (title-stated sunset, past deadline, or no application URL)',
  },
  duplicate: {
    gate_file: 'backend/services/robert/robertPipelineAudit.js',
    symbol: 'sameProgram / programIdentityKey',
    blind_spot: 'a duplicate of another pipeline row survived dedup at admission',
    assertion: 'assert the two rows collapse to one program identity (sameProgram === true)',
  },
})

export function blindSpotForGate(gate) {
  return (
    GATE_BLIND_SPOTS[String(gate ?? '')] || {
      gate_file: 'backend/services/robert/robertPipelineAudit.js',
      symbol: 'auditProfilePipeline',
      blind_spot: `a source failed the "${gate}" gate but was in the pipeline`,
      assertion: 'assert the admission gate refuses this pair',
    }
  )
}

/**
 * REAL (non-synthetic) profile ids only. Amy's OWN synthetic training profiles
 * (`created_by='agent:amy'`) are reaped by the deletion sweep in the same
 * cleanup cycle and must not be audited here. The audit's own Sasquatch guard
 * (`PROTECTED_PROFILE_NAME_RX`) still protects the PromoPilot fake profile.
 */
export async function selectRealProfileIds(db) {
  if (!db) return []
  const sql =
    "SELECT id FROM profiles WHERE (created_by IS NULL OR created_by <> 'agent:amy') " +
    "AND (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted')"
  try {
    const rows = await db.prepare(sql).all()
    return (rows || []).map((r) => String(r.id))
  } catch {
    // created_by/status/deleted_at column drift — fall back to all ids; the
    // audit re-excludes synthetics is NOT guaranteed, so this is a degraded path
    // (still real-safe for the Sasquatch profile via the audit's own guard).
    try {
      const rows = await db.prepare('SELECT id FROM profiles').all()
      return (rows || []).map((r) => String(r.id))
    } catch {
      return []
    }
  }
}

/**
 * Run the canonical four-gate audit over every real profile's pipeline, then
 * fold the removals into a per-gate BLIND-SPOT diagnosis Amy can report + learn
 * from. Removal is 100% canonical; this function adds only the diagnosis.
 *
 * @returns {Promise<object>} {
 *   ran, reason, profiles_scanned, profiles_with_escapes, candidates, kept,
 *   protected, deduped_away, unverifiable, escapes_removed, reconciled,
 *   by_gate:{gate:count}, by_reason:{'gate:reason':count}, escapes:[...], errors
 * }
 */
export async function runPipelineGuardEscapeAudit(db, {
  runId = null,
  now = new Date(),
  realGate = GUARD_ESCAPE_REAL_GATE,
  checkUrl = null,
} = {}) {
  const startedAt = now instanceof Date ? now : new Date()
  const empty = {
    ran: false,
    reason: 'no_db',
    profiles_scanned: 0,
    profiles_with_escapes: 0,
    candidates: 0,
    kept: 0,
    protected: 0,
    deduped_away: 0,
    unverifiable: 0,
    escapes_removed: 0,
    reconciled: 0,
    by_gate: {},
    by_reason: {},
    escapes: [],
    errors: [],
  }
  if (!db) return empty

  const profileIds = await selectRealProfileIds(db)
  if (profileIds.length === 0) {
    return { ...empty, ran: true, reason: 'no_real_profiles' }
  }

  let audit
  try {
    audit = await auditAllPipelines(db, {
      profileIds,
      userId: 'agent:amy',
      runId,
      now: startedAt,
      realGate,
      ...(typeof checkUrl === 'function' ? { checkUrl } : {}),
    })
  } catch (err) {
    log.warn('guard_escape_audit_failed', { error: err?.message })
    return {
      ...empty,
      ran: false,
      reason: 'audit_threw',
      error: err?.message || String(err),
      profiles_scanned: profileIds.length,
      errors: [{ stage: 'audit', error: err?.message || String(err) }],
    }
  }

  // Flatten every REMOVED escape (outcome==='removed' — a gate failure, never a
  // dedup, an unverifiable, or a protected row) with its per-gate diagnosis.
  const escapes = []
  const byGate = {}
  const byReason = {}
  let profilesWithEscapes = 0
  for (const one of Array.isArray(audit?.profiles) ? audit.profiles : []) {
    const removedHere = (Array.isArray(one?.removals) ? one.removals : []).filter(
      (r) => r?.outcome === 'removed',
    )
    if (removedHere.length > 0) profilesWithEscapes += 1
    for (const rem of removedHere) {
      const gate = String(rem.gate || 'unknown')
      const reason = rem.reason || 'failed'
      byGate[gate] = (byGate[gate] || 0) + 1
      byReason[`${gate}:${reason}`] = (byReason[`${gate}:${reason}`] || 0) + 1
      escapes.push({
        profile_id: one.profile_id,
        profile_display_name: one.profile_display_name ?? null,
        grant_id: rem.grant_id,
        title: rem.title,
        funder: rem.funder ?? null,
        gate,
        reason,
        evidence: rem.evidence ?? null,
      })
    }
  }

  const totals = audit?.totals || {}
  return {
    ran: true,
    reason: null,
    started_at: startedAt.toISOString(),
    real_gate: Boolean(realGate),
    profiles_scanned: profileIds.length,
    profiles_with_escapes: profilesWithEscapes,
    candidates: totals.candidates || 0,
    kept: totals.kept || 0,
    protected: totals.protected || 0,
    deduped_away: totals.deduped_away || 0,
    unverifiable: totals.unverifiable || 0,
    // A gate-failure removal IS an escape. `totals.removed` counts exactly these
    // (dedup increments `deduped_away`, not `removed`), so the two agree by
    // construction — asserted in the test.
    escapes_removed: escapes.length,
    removed_total: totals.removed || 0,
    reconciled: audit?.reconciled || 0,
    by_gate: byGate,
    by_reason: byReason,
    escapes,
    errors: [],
  }
}

export default {
  runPipelineGuardEscapeAudit,
  selectRealProfileIds,
  blindSpotForGate,
  GATE_BLIND_SPOTS,
  GUARD_ESCAPE_REAL_GATE,
}
