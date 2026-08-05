import { createLogger } from '../../utils/logger.js'
import {
  applyNeedFirstScoring,
  NEED_FIRST_SCORING_VERSION,
} from './needFirstScoringAdapter.js'
import { NEED_FIRST_RECONCILIATION_ROWS_SQL } from './fundingSourceQueries.js'
import { normalizePersistedMatchDecisionIntegrity } from './matchDecisionIntegrity.js'
import { SURFACED_MATCHER_VERSIONS } from '../../config/matchSurfacing.js'

const log = createLogger('needFirstReconciler')
/**
 * READ FROM THE REGISTRY, never re-type the list. This set was hand-written as
 * `['crawler-os','crawler-os-xmatch','web-llm']` and immediately drifted: #1089
 * added `institution-link` to `SURFACED_MATCHER_VERSIONS` but not here, so every
 * attendance-linked match a student could see was silently skipped by need-first
 * reconciliation — the exact re-encoding `matchSurfacing.js` exists to prevent
 * (its own header documents the three-way drift that caused the original bug).
 */
const SURFACED_LANES = new Set(SURFACED_MATCHER_VERSIONS)

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

function parseReasons(value) {
  const parsed = parseJson(value, value)
  if (Array.isArray(parsed)) return parsed.map((entry) => String(entry || '').trim()).filter(Boolean)
  if (typeof parsed === 'string') {
    return parsed.split(/[;,|]+/).map((entry) => entry.trim()).filter(Boolean)
  }
  return []
}

function isCurrent(explain) {
  return String(
    explain?.scoring_policy_version ??
    explain?.scoreBreakdown?.scoring_policy_version ??
    explain?.score_breakdown?.scoring_policy_version ??
    '',
  ) === NEED_FIRST_SCORING_VERSION
}

function persistedCanonical(row, explain) {
  const matchedNeeds = Array.isArray(explain?.matchedNeeds)
    ? explain.matchedNeeds
    : Array.isArray(explain?.matched_needs)
      ? explain.matched_needs
      : []
  return {
    score: Number(row.match_score) || 0,
    decision: String(row.match_decision || 'REVIEW').toUpperCase(),
    explanation: row.match_explanation ?? null,
    reasons: parseReasons(row.match_reasons),
    matchedNeeds,
    match_explain: explain ?? {},
    matcherVersion: explain?.matcher_version ?? null,
  }
}

/**
 * Idempotently reconcile a bounded slice of a profile's persisted surfaced
 * matches to the current need-first scoring policy. Discovery lane identity is
 * preserved. Read-time presentation applies the same policy immediately, so a
 * bounded reconciliation can converge safely across calls without surfacing
 * stale decisions in the meantime.
 */
export async function reconcileNeedFirstProfileMatches(db, {
  profileId,
  profileContext,
  limit = 250,
} = {}) {
  if (!db || typeof db.prepare !== 'function') {
    return { ok: false, reason: 'db_required', scanned: 0, updated: 0, failures: [] }
  }
  if (!profileId || !profileContext) {
    return { ok: false, reason: 'profile_context_required', scanned: 0, updated: 0, failures: [] }
  }

  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 250))
  // This shares the owner-facing route's canonical live-column projection. The
  // old query used Crawler OS in-memory field names such as `o.summary` against
  // PostgreSQL, so reconciliation failed before it scanned a single persisted
  // match.
  const rows = await db
    .prepare(NEED_FIRST_RECONCILIATION_ROWS_SQL)
    .all(String(profileId), safeLimit)

  let scanned = 0
  let current = 0
  let updated = 0
  let rejected = 0
  let demoted = 0
  let scoreLowered = 0
  const failures = []

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!SURFACED_LANES.has(String(row.matcher_version || ''))) continue
    scanned += 1
    const explain = parseJson(row.match_explain_json, {}) || {}
    if (isCurrent(explain)) {
      // Current rows were already scored by the Crawler OS facade *after* it
      // applied this policy, so their confidence was measured for the current
      // score contract and must survive. Before match-confidence persistence
      // existed, production rows were NULL; there is no legacy non-null value
      // to scrub here. Only the stale-policy update below invalidates confidence.
      current += 1
      continue
    }

    try {
      const adjusted = applyNeedFirstScoring({
        canonical: persistedCanonical(row, explain),
        profileContext,
        opportunity: row,
      })
      const newDecision = String(adjusted.decision || 'REVIEW').toUpperCase()
      const newScore = Math.round(Number(adjusted.score) || 0)

      // Confidence was measured against the crawler's original score/decision.
      // Once this policy replaces that contract, retaining the old percentage
      // would pair one measurement with a different outcome. Null is the honest
      // value until a fresh canonical match run measures confidence again.
      const result = await db.prepare(
        `UPDATE profile_opportunity_matches
            SET match_score = ?,
                match_confidence = NULL,
                match_decision = ?,
                match_explanation = ?,
                match_reasons = ?,
                match_explain_json = ?,
                updated_at = CURRENT_TIMESTAMP,
                evaluated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ? AND opportunity_id = ?`,
      ).run(
        newScore,
        newDecision.toLowerCase(),
        adjusted.explanation ?? null,
        JSON.stringify(adjusted.reasons ?? []),
        JSON.stringify(adjusted.match_explain ?? {}),
        String(profileId),
        String(row.opportunity_id),
      )
      const changes = Number(result?.changes ?? result?.rowCount ?? 0)
      if (changes <= 0) {
        failures.push({
          opportunity_id: row.opportunity_id,
          error: 'selected match row was not updated',
        })
        continue
      }

      updated += changes
      if (newDecision === 'REJECT') rejected += changes
      if (String(row.match_decision || '').toUpperCase() === 'ACCEPT' && newDecision !== 'ACCEPT') {
        demoted += changes
      }
      if (newScore < Math.round(Number(row.match_score) || 0)) scoreLowered += changes
    } catch (error) {
      failures.push({
        opportunity_id: row.opportunity_id,
        error: error?.message || String(error),
      })
    }
  }

  // A REJECT is a decision, not a surfaced match. Run the structural integrity
  // pass after the scorer writes so this choke point can never leave a rejected
  // direct row visible or an ACCEPT-labelled directory in persisted truth.
  let matchDecisionIntegrity = null
  try {
    matchDecisionIntegrity = await normalizePersistedMatchDecisionIntegrity(db, { profileId })
  } catch (error) {
    failures.push({
      opportunity_id: null,
      error: `match decision integrity failed: ${error?.message || String(error)}`,
    })
  }

  const summary = {
    ok: failures.length === 0,
    profile_id: String(profileId),
    scoring_policy_version: NEED_FIRST_SCORING_VERSION,
    scanned,
    already_current: current,
    updated,
    rejected,
    demoted,
    score_lowered: scoreLowered,
    match_decision_integrity: matchDecisionIntegrity,
    failures,
  }
  if (updated > 0 || Number(matchDecisionIntegrity?.repaired || 0) > 0 || failures.length > 0) {
    log.info('need_first_reconcile', summary)
  }
  return summary
}

export default { reconcileNeedFirstProfileMatches }
