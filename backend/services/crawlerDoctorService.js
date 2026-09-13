/**
 * crawlerDoctorService.js — per-profile, per-match crawler diagnostics.
 *
 * THE GAP THIS CLOSES (2026-07-06): every existing diagnostic (crawler-plan,
 * Sam registry checks, `npm run crawler:doctor`) reports AGGREGATES — nothing
 * could answer "which query produced this match, why was it included, why was
 * that one excluded, what did amount extraction find". This service joins the
 * stored per-match provenance (profile_opportunity_matches.source_query /
 * discovered_via, migration 133) with the persisted match_explain_json and the
 * catalog's amount-visibility columns to produce a row-level explanation, plus
 * the queries the NEXT crawl will run (including learned-gap steering) so an
 * operator can see the closed loop working.
 *
 * READ-ONLY. Never mutates. Admin-only at the route layer.
 */

import { getDb } from '../db/index.js'
import { buildThesisForProfile } from './crawlerOsService.js'
import { buildWebQueries, buildWebQueryPlan, normalizeQueryKey } from '../crawler-os/webQueries.js'
import { auditProfileResultCoverage } from './coverageAudit/profileResultCoverageAudit.js'
import { qualifiesForDisplay, SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { isPointerKind } from '../config/opportunityKindClasses.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('crawlerDoctor')

function jparse(v, fallback) {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return fallback }
}

// Fields a funder page SHOULD provide; missing ones explain weak downstream
// behavior (no amount → $0 pipeline value; no deadline → can't prioritize).
function missingSourceFields(row) {
  const missing = []
  if (!row.deadline && !/rolling|ongoing/i.test(String(row.deadline_type || ''))) missing.push('deadline')
  const hasAmount = Number(row.amount_min) > 0 || Number(row.amount_max) > 0
  if (!hasAmount && !row.amount_text) missing.push('amount')
  if (!row.application_url && !row.source_url) missing.push('application_url')
  if (!row.sponsor) missing.push('sponsor')
  return missing
}

function explainMatchRow(row, floor) {
  const explain = jparse(row.match_explain_json, {})
  const decision = String(row.match_decision || '').toLowerCase()
  const score = Number(row.match_score)
  // Use the canonical pointer registry, not a hand-typed subset. The literal
  // list omitted `referral` and `school_portal`, so those rows were handed to
  // `qualifiesForDisplay` with `is_directory:false` and the doctor reported
  // "below display gate" for rows the real read path DOES surface — a
  // diagnostic contradicting the product it diagnoses.
  const isDirectory = isPointerKind(row.opportunity_kind)
  const surfaced = qualifiesForDisplay(
    { ...row, is_directory: isDirectory },
    floor,
  )

  let inclusion
  if (decision === 'reject') {
    inclusion = { included: false, reason: explain.why || row.match_explanation || 'engine decision: reject' }
  } else if (!surfaced) {
    inclusion = { included: false, reason: `below display gate (score ${score} < floor ${floor} and not ACCEPT)` }
  } else {
    inclusion = { included: true, reason: explain.why || row.match_explanation || `decision ${decision || 'review'} @ ${score}` }
  }

  const breakdown = explain.score_breakdown ?? explain.scoreBreakdown ?? {}
  const amountStatus = row.amount_status || ((Number(row.amount_min) > 0 || Number(row.amount_max) > 0) ? 'range' : 'not_listed')

  return {
    opportunity_id: row.opportunity_id,
    title: row.title,
    sponsor: row.sponsor,
    score: Number.isFinite(score) ? score : null,
    decision: row.match_decision ?? null,
    surfaced,
    inclusion,
    provenance: {
      // Which query produced this match (web lane; NULL for registry adapters
      // and rows that predate migration 133).
      source_query: row.source_query ?? null,
      discovered_via: row.discovered_via ?? null,
      matcher_version: row.matcher_version ?? null,
      source: row.source ?? null,
      evaluated_at: row.evaluated_at ?? null,
    },
    geography: {
      opportunity_state: row.state ?? null,
      is_national: Boolean(row.is_national),
      matched_location: explain.matched_location ?? null,
      geo_component: breakdown.geo_component ?? null,
    },
    eligibility: {
      fit: explain.eligibility_fit ?? null,
      missing_fields: explain.missing_eligibility_fields ?? [],
      warnings: explain.warnings ?? [],
      matched_needs: explain.matched_needs ?? [],
      matched_profile_facts: explain.matched_profile_facts ?? [],
    },
    amount: {
      amount_min: row.amount_min ?? null,
      amount_max: row.amount_max ?? null,
      amount_text: row.amount_text ?? null,
      amount_status: amountStatus,
      amount_confidence: row.amount_confidence ?? null,
    },
    missing_source_fields: missingSourceFields(row),
  }
}

// The live web lane's query budget, resolved exactly the way webLane resolves
// it (opts.maxQueries is not available to a diagnostic; env else 28; a
// non-positive or non-numeric value falls back). Kept as a literal on purpose:
// webLane owns the env contract and the doctor must never pull the lane in.
const DEFAULT_WEB_LANE_MAX_QUERIES = 28
function resolveLiveQueryBudget() {
  const n = Number(process.env.WEB_LANE_MAX_QUERIES)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WEB_LANE_MAX_QUERIES
}

/**
 * buildDoctorQueryDiagnostics — the queries the NEXT web-lane crawl will run
 * and what the audit's gap classes would ADD to them.
 *
 * ONE budget (webq-9): `next_queries` is planned at the live lane budget, and
 * `suggested_expansions` is the steered plan at the SAME budget minus the
 * UNCAPPED baseline universe, so a baseline query the cap merely hid is never
 * reported as gap-driven. Steering also PROMOTES ordinary pool queries into
 * the budget (the low_results branch forces "<need> grant funding <word>",
 * which the pool already holds) — those are reported separately as
 * `steering_promoted`, because "this crawl will now run it" is a real delta
 * even though the query is not new. `next_query_plan` carries the planner's
 * provenance (anchor / core / breadth, family, gap_class, need) per position.
 *
 * @param {object} thesis
 * @param {string[]} [gapClasses]  audit gap classes ('hyperlocal_gap:Bradley' is
 *   reduced to its class)
 */
export function buildDoctorQueryDiagnostics(thesis, gapClasses = []) {
  const queryBudget = resolveLiveQueryBudget()
  const plan = buildWebQueryPlan(thesis, { max: queryBudget, seed: 0 })
  const classes = [...new Set(
    (Array.isArray(gapClasses) ? gapClasses : []).map((g) => String(g ?? '').split(':')[0].trim()).filter(Boolean),
  )]
  let suggestedExpansions = []
  let steeringPromoted = []
  if (classes.length > 0) {
    const steeredThesis = {
      ...thesis,
      learned_gaps: {
        ...(thesis?.learned_gaps ?? {}),
        classes: [...new Set([...(thesis?.learned_gaps?.classes ?? []), ...classes])],
        missing_schools: thesis?.learned_gaps?.missing_schools ?? [],
      },
    }
    const steered = buildWebQueries(steeredThesis, { max: queryBudget, seed: 0 })
    const baselineUniverse = new Set(buildWebQueries(thesis, { max: 10000, seed: 0 }).map(normalizeQueryKey))
    const planned = new Set(plan.queries.map(normalizeQueryKey))
    suggestedExpansions = steered.filter((q) => !baselineUniverse.has(normalizeQueryKey(q)))
    steeringPromoted = steered.filter((q) => baselineUniverse.has(normalizeQueryKey(q)) && !planned.has(normalizeQueryKey(q)))
  }
  return {
    query_budget: queryBudget,
    next_queries: plan.queries,
    next_query_plan: plan.entries,
    suggested_expansions: suggestedExpansions,
    steering_promoted: steeringPromoted,
  }
}

/**
 * buildCrawlerDoctorReport — the full per-profile diagnostic.
 *
 * @param {object} db
 * @param {string} profileId
 * @param {{ limit?: number, floor?: number, thesis?: object }} [opts]
 *   opts.thesis — injectable for tests / callers that already built one.
 */
export async function buildCrawlerDoctorReport(db = getDb(), profileId, opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100))

  let thesis = opts.thesis ?? null
  if (!thesis) {
    try {
      // buildThesisForProfile also attaches learned gaps (the closed loop).
      thesis = await buildThesisForProfile(db, profileId)
    } catch (err) {
      // loadProfileContext THROWS for an unknown id (it does not return null)
      // — same contract as crawlerPlanService: map to a clean not-found so the
      // admin route answers 404, never 500.
      if (/not found|no such|does not exist/i.test(String(err?.message || ''))) {
        return { error: 'profile_not_found', profile_id: profileId }
      }
      throw err
    }
  }
  if (!thesis) return { error: 'profile_not_found', profile_id: profileId }

  // Stored matches with provenance + amount visibility, best first.
  const versions = SURFACED_MATCHER_VERSIONS.map(() => '?').join(', ')
  let rows = []
  let matchesError = null
  try {
    rows = await db
      .prepare(
        `SELECT m.opportunity_id, m.match_score, m.match_decision, m.match_explanation,
                m.match_explain_json, m.matcher_version, m.source_query, m.discovered_via,
                m.evaluated_at,
                fo.title, fo.sponsor, fo.source, fo.state, fo.is_national, fo.deadline,
                fo.deadline_type, fo.application_url, fo.source_url, fo.opportunity_kind,
                fo.amount_min, fo.amount_max, fo.amount_text, fo.amount_status, fo.amount_confidence
           FROM profile_opportunity_matches m
           JOIN funding_opportunities fo ON fo.id = m.opportunity_id
          WHERE m.profile_id = ? AND m.matcher_version IN (${versions})
          ORDER BY m.match_score DESC
          LIMIT ?`,
      )
      .all(profileId, ...SURFACED_MATCHER_VERSIONS, limit)
  } catch (err) {
    log.warn('doctor match query failed', { profileId, error: err?.message })
    rows = []
    // A FAILED read is not the fact "this profile has no matches" — and this
    // report exists precisely to explain WHY a profile has none. The query
    // selects migration-gated columns (`fo.amount_status`, `m.source_query`),
    // so one schema drift used to turn the diagnostic into a confident
    // "total_matches: 0". Carry the failure into the payload; the sibling
    // coverage catch below is already honest (it leaves `coverage: null`).
    matchesError = err?.message || String(err)
  }

  // Coverage audit → gap classes + the expansions the closed loop will add.
  let coverage = null
  try {
    coverage = await auditProfileResultCoverage(db, profileId, { thesis })
  } catch (err) {
    log.warn('doctor coverage audit failed', { profileId, error: err?.message })
  }
  const gapClasses = Array.isArray(coverage?.gaps)
    ? coverage.gaps.map((g) => String(g).split(':')[0])
    : []

  // The queries the NEXT web-lane crawl will run (seed 0 = the deterministic
  // base set at the LIVE budget; live runs rotate the breadth pool on top of
  // the same anchors/core) and what the audit's gap classes would ADD —
  // the literal closed-loop delta, at one budget (webq-9).
  const queryDiagnostics = buildDoctorQueryDiagnostics(thesis, gapClasses)

  const floor = Number.isFinite(opts.floor) ? opts.floor : DEFAULT_MIN_SCORE
  const matches = rows.map((r) => explainMatchRow(r, floor))
  const withProvenance = matches.filter((m) => m.provenance.source_query).length
  const withAmount = matches.filter((m) => ['known', 'range', 'estimated'].includes(m.amount.amount_status)).length

  return {
    profile_id: profileId,
    generated_at: new Date().toISOString(),
    thesis: {
      applicant_types: thesis.applicant_types ?? [],
      needs: thesis.needs ?? [],
      location: thesis.location ?? {},
      is_student: Boolean(thesis.is_student),
      schools: thesis.schools ?? [],
      learned_gaps: thesis.learned_gaps ?? null,
    },
    query_budget: queryDiagnostics.query_budget,
    next_queries: queryDiagnostics.next_queries,
    next_query_plan: queryDiagnostics.next_query_plan,
    matches,
    matches_error: matchesError,
    summary: {
      // NULL (not 0) when the match read failed: "we could not look" and
      // "there is nothing" are different facts.
      total_matches: matchesError ? null : matches.length,
      surfaced: matches.filter((m) => m.surfaced).length,
      with_query_provenance: withProvenance,
      with_amount: withAmount,
      amount_coverage_pct: matches.length ? Math.round((withAmount / matches.length) * 100) : null,
    },
    coverage: coverage
      ? { healthy: coverage.healthy ?? null, gaps: coverage.gaps ?? [], surfaced: coverage.surfaced ?? null, surfaced_actionable: coverage.surfaced_actionable ?? null }
      : null,
    suggested_expansions: queryDiagnostics.suggested_expansions,
    steering_promoted: queryDiagnostics.steering_promoted,
  }
}

export default { buildCrawlerDoctorReport, buildDoctorQueryDiagnostics }
