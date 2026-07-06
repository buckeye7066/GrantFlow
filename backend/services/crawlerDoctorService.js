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
import { buildWebQueries } from '../crawler-os/webQueries.js'
import { auditProfileResultCoverage } from './coverageAudit/profileResultCoverageAudit.js'
import { qualifiesForDisplay, SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
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
  const isDirectory = ['DIRECTORY', 'PAST_AWARD_INTEL'].includes(String(row.opportunity_kind || '').toUpperCase())
  const surfaced = qualifiesForDisplay(
    { is_directory: isDirectory, match_decision: row.match_decision, match_score: row.match_score },
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

  // The queries the NEXT web-lane crawl will run (seed 0 = the deterministic
  // base set; live runs rotate the EXTRA pool on top of the same CORE).
  const nextQueries = buildWebQueries(thesis, { max: 26, seed: 0 })

  // Stored matches with provenance + amount visibility, best first.
  const versions = SURFACED_MATCHER_VERSIONS.map(() => '?').join(', ')
  let rows = []
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

  // Suggested next expansions: what buildWebQueries ADDS when steered by the
  // audit's gap classes (diff vs the base set) — the literal closed-loop delta.
  let suggestedExpansions = []
  if (gapClasses.length > 0) {
    const steered = buildWebQueries(
      { ...thesis, learned_gaps: { classes: [...new Set([...(thesis.learned_gaps?.classes ?? []), ...gapClasses])], missing_schools: thesis.learned_gaps?.missing_schools ?? [] } },
      { max: 32, seed: 0 },
    )
    const base = new Set(nextQueries.map((q) => q.toLowerCase()))
    suggestedExpansions = steered.filter((q) => !base.has(q.toLowerCase()))
  }

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
    next_queries: nextQueries,
    matches,
    summary: {
      total_matches: matches.length,
      surfaced: matches.filter((m) => m.surfaced).length,
      with_query_provenance: withProvenance,
      with_amount: withAmount,
      amount_coverage_pct: matches.length ? Math.round((withAmount / matches.length) * 100) : null,
    },
    coverage: coverage
      ? { healthy: coverage.healthy ?? null, gaps: coverage.gaps ?? [], surfaced: coverage.surfaced ?? null, surfaced_actionable: coverage.surfaced_actionable ?? null }
      : null,
    suggested_expansions: suggestedExpansions,
  }
}

export default { buildCrawlerDoctorReport }
