/**
 * amyReport.js
 *
 * Turns the raw Crawler-OS discovery result for one synthetic profile into a
 * set of structured "findings" describing where the crawler succeeded or fell
 * short, then assembles a single Anya-consumable handoff report.
 *
 * The handoff mirrors the object shape `admin.anya.runAutonomous` returns (the
 * report that lands in audit-reports/anya-audit-*.json): a flat `findings[]`
 * with { file, line, type, severity, message, excerpt, fixable, search_kind,
 * evidence } so Anya can act on real repo file targets, plus an `amy_summary`
 * block with per-category / per-status / source-health aggregates.
 */

import { DEFAULT_MIN_SCORE, ACCEPT_SCORE, REVIEW_SCORE } from '../../config/matchThresholds.js'
import { FINDING_TYPES, SEVERITY, SEARCH_KIND, CODE_TARGETS, ORIGIN_AGENT } from './amyConstants.js'

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function decisionUpper(d) {
  return String(d ?? '').trim().toUpperCase()
}

/** Build one Anya-shaped finding from a type + specifics. */
function makeFinding(type, { message, excerpt, evidence, severity }) {
  const target = CODE_TARGETS[type] || { file: 'backend/services/crawlerOsService.js', line: 1, severity: SEVERITY.MEDIUM, hint: '' }
  return {
    file: target.file,
    line: target.line,
    type,
    severity: severity || target.severity || SEVERITY.MEDIUM,
    message: message || target.hint,
    excerpt: excerpt || '',
    fixable: false, // Amy is diagnostic; Anya decides + applies the code fix.
    search_kind: SEARCH_KIND,
    evidence: evidence || {},
  }
}

function looksLikeFetchFailure(source) {
  const outcome = String(source?.outcome ?? '').toUpperCase()
  if (['ERROR', 'FETCH_ERROR', 'FAILED', 'FAIL'].includes(outcome)) return true
  const reason = String(source?.reason ?? '').toLowerCase()
  return /error|timeout|timed out|failed|forbidden|refused|unreachable|429|5\d\d|dns/.test(reason)
}

function looksLikeUrlIssue(source) {
  const reason = String(source?.reason ?? '').toLowerCase()
  return /\burl\b|\blink\b|invalid url|missing url|bad url|broken/.test(reason)
}

function looksLikeGeoIssue(text) {
  return /\bgeo\b|geograph|location|state|radius|out[- ]of[- ]state/.test(String(text ?? '').toLowerCase())
}

// Generic/directory-style titles that should NOT be high-confidence ACCEPTs for
// a specific synthetic profile — an ACCEPT here is a likely false positive.
const GENERIC_TITLE_RX =
  /\b(directory|resource (guide|center|finder)|funding finder|benefit finder|general (funding|assistance)|find (funding|grants|help)|grant search|search portal|list of|database of|portal)\b/i

function isGenericTitle(title) {
  return GENERIC_TITLE_RX.test(String(title ?? ''))
}

function normLower(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// Acronym of significant words ("Cleveland State Community College" -> "cscc")
// so a school referenced only by acronym still counts as recalled.
const RECALL_STOP = new Set(['of', 'the', 'and', 'at', 'for', 'a', 'an'])
function schoolAcronym(name) {
  const w = normLower(name).split(' ').filter((x) => x && !RECALL_STOP.has(x))
  return w.length >= 2 ? w.map((x) => x[0]).join('') : ''
}

/** True if any normalized title/sponsor references the school (full name or acronym). */
function titlesReference(normalizedTitles, school) {
  const n = normLower(school)
  if (!n || n.length < 3) return false
  const acr = schoolAcronym(school)
  const acrRx = acr && acr.length >= 2 ? new RegExp(`\\b${acr}\\b`) : null
  return normalizedTitles.some((t) => t.includes(n) || (acrRx && acrRx.test(t)))
}

/**
 * Evaluate one discovery result against a scenario. Pure function; no I/O.
 *
 * @param {object} scenario  - from generateScenarios()
 * @param {string} profileId
 * @param {object} result    - { run, persisted, thesis } from runProfileDiscoveryLive
 * @param {object} [opts]    - { error } when discovery threw
 * @returns {{ scenario_id, category, profile_id, status, stored, accepted, review, findings }}
 */
export function evaluateDiscovery(scenario, profileId, result, opts = {}) {
  const findings = []
  const baseEvidence = {
    scenario_id: scenario?.scenario_id,
    category: scenario?.category,
    label: scenario?.label,
    profile_id: profileId,
    run_id: result?.run?.run_id || opts.runId || null,
  }

  // Hard error path (discovery threw).
  if (opts.error) {
    findings.push(
      makeFinding(FINDING_TYPES.CRAWLER_EXCEPTION, {
        message: `Discovery threw for ${scenario?.label}: ${opts.error}`,
        excerpt: String(opts.error).slice(0, 220),
        evidence: { ...baseEvidence, error: String(opts.error) },
      }),
    )
    return { ...baseEvidence, status: 'error', stored: 0, accepted: 0, review: 0, findings }
  }

  const run = result?.run || {}

  // Lifecycle skip.
  if (run.skipped) {
    findings.push(
      makeFinding(FINDING_TYPES.DISCOVERY_SKIPPED, {
        message: `Discovery skipped for ${scenario?.label} (reason: ${run.reason || 'unknown'}).`,
        excerpt: `reason=${run.reason || 'unknown'}`,
        evidence: { ...baseEvidence, reason: run.reason },
      }),
    )
    return { ...baseEvidence, status: 'skipped', stored: 0, accepted: 0, review: 0, findings }
  }

  const sources = Array.isArray(run.sources) ? run.sources : []
  const stored = num(run.stored ?? result?.persisted?.opportunities)
  const recommendations = Array.isArray(run.recommendations) ? run.recommendations : []
  const accepted = recommendations.filter(
    (r) => decisionUpper(r.decision) === 'ACCEPT' || num(r.match_score) >= ACCEPT_SCORE,
  )
  const review = recommendations.filter(
    (r) => decisionUpper(r.decision) === 'REVIEW' || (num(r.match_score) >= REVIEW_SCORE && num(r.match_score) < ACCEPT_SCORE),
  )
  const topScore = recommendations.reduce((m, r) => Math.max(m, num(r.match_score)), 0)

  // Retain the scored candidates so the tuner can sweep the score floor across
  // the whole cohort WITHOUT re-crawling (the floor is applied after scoring).
  const candidates = recommendations.map((r) => ({
    score: num(r.match_score),
    decision: decisionUpper(r.decision),
    title: r.title ?? null,
    generic: isGenericTitle(r.title),
  }))

  // False positives / bad matches: a generic/directory-style result that the
  // engine ACCEPTED (or scored at/above ACCEPT) for a SPECIFIC profile.
  const falsePositives = candidates.filter(
    (c) => c.generic && (c.decision === 'ACCEPT' || c.score >= ACCEPT_SCORE),
  )
  if (falsePositives.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.FALSE_POSITIVE, {
        message: `${scenario.label}: ${falsePositives.length} generic/directory result(s) were ACCEPTED as strong matches (likely false positive).`,
        excerpt: falsePositives.map((c) => `${c.score}:${c.title}`).slice(0, 4).join('; '),
        evidence: { ...baseEvidence, false_positive_titles: falsePositives.map((c) => c.title).slice(0, 6) },
      }),
    )
  }

  // Profile-field mapping: a signal we set didn't reach the thesis.
  const thesis = result?.thesis || {}
  const thesisNeeds = Array.isArray(thesis.needs) ? thesis.needs : []
  const thesisTypes = Array.isArray(thesis.applicant_types) ? thesis.applicant_types : []
  const thesisState = thesis?.location?.state || null
  if (
    scenario?.expected &&
    (scenario.expected.needs?.length > 0) &&
    thesisNeeds.length === 0 &&
    thesisTypes.length === 0
  ) {
    findings.push(
      makeFinding(FINDING_TYPES.PROFILE_FIELD_MAPPING_MISS, {
        message: `Profile signals for ${scenario.label} did not flow into the discovery thesis (needs/types empty).`,
        excerpt: `expected needs=[${(scenario.expected.needs || []).join(', ')}] thesis needs=[] types=[]`,
        evidence: { ...baseEvidence, expected: scenario.expected, thesis_needs: thesisNeeds, thesis_types: thesisTypes },
      }),
    )
  }
  if (scenario?.expected?.state && !thesisState) {
    findings.push(
      makeFinding(FINDING_TYPES.GEO_RADIUS_ISSUE, {
        message: `Expected geographic state ${scenario.expected.state} did not reach the thesis location.`,
        excerpt: `expected_state=${scenario.expected.state} thesis_state=null`,
        evidence: { ...baseEvidence, expected_state: scenario.expected.state },
      }),
    )
  }

  // ── Institution / hyperlocal RECALL (crawler-intelligence signal) ──────────
  // The goal of the pipeline is smarter crawlers. A student committed to a named
  // school should get institution-specific scholarships; a profile with a county
  // should get hyperlocal awards. If the crawler stored results but NONE of them
  // reference the school / county, the open-web query breadth is the weakness —
  // route the finding at buildWebQueries so Anya/Sam evolve it. Only fires when
  // discovery actually produced candidates (else ZERO_RESULT already covers it).
  const recTitles = recommendations.map((r) => normLower(`${r.title || ''} ${r.sponsor || ''}`))
  const thesisSchools = Array.isArray(thesis.schools) ? thesis.schools.filter(Boolean) : []
  if (thesis.is_student && thesisSchools.length > 0 && recommendations.length > 0) {
    const missingSchools = thesisSchools.filter((s) => !titlesReference(recTitles, s))
    if (missingSchools.length === thesisSchools.length) {
      findings.push(
        makeFinding(FINDING_TYPES.INSTITUTION_RECALL_MISS, {
          message: `${scenario.label}: student committed to ${thesisSchools.join(', ')} but 0 of ${recommendations.length} results reference the school (no institution-specific scholarships found).`,
          excerpt: `schools=[${thesisSchools.join(' | ')}] field=${thesis.field_of_study || 'n/a'}`,
          evidence: { ...baseEvidence, schools: thesisSchools, field_of_study: thesis.field_of_study || null, results: recommendations.length },
        }),
      )
    }
  }
  const thesisCounty = thesis?.location?.county ? normLower(thesis.location.county).replace(/\b(county|parish|borough)\b/g, '').trim() : ''
  if (thesisCounty && recommendations.length > 0 && !recTitles.some((t) => t.includes(thesisCounty))) {
    findings.push(
      makeFinding(FINDING_TYPES.HYPERLOCAL_RECALL_MISS, {
        message: `${scenario.label}: profile in ${thesis.location.county} but 0 of ${recommendations.length} results are county/hyperlocal.`,
        excerpt: `county=${thesis.location.county}`,
        evidence: { ...baseEvidence, county: thesis.location.county, results: recommendations.length },
      }),
    )
  }

  // Source health.
  const failedSources = sources.filter(looksLikeFetchFailure)
  const urlIssueSources = sources.filter(looksLikeUrlIssue)
  if (failedSources.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.SOURCE_FETCH_FAILED, {
        message: `${failedSources.length}/${sources.length} planned source(s) failed for ${scenario.label}.`,
        excerpt: failedSources.map((s) => `${s.source_id}:${s.outcome || s.reason || '?'}`).slice(0, 6).join('; '),
        evidence: { ...baseEvidence, failed_sources: failedSources.map((s) => ({ id: s.source_id, outcome: s.outcome, reason: s.reason })) },
      }),
    )
  }
  if (urlIssueSources.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.URL_INVALID, {
        message: `Source(s) reported URL/link problems for ${scenario.label}.`,
        excerpt: urlIssueSources.map((s) => `${s.source_id}:${s.reason || '?'}`).slice(0, 6).join('; '),
        evidence: { ...baseEvidence, url_issue_sources: urlIssueSources.map((s) => ({ id: s.source_id, reason: s.reason })) },
      }),
    )
  }

  // Outcome classification.
  let status
  if (stored === 0) {
    status = 'zero'
    const zr = run.zero_result || {}
    const zReason = zr.zero_result_reason || zr.reason || 'no_opportunities_stored'
    findings.push(
      makeFinding(FINDING_TYPES.ZERO_RESULT, {
        message: `Zero opportunities stored for ${scenario.label} (reason: ${zReason}).`,
        excerpt: `reason=${zReason} missing=[${(zr.missing_profile_fields || []).join(', ')}]`,
        evidence: {
          ...baseEvidence,
          zero_result_reason: zReason,
          missing_profile_fields: zr.missing_profile_fields || [],
          excluded_sources: zr.excluded_sources || [],
          expansions_tried: zr.expansions_tried || [],
          searched_sources: zr.searched_sources || [],
        },
      }),
    )
    if (looksLikeGeoIssue(zReason)) {
      findings.push(
        makeFinding(FINDING_TYPES.GEO_RADIUS_ISSUE, {
          message: `Zero-result reason for ${scenario.label} points at geographic scoping.`,
          excerpt: `reason=${zReason}`,
          evidence: { ...baseEvidence, zero_result_reason: zReason },
        }),
      )
    }
  } else if (accepted.length === 0) {
    if (review.length > 0 || topScore >= REVIEW_SCORE) {
      status = 'weak'
      findings.push(
        makeFinding(FINDING_TYPES.WEAK_MATCH, {
          message: `${scenario.label}: ${stored} stored, but no ACCEPT — top score ${topScore} (review-band only).`,
          excerpt: `stored=${stored} accepted=0 review=${review.length} top_score=${topScore}`,
          evidence: { ...baseEvidence, stored, top_score: topScore, review: review.length },
        }),
      )
    } else {
      status = 'weak'
      findings.push(
        makeFinding(FINDING_TYPES.NO_QUALIFIED_MATCHES, {
          message: `${scenario.label}: ${stored} stored, but none reached the review/accept bands (top score ${topScore}).`,
          excerpt: `stored=${stored} top_score=${topScore}`,
          evidence: { ...baseEvidence, stored, top_score: topScore },
        }),
      )
    }
    if (topScore > 0 && topScore < DEFAULT_MIN_SCORE) {
      findings.push(
        makeFinding(FINDING_TYPES.SCORING_FLOOR_SUPPRESSION, {
          message: `${scenario.label}: best candidate (${topScore}) is below the pipeline floor (${DEFAULT_MIN_SCORE}); confirm the zero-result recovery ladder surfaces it.`,
          excerpt: `top_score=${topScore} floor=${DEFAULT_MIN_SCORE}`,
          evidence: { ...baseEvidence, top_score: topScore, floor: DEFAULT_MIN_SCORE },
        }),
      )
    }
  } else {
    status = 'ok'
  }

  return {
    ...baseEvidence,
    status,
    stored,
    accepted: accepted.length,
    review: review.length,
    top_score: topScore,
    sources_total: sources.length,
    sources_failed: failedSources.length,
    candidates,
    false_positives: falsePositives.length,
    findings,
  }
}

function tally(arr, keyFn) {
  const out = {}
  for (const item of arr) {
    const k = keyFn(item)
    if (k === undefined || k === null) continue
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * Assemble the full Anya handoff report from per-scenario evaluations.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {Array<object>} args.evaluations - from evaluateDiscovery()
 * @param {object} [args.meta] - { startedAt, completedAt, dryRun, options }
 * @returns {object} Anya-compatible report with amy_summary.
 */
export function buildAnyaHandoff({ runId, evaluations = [], meta = {} }) {
  const allFindings = []
  for (const ev of evaluations) {
    for (const f of ev.findings || []) allFindings.push(f)
  }

  const startedAt = meta.startedAt || new Date().toISOString()
  const completedAt = meta.completedAt || new Date().toISOString()
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))

  const filesWithFindings = new Set(allFindings.map((f) => f.file))
  const byFile = tally(allFindings, (f) => f.file)
  const recommendedFocus = Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .map(([file, count]) => ({ file, findings: count }))

  const amySummary = {
    scenarios_total: evaluations.length,
    by_status: tally(evaluations, (e) => e.status),
    by_category: tally(evaluations, (e) => e.category),
    by_finding_type: tally(allFindings, (f) => f.type),
    by_severity: tally(allFindings, (f) => f.severity),
    source_health: {
      scenarios_with_source_failures: evaluations.filter((e) => num(e.sources_failed) > 0).length,
    },
    recommended_focus: recommendedFocus,
  }

  return {
    // ── Anya report contract (mirrors runAutonomousCodeCrawl output) ──
    status: 'completed',
    generator: ORIGIN_AGENT,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    dry_run_requested: Boolean(meta.dryRun),
    dry_run_effective: Boolean(meta.dryRun),
    write_flag_enabled: false,
    files_discovered: filesWithFindings.size,
    files_scanned: 0,
    files_analyzed: 0,
    files_with_findings: filesWithFindings.size,
    findings_found: allFindings.length,
    findings_total: allFindings.length,
    findings: allFindings,
    findings_offset: 0,
    findings_limit: allFindings.length,
    findings_truncated: false,
    search_kind_breakdown: { [SEARCH_KIND]: allFindings.length },
    domain_audit_summary: null,
    errors: [],
    modifications: [],

    // ── Amy-specific handoff envelope ──
    handoff_from: 'amy',
    handoff_run_id: runId,
    handoff_options: meta.options || null,
    amy_summary: amySummary,
  }
}

/** Compact summary for CLI/run-log output. */
export function summarizeEvaluations(evaluations = []) {
  return {
    scenarios: evaluations.length,
    ok: evaluations.filter((e) => e.status === 'ok').length,
    weak: evaluations.filter((e) => e.status === 'weak').length,
    zero: evaluations.filter((e) => e.status === 'zero').length,
    skipped: evaluations.filter((e) => e.status === 'skipped').length,
    error: evaluations.filter((e) => e.status === 'error').length,
    total_findings: evaluations.reduce((n, e) => n + (e.findings?.length || 0), 0),
  }
}

export default { evaluateDiscovery, buildAnyaHandoff, summarizeEvaluations }
