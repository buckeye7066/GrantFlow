/**
 * profileResultCoverageAudit.js — the self-audit the Amy/Anya/Sam pipeline was
 * MISSING: a per-profile check of RESULT coverage (are the right sources actually
 * being found and shown?), as opposed to profile COMPLETENESS (profileCoverage.js)
 * or PLANNER coverage (crawlerPlanService.auditCrawlerCoverage — "which sources
 * SHOULD fire").
 *
 * It detects the exact defect classes that previously went silent:
 *
 *   1. SURFACING REGRESSION — matches persisted for a profile in a matcher_version
 *      that the read paths DON'T surface. This is precisely the bug where 82
 *      real 'web-llm' scholarships sat in the DB but the profile showed ~8. It is
 *      a CODE bug (a new matcher_version added to a writer but not to
 *      config/matchSurfacing.js), so it is flagged for a human/Sam — a re-crawl
 *      cannot fix it.
 *
 *   2. INSTITUTION GAP — a student with a named, committed school but ZERO
 *      surfaced matches referencing that school. Institutional endowments /
 *      departmental scholarships are findable only by name; a gap here means the
 *      open-web lane should re-run with the institution queries.
 *
 *   3. HYPERLOCAL GAP — a profile with a county but ZERO surfaced county/local
 *      matches.
 *
 *   4. LOW / ZERO RESULTS — fewer than a healthy minimum of surfaced matches.
 *
 * Gaps 2-4 are REMEDIABLE by re-running discovery (now that buildWebQueries emits
 * institution/employer/county queries), so the sweep can self-heal a bounded
 * number of the worst profiles each night. Gap 1 is code-level and is reported,
 * never "healed" by a crawl.
 *
 * Pure detection is separated from I/O so it is unit-testable with fixtures.
 */

import { DEFAULT_MIN_SCORE } from '../../config/matchThresholds.js'
import { SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay } from '../../config/matchSurfacing.js'
import { isStudentAidOpportunity } from '../matchEngine.js'
import { createLogger } from '../../utils/logger.js'

/** Needs that mean a profile legitimately WANTS student aid (engine's carve-out). */
const STUDENT_AID_NEEDS = ['student_aid', 'cost_of_attendance', 'scholarship']

const log = createLogger('coverage:resultAudit')

/** Fewer than this many surfaced, qualifying matches is "low coverage". */
export const MIN_HEALTHY_SURFACED = 3

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Acronym of the significant words in a school name ("Middle Tennessee State
// University" -> "mtsu"), so a match referenced only by acronym still counts and
// we don't re-crawl the same profile forever.
const STOP_WORDS = new Set(['of', 'the', 'and', 'at', 'for', 'a', 'an'])
function acronym(name) {
  const words = norm(name).split(' ').filter((w) => w && !STOP_WORDS.has(w))
  if (words.length < 2) return ''
  return words.map((w) => w[0]).join('')
}

/** Does any surfaced-row haystack reference this school (by full name or acronym)? */
function anyRowReferences(rows, needle) {
  const n = norm(needle)
  if (!n || n.length < 3) return false
  const acr = acronym(needle)
  return rows.some((r) => {
    const hay = norm(`${r.title || ''} ${r.sponsor || ''}`)
    if (hay.includes(n)) return true
    if (acr && acr.length >= 2 && new RegExp(`\\b${acr}\\b`).test(hay)) return true
    return false
  })
}

/** Bare county → distinctive token ("Bradley County" -> "bradley"). */
function countyToken(county) {
  return norm(county).replace(/\b(county|parish|borough)\b/g, '').trim()
}

/**
 * auditProfileResultCoverageFromData — PURE. Given the already-fetched rows +
 * thesis + counts, compute the coverage gaps. No I/O; unit-testable.
 *
 * @param {object} input
 * @param {string} input.profileId
 * @param {Array<{match_score:number, match_decision:string, is_directory?:boolean, title?:string, sponsor?:string}>} input.surfacedRows
 * @param {number} input.unsurfacedCount   matches in NON-surfaced matcher_versions
 * @param {object} input.thesis            { is_student, schools[], location:{county} }
 * @param {number} [input.floor]
 */
export function auditProfileResultCoverageFromData({ profileId, surfacedRows = [], unsurfacedCount = 0, thesis = {}, floor = DEFAULT_MIN_SCORE }) {
  const qualifying = surfacedRows.filter((r) => qualifiesForDisplay(r, floor))
  const gaps = []

  // 1. Surfacing regression (CODE bug — not crawl-remediable).
  const surfacing_gap = Number(unsurfacedCount) > 0
  if (surfacing_gap) gaps.push(`surfacing_regression:${unsurfacedCount}_matches_in_unsurfaced_version`)

  // 2. Institution gap (students with named schools).
  const schools = Array.isArray(thesis.schools) ? thesis.schools.filter(Boolean) : []
  const missing_schools = thesis.is_student
    ? schools.filter((s) => !anyRowReferences(qualifying, s))
    : []
  const institution_gap = thesis.is_student && schools.length > 0 && missing_schools.length === schools.length
  if (institution_gap) gaps.push(`institution_gap:${missing_schools.slice(0, 3).join('|')}`)

  // 3. Hyperlocal gap (county present, no county/local match).
  const countyTok = thesis.location?.county ? countyToken(thesis.location.county) : ''
  const hyperlocal_gap = Boolean(countyTok) && !qualifying.some((r) => norm(`${r.title || ''} ${r.sponsor || ''}`).includes(countyTok))
  if (hyperlocal_gap) gaps.push(`hyperlocal_gap:${countyTok}`)

  // 4. Low / zero results.
  const low_results = qualifying.length < MIN_HEALTHY_SURFACED
  if (low_results) gaps.push(`low_results:${qualifying.length}`)

  // 5. Ineligible surfaced match — a student-aid opportunity (TN HOPE, FAFSA,
  //    Pell, TSAA, foundation scholarships…) surfacing to a NON-student profile
  //    that does not declare a student-aid need. This is the "senior widow with
  //    student scholarships" defect: the engine already caps these below the
  //    floor for a fresh score, but a STALE persisted ACCEPT (e.g. a web-llm row
  //    the reconcile never re-scores) keeps them visible. Like a surfacing
  //    regression it is NOT crawl-remediable — the `student_aid_eligibility` boot
  //    invariant demotes them; here we OBSERVE so Sam/Anya can see the class and
  //    confirm the heal. Condition mirrors the engine's own cap arm.
  const wantsStudentAid = Array.isArray(thesis.needs) && thesis.needs.some((n) => STUDENT_AID_NEEDS.includes(String(n)))
  const ineligibleAidRows = (!thesis.is_student && !wantsStudentAid)
    ? qualifying.filter((r) => !r.is_directory && isStudentAidOpportunity({ title: r.title, description: r.description, categories: r.categories }, null))
    : []
  const ineligible_surfaced_match = ineligibleAidRows.length > 0
  if (ineligible_surfaced_match) {
    gaps.push(`ineligible_surfaced_match:student_aid_on_nonstudent:${ineligibleAidRows.length}`)
  }

  // Re-discovery can only fix acquisition gaps (2-4), never a code-level
  // surfacing regression or a stale-decision eligibility defect (5).
  const needs_rediscovery = institution_gap || hyperlocal_gap || low_results

  return {
    profile_id: profileId,
    surfaced_qualifying: qualifying.length,
    surfaced_total: surfacedRows.length,
    unsurfaced_count: Number(unsurfacedCount) || 0,
    surfacing_gap,
    institution_gap,
    missing_schools,
    hyperlocal_gap,
    low_results,
    ineligible_surfaced_match,
    ineligible_aid_count: ineligibleAidRows.length,
    needs_rediscovery,
    gaps,
    has_gap: gaps.length > 0,
  }
}

/**
 * auditProfileResultCoverage — DB-bound single-profile audit.
 */
export async function auditProfileResultCoverage(db, profileId, { floor = DEFAULT_MIN_SCORE, thesis = null } = {}) {
  const isPg = db?.dialect === 'postgres'
  const activeClause = isPg
    ? '(o.is_active IS NULL OR o.is_active = TRUE)'
    : '(o.is_active IS NULL OR o.is_active = 1)'

  const surfacedRows = await db
    .prepare(
      `SELECT m.match_score, m.match_decision, o.title, o.sponsor, o.description, o.categories,
              (UPPER(COALESCE(o.opportunity_kind,'')) IN ('DIRECTORY','PAST_AWARD_INTEL')) AS is_directory
         FROM profile_opportunity_matches m
         JOIN funding_opportunities o ON o.id = m.opportunity_id
        WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND ${activeClause}`,
    )
    .all(profileId)

  let unsurfacedCount = 0
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM profile_opportunity_matches
          WHERE profile_id = ? AND matcher_version NOT IN ${SURFACED_MATCHER_VERSIONS_SQL}`,
      )
      .get(profileId)
    unsurfacedCount = Number(row?.c ?? 0)
  } catch {
    unsurfacedCount = 0
  }

  let effThesis = thesis
  if (!effThesis) {
    try {
      const { buildThesisForProfile } = await import('../crawlerOsService.js')
      effThesis = await buildThesisForProfile(db, profileId)
    } catch {
      effThesis = null
    }
  }

  // Normalize the is_directory flag (SQL boolean → JS boolean).
  const rows = surfacedRows.map((r) => ({ ...r, is_directory: r.is_directory === true || Number(r.is_directory) === 1 }))

  return auditProfileResultCoverageFromData({
    profileId,
    surfacedRows: rows,
    unsurfacedCount,
    thesis: effThesis || {},
    floor,
  })
}

/**
 * auditAllProfilesResultCoverage — sweep every REAL, active profile (synthetic
 * Amy training profiles are excluded — they are reaped, not remediated). Returns
 * per-profile audits + an aggregate summary. Read-only.
 */
export async function auditAllProfilesResultCoverage(db, { limit = 500, floor = DEFAULT_MIN_SCORE } = {}) {
  const isPg = db?.dialect === 'postgres'
  const limitClause = isPg ? 'LIMIT $1' : 'LIMIT ?'
  let profiles = []
  try {
    profiles = await db
      .prepare(
        `SELECT p.id, p.display_name
           FROM profiles p
          WHERE (p.status = 'active' OR p.status IS NULL)
            AND p.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM profile_sections ps
               WHERE ps.profile_id = p.id AND ps.section_key = 'amy_metadata'
            )
          ORDER BY p.created_at DESC ${limitClause}`,
      )
      .all(limit)
  } catch (err) {
    // deleted_at column may be absent on older schemas — retry without it.
    profiles = await db
      .prepare(
        `SELECT p.id, p.display_name FROM profiles p
          WHERE (p.status = 'active' OR p.status IS NULL)
            AND NOT EXISTS (SELECT 1 FROM profile_sections ps WHERE ps.profile_id = p.id AND ps.section_key = 'amy_metadata')
          ORDER BY p.created_at DESC ${limitClause}`,
      )
      .all(limit)
  }

  const audits = []
  for (const p of profiles) {
    try {
      const a = await auditProfileResultCoverage(db, p.id, { floor })
      audits.push({ ...a, display_name: p.display_name ?? null })
    } catch (err) {
      log.warn('per-profile coverage audit failed (non-fatal)', { profile: p.id, error: err?.message })
    }
  }

  const summary = {
    scanned: audits.length,
    with_gap: audits.filter((a) => a.has_gap).length,
    surfacing_regressions: audits.filter((a) => a.surfacing_gap).length,
    institution_gaps: audits.filter((a) => a.institution_gap).length,
    hyperlocal_gaps: audits.filter((a) => a.hyperlocal_gap).length,
    low_results: audits.filter((a) => a.low_results).length,
    ineligible_surfaced_matches: audits.filter((a) => a.ineligible_surfaced_match).length,
    needs_rediscovery: audits.filter((a) => a.needs_rediscovery).length,
  }
  return { audits, summary }
}

// ── Observability: persist the last sweep to system_kv (Agent Observability
// Rule) so Sam diagnostics + Anya's owner tools can SEE what the sweep found. ──
const KV_KEY = 'coverage_audit_last_run'

async function recordCoverageSweep(db, payload) {
  if (!db?.prepare) return
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const now = new Date().toISOString()
    const value = JSON.stringify({ ...payload, recorded_at: now })
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, now, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, now)
    }
  } catch (err) {
    log.warn('could not persist coverage sweep (non-fatal)', { error: err?.message })
  }
}

/** Read the last recorded coverage sweep (for Sam diagnostics / Anya). */
export async function getLastCoverageSweep(db) {
  if (!db?.prepare) return null
  try {
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return { ...parsed, updated_at: row.updated_at ?? parsed.recorded_at ?? null }
  } catch {
    return null
  }
}

export function isCoverageAutohealEnabled() {
  return String(process.env.COVERAGE_AUTOHEAL_ENABLED ?? 'true').toLowerCase() !== 'false'
}

/**
 * runProfileCoverageSweep — the pipeline entry point (called from the nightly
 * sweep, and callable by Anya/Sam). Audits all real profiles, records the result
 * for observability, records low-coverage telemetry, and — bounded + gated —
 * self-heals the worst REMEDIABLE profiles by re-running discovery (which now
 * issues the institution/employer/county queries).
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.autoheal]  default from COVERAGE_AUTOHEAL_ENABLED (on).
 * @param {number}  [opts.maxHeal]   default COVERAGE_AUTOHEAL_MAX or 5.
 * @param {number}  [opts.limit]     profiles to scan.
 */
export async function runProfileCoverageSweep(db, { autoheal = isCoverageAutohealEnabled(), maxHeal = Number(process.env.COVERAGE_AUTOHEAL_MAX) || 5, limit = 500 } = {}) {
  // Heal the ineligible-surfaced-match class (student-aid on a non-student) FIRST,
  // via the same choke-point invariant boot uses, so the audit below reflects the
  // post-heal state and Sam/Anya see a clean count. This is a decision-staleness
  // defect a re-crawl can't fix, so it is demoted here rather than re-discovered.
  let eligibilityHeal = null
  try {
    const { enforceStudentAidEligibility } = await import('../../startup/enforceInvariants.js')
    eligibilityHeal = await enforceStudentAidEligibility(db)
    if (eligibilityHeal?.repaired > 0) {
      log.info('coverage sweep demoted student-aid matches on non-student profiles', {
        repaired: eligibilityHeal.repaired, profilesAffected: eligibilityHeal.profilesAffected,
      })
    }
  } catch (err) {
    log.warn('student-aid eligibility heal unavailable in coverage sweep (non-fatal)', { error: err?.message })
  }

  const { audits, summary } = await auditAllProfilesResultCoverage(db, { limit })

  // Telemetry for zero/low-result profiles (reuses the existing low-coverage table).
  try {
    const { recordLowCoverageEvent } = await import('../matching/professionalDevelopmentPolicy.js')
    for (const a of audits.filter((x) => x.low_results)) {
      await recordLowCoverageEvent(db, { profileId: a.profile_id, qualifiedCount: a.surfaced_qualifying, minScore: DEFAULT_MIN_SCORE })
    }
  } catch { /* best-effort telemetry */ }

  // Surfacing regressions are CODE bugs — log loudly so Sam/humans see them.
  const regressions = audits.filter((a) => a.surfacing_gap)
  if (regressions.length) {
    log.error('SURFACING REGRESSION: matches persisted in an UNSURFACED matcher_version', {
      count: regressions.length,
      profiles: regressions.slice(0, 10).map((r) => ({ id: r.profile_id, unsurfaced: r.unsurfaced_count })),
    })
  }

  // Bounded self-heal of the worst acquisition gaps (institution/hyperlocal/low).
  const healQueue = audits
    .filter((a) => a.needs_rediscovery)
    .sort((x, y) => x.surfaced_qualifying - y.surfaced_qualifying)
    .slice(0, Math.max(0, maxHeal))
  const healed = []
  if (autoheal && healQueue.length) {
    try {
      const { runProfileDiscoveryLive } = await import('../crawlerOsService.js')
      for (const a of healQueue) {
        try {
          const before = a.surfaced_qualifying
          await runProfileDiscoveryLive({ db, profileId: a.profile_id })
          const after = await auditProfileResultCoverage(db, a.profile_id)
          healed.push({ profile_id: a.profile_id, before, after: after.surfaced_qualifying, gaps_before: a.gaps })
          log.info('coverage self-heal re-discovered profile', { profile: a.profile_id, before, after: after.surfaced_qualifying })
        } catch (err) {
          log.warn('coverage self-heal failed for profile (non-fatal)', { profile: a.profile_id, error: err?.message })
        }
      }
    } catch (err) {
      log.warn('coverage self-heal unavailable (non-fatal)', { error: err?.message })
    }
  }

  const result = {
    ok: true,
    summary,
    autoheal: Boolean(autoheal),
    healed_count: healed.length,
    healed,
    eligibility_heal: eligibilityHeal
      ? { demoted: eligibilityHeal.repaired ?? 0, profilesAffected: eligibilityHeal.profilesAffected ?? 0 }
      : null,
    top_gaps: audits.filter((a) => a.has_gap).slice(0, 25).map((a) => ({ id: a.profile_id, name: a.display_name, gaps: a.gaps })),
  }
  await recordCoverageSweep(db, result)
  return result
}

export default {
  MIN_HEALTHY_SURFACED,
  auditProfileResultCoverageFromData,
  auditProfileResultCoverage,
  auditAllProfilesResultCoverage,
  runProfileCoverageSweep,
  getLastCoverageSweep,
  isCoverageAutohealEnabled,
}
