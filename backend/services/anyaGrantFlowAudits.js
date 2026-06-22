// ---------------------------------------------------------------------------
// anyaGrantFlowAudits.js
//
// Domain-specific audits that go beyond generic code-smell scanning.  Each
// audit returns findings in a common shape (see AuditFinding below) and
// explicitly reports its own errors instead of swallowing them, so the
// autonomous crawler can surface partial failures.
//
// Audits implemented:
//   1. opportunity_url_validity   - check opportunities in DB have parseable
//                                   URLs (format only, no network calls)
//   2. matching_coverage          - verify matchEngine.js / matching.js touch
//                                   every profile field listed in the
//                                   canonical profile schema
//   3. fallback_logic             - static scan of matching.js for the
//                                   zero-result fallback guard
//   4. ui_backend_consistency     - static scan: routes that return
//                                   `total_found` must also return at least
//                                   one included result (or explicit fatal
//                                   error), matching the user rule
//                                   "total_found > 0 and included === 0 is a
//                                   bug"
//   5. anya_grounding             - if DB is available, verify Anya
//                                   autonomous runs log to the audit table
//                                   so outputs can be traced to real events
//
// Every finding has search_kind = 'domain_audit' when re-emitted from
// anyaAutonomousCrawler.js.
// ---------------------------------------------------------------------------

import path from 'path'
import { promises as fs } from 'fs'
import {
  isValidRealUrl,
  isLoanLike,
  isExpired,
  isPlaceholderOpportunity,
  getPlaceholderHostnames,
} from './shared/opportunityPolicy.js'

/**
 * @typedef {Object} AuditFinding
 * @property {string} audit          - stable id of the audit that produced it
 * @property {string} type            - short issue-type slug
 * @property {'low'|'medium'|'high'} severity
 * @property {string} message         - human-readable description
 * @property {string} [file]          - optional path to the relevant file
 * @property {number} [line]          - optional line number
 * @property {string} [excerpt]       - optional short code excerpt
 * @property {Object} [evidence]      - structured data the caller can inspect
 */

// Canonical profile fields that the matching engine MUST consider. Derived
// from the database profile schema. If you add a column, add it here too.
const CANONICAL_PROFILE_FIELDS = [
  'state',
  'city',
  'county',
  'country',
  'industry',
  'employee_count',
  'annual_revenue',
  'years_in_operation',
  'veteran_owned',
  'woman_owned',
  'minority_owned',
  'rural',
  'organization_type',
  'population_served',
  'mission_focus',
]

// Canonical top-level profile *sections* (JSON payload keys). If matching code
// never references any of these, it is almost certainly ignoring that whole
// section of user-supplied profile data.
const CANONICAL_PROFILE_SECTIONS = [
  'basic_information',
  'organization_details',
  'location_focus',
  'programs_services',
  'funding_needs',
  'financial_information',
  'demographics',
  'comprehensive_application',
]

async function readFileSafe(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

async function dbAll(db, sql, params = []) {
  if (typeof db?.query === 'function') {
    const result = await db.query(sql, params)
    return Array.isArray(result) ? result : (result?.rows || [])
  }
  if (typeof db?.prepare === 'function') {
    const preparedSql = db?.dialect === 'postgres'
      ? sql
      : sql
        .replace(/COUNT\(\*\)::int/gi, 'COUNT(*)')
        .replace(/\bis_active\s*=\s*true\b/gi, 'is_active = 1')
        .replace(/NOW\(\)\s*-\s*INTERVAL\s*'30 days'/gi, "datetime('now', '-30 days')")
    const result = await db.prepare(preparedSql).all(...params)
    return Array.isArray(result) ? result : (result?.rows || [])
  }
  throw new Error('Unsupported DB client: expected query() or prepare()')
}

// ---------------------------------------------------------------------------
// 1. Opportunity URL validity
// ---------------------------------------------------------------------------
async function auditOpportunityUrls({ db }) {
  const findings = []
  const errors = []
  if (!db) {
    errors.push({ audit: 'opportunity_url_validity', message: 'db_unavailable: skipped' })
    return { findings, errors, checked: 0 }
  }

  let rows = []
  try {
    rows = await dbAll(
      db,
      `SELECT id, title, application_url
         FROM funding_opportunities
        WHERE application_url IS NOT NULL AND application_url <> ''
        LIMIT 2000`,
    )
  } catch (err) {
    errors.push({ audit: 'opportunity_url_validity', message: `query_failed: ${err?.message || String(err)}` })
    return { findings, errors, checked: 0 }
  }

  const placeholderHosts = getPlaceholderHostnames()
  for (const row of rows) {
    const url = String(row.application_url || '').trim()
    let valid = false
    let reason = 'unparseable'
    let type = 'invalid_opportunity_url'
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        reason = `non_http_protocol:${u.protocol}`
      } else if (
        placeholderHosts.includes(u.hostname.toLowerCase()) ||
        placeholderHosts.some((ph) => u.hostname.toLowerCase().endsWith('.' + ph))
      ) {
        reason = `placeholder_host:${u.hostname}`
        type = 'placeholder_opportunity_url'
      } else if (!isValidRealUrl(url)) {
        reason = 'rejected_by_policy'
        type = 'placeholder_opportunity_url'
      } else {
        valid = true
      }
    } catch (err) {
      reason = `invalid_url:${err?.message || 'parse_error'}`
    }
    if (!valid) {
      findings.push({
        audit: 'opportunity_url_validity',
        type,
        severity: 'high',
        message: `Opportunity #${row.id} has invalid application_url (${reason}).`,
        evidence: { id: row.id, title: row.title, url, reason },
      })
    }
  }

  return { findings, errors, checked: rows.length }
}

// ---------------------------------------------------------------------------
// 6. Expired opportunity labeling
//    Opportunities whose deadline has passed but which are still is_active=true
//    are a visible source of user distrust. Flag each one.
// ---------------------------------------------------------------------------
async function auditExpiredOpportunityLabeling({ db }) {
  const findings = []
  const errors = []
  if (!db) {
    errors.push({ audit: 'expired_opportunity_labeling', message: 'db_unavailable: skipped' })
    return { findings, errors, checked: 0 }
  }

  let rows = []
  try {
    const deadlineNotEmptyClause = db?.dialect === 'postgres' ? '' : "AND deadline <> ''"
    rows = await dbAll(
      db,
      `SELECT id, title, deadline, deadline_type, is_active
         FROM funding_opportunities
        WHERE is_active = true
          AND deadline IS NOT NULL
          ${deadlineNotEmptyClause}
          AND COALESCE(deadline_type, '') <> 'rolling'
        LIMIT 5000`,
    )
  } catch (err) {
    errors.push({
      audit: 'expired_opportunity_labeling',
      message: `query_failed: ${err?.message || String(err)}`,
    })
    return { findings, errors, checked: 0 }
  }

  let expiredCount = 0
  for (const row of rows) {
    if (isExpired(row)) {
      expiredCount += 1
      findings.push({
        audit: 'expired_opportunity_labeling',
        type: 'expired_but_active',
        severity: 'high',
        message: `Opportunity #${row.id} deadline has passed (${row.deadline}) but is_active=true.`,
        evidence: { id: row.id, title: row.title, deadline: row.deadline },
      })
    }
  }
  return { findings, errors, checked: rows.length, expired: expiredCount }
}

// ---------------------------------------------------------------------------
// 7. Loan visibility vs. canonical policy
//    The canonical policy rejects loan-like products. If any opportunity is
//    still active and matches isLoanLike(), it will be surfaced to users who
//    have disallowed loans and must be flagged for cleanup.
// ---------------------------------------------------------------------------
async function auditLoanVisibility({ db }) {
  const findings = []
  const errors = []
  if (!db) {
    errors.push({ audit: 'loan_visibility_vs_policy', message: 'db_unavailable: skipped' })
    return { findings, errors, checked: 0 }
  }

  let rows = []
  try {
    rows = await dbAll(
      db,
      `SELECT id, title, description, opportunity_type,
              eligibility_bullets AS eligibility,
              geo_eligibility AS eligibility_criteria,
              is_loan
         FROM funding_opportunities
        WHERE is_active = true
        LIMIT 5000`,
    )
  } catch (err) {
    errors.push({
      audit: 'loan_visibility_vs_policy',
      message: `query_failed: ${err?.message || String(err)}`,
    })
    return { findings, errors, checked: 0 }
  }

  let loanLikeCount = 0
  for (const row of rows) {
    if (isLoanLike(row)) {
      loanLikeCount += 1
      findings.push({
        audit: 'loan_visibility_vs_policy',
        type: 'active_loan_like_opportunity',
        severity: 'high',
        message: `Opportunity #${row.id} is loan-like per policy but is still active (disallowed for loan-averse profiles).`,
        evidence: { id: row.id, title: row.title, opportunity_type: row.opportunity_type },
      })
    }
    if (isPlaceholderOpportunity(row)) {
      findings.push({
        audit: 'loan_visibility_vs_policy',
        type: 'active_placeholder_opportunity',
        severity: 'medium',
        message: `Opportunity #${row.id} looks like placeholder/stub content but is active.`,
        evidence: { id: row.id, title: row.title },
      })
    }
  }

  return { findings, errors, checked: rows.length, loan_like: loanLikeCount }
}

// ---------------------------------------------------------------------------
// 8. Ignored profile sections
//    Extends matching_coverage to the high-level JSON sections of the profile
//    payload. A section that is never referenced in matching code means every
//    answer inside it is silently discarded.
// ---------------------------------------------------------------------------
async function auditIgnoredProfileSections({ rootDir }) {
  const findings = []
  const errors = []

  const candidates = [
    path.join(rootDir, 'backend', 'services', 'matchEngine.js'),
    path.join(rootDir, 'backend', 'services', 'matching.js'),
    path.join(rootDir, 'backend', 'services', 'relevanceFilter.js'),
    path.join(rootDir, 'backend', 'services', 'relevanceFilterRules.js'),
    path.join(rootDir, 'backend', 'services', 'matchDecisionEngine.js'),
  ]

  const sources = []
  for (const candidate of candidates) {
    const text = await readFileSafe(candidate)
    if ((text !== null && text !== undefined)) sources.push({ file: candidate, text })
  }
  if (sources.length === 0) {
    errors.push({ audit: 'ignored_profile_sections', message: 'no_matching_sources_found' })
    return { findings, errors, checked: 0 }
  }

  const combinedText = sources.map((s) => s.text).join('\n')
  const missingSections = []
  for (const section of CANONICAL_PROFILE_SECTIONS) {
    const variants = [
      new RegExp(`\\b${section}\\b`, 'i'),
      new RegExp(`['"\`]${section}['"\`]`, 'i'),
    ]
    if (!variants.some((rx) => rx.test(combinedText))) {
      missingSections.push(section)
    }
  }

  if (missingSections.length > 0) {
    findings.push({
      audit: 'ignored_profile_sections',
      type: 'profile_section_ignored_by_matcher',
      severity: 'high',
      message: `Matching engine never references ${missingSections.length} canonical profile section(s).`,
      file: 'backend/services/matchEngine.js',
      evidence: {
        missing_sections: missingSections,
        sources_scanned: sources.map((s) => s.file),
      },
    })
  }

  return {
    findings,
    errors,
    checked: CANONICAL_PROFILE_SECTIONS.length,
    missing_sections: missingSections,
  }
}

// ---------------------------------------------------------------------------
// 9. Zero-result fallback presence in route handlers
//    Extends fallback_logic to static-scan every route that returns
//    total_found for an explicit "if total_found > 0 and included === 0,
//    relax/fallback" guard. The user rule explicitly forbids silent zero.
// ---------------------------------------------------------------------------
async function auditZeroResultFallbackInRoutes({ rootDir }) {
  const findings = []
  const errors = []
  const routesDir = path.join(rootDir, 'backend', 'routes')

  let routeFiles = []
  try {
    routeFiles = (await fs.readdir(routesDir)).filter((f) => f.endsWith('.js'))
  } catch (err) {
    errors.push({ audit: 'zero_result_fallback_routes', message: `routes_dir_unreadable:${err?.message}` })
    return { findings, errors }
  }

  const guardRx = /(relax|fallback|widen|expand|broaden|guaranteed|neighboring|nearby|national|included\s*===?\s*0|no[_\s-]?results)/i

  for (const rel of routeFiles) {
    const full = path.join(routesDir, rel)
    const text = await readFileSafe(full)
    if ((text === null || text === undefined)) continue
    if (!/\btotal_found\b/.test(text)) continue
    if (guardRx.test(text)) continue
    findings.push({
      audit: 'zero_result_fallback_routes',
      type: 'route_without_zero_result_fallback',
      severity: 'medium',
      message: `Route ${rel} emits total_found without any visible fallback/relaxation branch.`,
      file: `backend/routes/${rel}`,
    })
  }

  return { findings, errors, checked: routeFiles.length }
}

// ---------------------------------------------------------------------------
// 2. Matching coverage across profile fields
// ---------------------------------------------------------------------------
async function auditMatchingCoverage({ rootDir }) {
  const findings = []
  const errors = []

  const candidates = [
    path.join(rootDir, 'backend', 'services', 'matchEngine.js'),
    path.join(rootDir, 'backend', 'services', 'matching.js'),
    path.join(rootDir, 'backend', 'services', 'relevanceFilter.js'),
  ]

  const sources = []
  for (const candidate of candidates) {
    const text = await readFileSafe(candidate)
    if ((text !== null && text !== undefined)) sources.push({ file: candidate, text })
  }

  if (sources.length === 0) {
    errors.push({ audit: 'matching_coverage', message: 'no_matching_sources_found' })
    return { findings, errors, checked: 0 }
  }

  const combinedText = sources.map((s) => s.text).join('\n')
  const missing = []
  for (const field of CANONICAL_PROFILE_FIELDS) {
    // Look for the field identifier in any combination: direct access, bracket
    // string, or destructured binding.
    const variants = [
      new RegExp(`\\b${field}\\b`, 'i'),
      new RegExp(`['"\`]${field}['"\`]`, 'i'),
    ]
    const hit = variants.some((re) => re.test(combinedText))
    if (!hit) missing.push(field)
  }

  if (missing.length > 0) {
    findings.push({
      audit: 'matching_coverage',
      type: 'matching_coverage_gap',
      severity: 'high',
      message: `Matching engine does not reference ${missing.length} canonical profile field(s).`,
      file: 'backend/services/matchEngine.js',
      evidence: { missing_fields: missing, sources_scanned: sources.map((s) => s.file) },
    })
  }

  return { findings, errors, checked: CANONICAL_PROFILE_FIELDS.length, missing }
}

// ---------------------------------------------------------------------------
// 3. Fallback logic for zero results
// ---------------------------------------------------------------------------
async function auditFallbackLogic({ rootDir }) {
  const findings = []
  const errors = []
  const candidates = [
    path.join(rootDir, 'backend', 'services', 'matchEngine.js'),
    path.join(rootDir, 'backend', 'matching'),
    path.join(rootDir, 'backend', 'services', 'relevanceFilter.js'),
  ]
  let text = null
  let selectedFile = null
  for (const candidate of candidates) {
    const statText = await readFileSafe(candidate)
    if (statText !== null && statText !== undefined) {
      text = statText
      selectedFile = candidate
      break
    }
  }
  if ((text === null || text === undefined)) {
    errors.push({ audit: 'fallback_logic', message: `missing_file:${candidates.map((f) => path.relative(rootDir, f)).join('|')}` })
    return { findings, errors }
  }

  // Look for a relaxation / fallback guard. The exact implementation may
  // differ but must exist: the project user rules state "Zero results is a
  // failure state, not an acceptable outcome" and require relaxation when
  // total_found > 0 and included === 0.
  const hasRelaxGuard = /(relax|fallback|guaranteed|included\s*===?\s*0|total_found\s*>\s*0)/i.test(text)
  if (!hasRelaxGuard) {
    findings.push({
      audit: 'fallback_logic',
      type: 'missing_zero_result_fallback',
      severity: 'high',
      message: `${path.relative(rootDir, selectedFile)} does not appear to implement a zero-result relaxation fallback.`,
      file: path.relative(rootDir, selectedFile).replace(/\\/g, '/'),
    })
  }

  return { findings, errors }
}

// ---------------------------------------------------------------------------
// 4. UI / backend consistency
// ---------------------------------------------------------------------------
async function auditUiBackendConsistency({ rootDir }) {
  const findings = []
  const errors = []
  const routesDir = path.join(rootDir, 'backend', 'routes')

  let routeFiles = []
  try {
    routeFiles = (await fs.readdir(routesDir)).filter((f) => f.endsWith('.js'))
  } catch (err) {
    errors.push({ audit: 'ui_backend_consistency', message: `routes_dir_unreadable:${err?.message}` })
    return { findings, errors }
  }

  for (const rel of routeFiles) {
    const full = path.join(routesDir, rel)
    const text = await readFileSafe(full)
    if ((text === null || text === undefined)) continue
    // Heuristic: if a route reports total_found, it should also return a
    // matches/results/opportunities/included array. Otherwise the user rule
    // "Counts displayed in the UI must map 1:1 to backend response fields"
    // can be silently violated.
    const hasTotalFound = /\btotal_found\b/.test(text)
    if (!hasTotalFound) continue
    const hasResultsArray = /\b(matches|results|opportunities|included|items)\b\s*[:=]/.test(text)
    if (!hasResultsArray) {
      findings.push({
        audit: 'ui_backend_consistency',
        type: 'total_found_without_results_array',
        severity: 'medium',
        message: `Route file ${rel} returns total_found without a clearly named results array -- UI counts may not map 1:1.`,
        file: `backend/routes/${rel}`,
      })
    }
  }

  return { findings, errors }
}

// ---------------------------------------------------------------------------
// 5. Anya grounding: autonomous runs must be traceable in the audit log
// ---------------------------------------------------------------------------
async function auditAnyaGrounding({ db }) {
  const findings = []
  const errors = []
  if (!db) {
    errors.push({ audit: 'anya_grounding', message: 'db_unavailable: skipped' })
    return { findings, errors }
  }

  let row
  try {
    const rows = await dbAll(
      db,
      `SELECT COUNT(*)::int AS n
         FROM audit_logs
        WHERE category = 'anya'
          AND action LIKE 'autonomous.%'
          AND created_at > NOW() - INTERVAL '30 days'`,
    )
    row = rows?.[0]
  } catch (err) {
    errors.push({ audit: 'anya_grounding', message: `query_failed:${err?.message || String(err)}` })
    return { findings, errors }
  }

  const n = Number(row?.n ?? 0)
  if (n === 0) {
    findings.push({
      audit: 'anya_grounding',
      type: 'anya_has_no_grounded_events',
      severity: 'medium',
      message: 'No Anya autonomous events recorded in audit_logs in the last 30 days -- Anya outputs may not be grounded in real system state.',
      evidence: { recent_events_30d: 0 },
    })
  }

  return { findings, errors, recent_events_30d: n }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all GrantFlow-specific domain audits.
 * @param {Object} args
 * @param {string} args.rootDir         - repo root (for static scans)
 * @param {Object|null} args.db         - optional db client (pg.Pool-like)
 * @param {string[]} args.scannedFiles  - files already scanned (informational)
 * @returns {Promise<{ findings: AuditFinding[], errors: Array, summary: Object }>}
 */
export async function runGrantFlowDomainAudits({ rootDir, db = null, scannedFiles = [] }) {
  const allFindings = []
  const allErrors = []
  const summary = {
    audits_run: [],
    audits_failed: [],
    db_available: Boolean(db),
    scanned_files_input: scannedFiles.length,
  }

  async function runOne(id, fn) {
    summary.audits_run.push(id)
    try {
      const result = await fn()
      allFindings.push(...(result.findings || []))
      allErrors.push(...(result.errors || []))
      return result
    } catch (err) {
      allErrors.push({ audit: id, message: err?.message || String(err) })
      summary.audits_failed.push(id)
      return null
    }
  }

  const opportunityResult = await runOne('opportunity_url_validity', () => auditOpportunityUrls({ db }))
  const matchingResult = await runOne('matching_coverage', () => auditMatchingCoverage({ rootDir }))
  const fallbackResult = await runOne('fallback_logic', () => auditFallbackLogic({ rootDir }))
  const uiResult = await runOne('ui_backend_consistency', () => auditUiBackendConsistency({ rootDir }))
  const groundingResult = await runOne('anya_grounding', () => auditAnyaGrounding({ db }))
  const expiredResult = await runOne('expired_opportunity_labeling', () =>
    auditExpiredOpportunityLabeling({ db }),
  )
  const loanResult = await runOne('loan_visibility_vs_policy', () => auditLoanVisibility({ db }))
  const sectionResult = await runOne('ignored_profile_sections', () =>
    auditIgnoredProfileSections({ rootDir }),
  )
  const routeFallbackResult = await runOne('zero_result_fallback_routes', () =>
    auditZeroResultFallbackInRoutes({ rootDir }),
  )

  summary.opportunity_urls_checked = opportunityResult?.checked ?? 0
  summary.matching_fields_checked = matchingResult?.checked ?? 0
  summary.matching_missing_fields = matchingResult?.missing ?? []
  summary.anya_recent_events_30d = groundingResult?.recent_events_30d ?? 0
  summary.expired_opportunities_flagged = expiredResult?.expired ?? 0
  summary.active_loan_like_opportunities = loanResult?.loan_like ?? 0
  summary.profile_sections_missing = sectionResult?.missing_sections ?? []
  summary.routes_scanned_for_fallback = routeFallbackResult?.checked ?? 0
  summary.findings_total = allFindings.length
  summary.errors_total = allErrors.length
  void fallbackResult
  void uiResult

  return { findings: allFindings, errors: allErrors, summary }
}

export const _internal_for_tests = {
  auditOpportunityUrls,
  auditMatchingCoverage,
  auditFallbackLogic,
  auditUiBackendConsistency,
  auditAnyaGrounding,
  auditExpiredOpportunityLabeling,
  auditLoanVisibility,
  auditIgnoredProfileSections,
  auditZeroResultFallbackInRoutes,
  CANONICAL_PROFILE_FIELDS,
  CANONICAL_PROFILE_SECTIONS,
}
