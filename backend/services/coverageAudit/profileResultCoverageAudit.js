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
import { isPointerKind } from '../../config/opportunityKindClasses.js'
import { resolveFleetResultTarget } from '../../config/profileResultFloor.js'
import { isStudentAidOpportunity } from '../matchEngine.js'
import { isTemplatedGeoStub } from '../relevanceFilterRules.js'
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
 * Is this surfaced row's deadline in the past? A row only counts as "passed" when
 * it carries a concrete deadline that is BEFORE now — rolling/ongoing/unknown
 * deadline types (and null deadlines) are never "passed" because they stay open.
 * `nowMs` is injectable so the pure function stays deterministic under test.
 */
function isDeadlinePassed(row, nowMs = Date.now()) {
  if (!row) return false
  const type = String(row.deadline_type || '').toLowerCase()
  if (type === 'rolling' || type === 'ongoing') return false
  const raw = row.deadline_at || row.deadline || null
  if (!raw) return false
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return false
  return t < nowMs
}

/**
 * A surfaced row is ACTIONABLE when a client could still realistically apply to
 * it: it qualifies for display AND is neither a templated geo-stub ("Food Bank
 * resources near <town>", "United Way near <town>" — locator noise, not a grant)
 * NOR past its deadline. `low_results` and the acquisition-gap checks are driven
 * off this count so a pipeline padded with expired rows or geo-stubs no longer
 * masks an empty result set and skips the nightly self-heal.
 */
function isActionableRow(row, nowMs = Date.now()) {
  if (isTemplatedGeoStub(row)) return false
  if (isDeadlinePassed(row, nowMs)) return false
  return true
}

/**
 * A surfaced row is AWARDABLE when it names money this profile could actually
 * receive: actionable, and NOT a POINTER (directory / referral / school_portal /
 * past_award_intel — `config/opportunityKindClasses.isPointerKind`).
 *
 * This is the count the per-profile RESULT FLOOR is judged on, and it is the
 * only honest denominator for "is this person served". A locator promises a
 * place to look, never an award — CLAUDE.md's locator rule — so a profile whose
 * whole list is locators has been given directions, not funding. Measured in
 * prod 2026-08-01: `Demo General Support Persona` and `William` each carry 25 and 24
 * ACTIONABLE rows and **zero** awardable ones, and both read as healthy against
 * `MIN_HEALTHY_SURFACED`.
 *
 * A BENEFIT program (Pell, SSI, LIHEAP) COUNTS: it publishes no fixed per-award
 * figure but it IS the thing you apply to (see `opportunityKindClasses`'s own
 * note on why `isPointerKind` excludes benefits deliberately).
 *
 * NOTE this is a stricter way of COUNTING, never a looser way of ADMITTING:
 * `qualifiesForDisplay` and every engine gate are untouched, and directories
 * keep surfacing to the owner exactly as before.
 */
function isAwardableRow(row, nowMs = Date.now()) {
  if (!isActionableRow(row, nowMs)) return false
  return !isPointerKind(row?.opportunity_kind)
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
export function auditProfileResultCoverageFromData({ profileId, surfacedRows = [], unsurfacedCount = 0, thesis = {}, floor = DEFAULT_MIN_SCORE, nowMs = Date.now(), resultTarget = null, configuration = null }) {
  const qualifying = surfacedRows.filter((r) => qualifiesForDisplay(r, floor))
  // ACTIONABLE = qualifying rows a client could still apply to: not a templated
  // geo-stub and not past deadline. Acquisition gaps (institution / hyperlocal /
  // low_results) are judged against these, so expired or geo-stub padding can no
  // longer mask an empty result set (the exact way demo_senior_applicant's 12 deadline_passed
  // geo-stubs made her look "covered").
  const actionable = qualifying.filter((r) => isActionableRow(r, nowMs))
  // AWARDABLE = the per-profile RESULT FLOOR's denominator (see isAwardableRow).
  const awardable = actionable.filter((r) => isAwardableRow(r, nowMs))
  const geo_stub_count = qualifying.filter((r) => isTemplatedGeoStub(r)).length
  const deadline_passed_count = qualifying.filter((r) => isDeadlinePassed(r, nowMs)).length
  const pointer_count = actionable.length - awardable.length
  const gaps = []

  // 1. Surfacing regression (CODE bug — not crawl-remediable).
  const surfacing_gap = Number(unsurfacedCount) > 0
  if (surfacing_gap) gaps.push(`surfacing_regression:${unsurfacedCount}_matches_in_unsurfaced_version`)

  // 2. Institution gap (students with named schools). Judge against ACTIONABLE
  //    rows so a school named only inside a geo-stub doesn't mask a real gap.
  const schools = Array.isArray(thesis.schools) ? thesis.schools.filter(Boolean) : []
  const missing_schools = thesis.is_student
    ? schools.filter((s) => !anyRowReferences(actionable, s))
    : []
  const institution_gap = thesis.is_student && schools.length > 0 && missing_schools.length === schools.length
  if (institution_gap) gaps.push(`institution_gap:${missing_schools.slice(0, 3).join('|')}`)

  // 3. Hyperlocal gap (county present, no ACTIONABLE county/local match — a
  //    "Community Action Agency near <county>" geo-stub must not satisfy this).
  const countyTok = thesis.location?.county ? countyToken(thesis.location.county) : ''
  const hyperlocal_gap = Boolean(countyTok) && !actionable.some((r) => norm(`${r.title || ''} ${r.sponsor || ''}`).includes(countyTok))
  if (hyperlocal_gap) gaps.push(`hyperlocal_gap:${countyTok}`)

  // 4. Low / zero results — measured on ACTIONABLE sources, not padded totals.
  //    This stays the "this profile is BROKEN" alarm at MIN_HEALTHY_SURFACED (3).
  const low_results = actionable.length < MIN_HEALTHY_SURFACED
  if (low_results) gaps.push(`low_results:${actionable.length}`)

  // 4b. RESULT FLOOR (owner rule 2026-08-01, third clause of the crawler goal):
  //     the profile's REQUESTED result number, judged on AWARDABLE rows. A
  //     target of 0 disables the floor for that profile. Distinct from
  //     low_results above, which counts pointers and fires at 3 — in prod that
  //     bar flags 0 of 33 real profiles while 12 sit below a target of 10
  //     (measured with this code against a full prod replica, 2026-08-01).
  //
  //     UNCONFIGURED PROFILES ARE NOT A SHORTFALL (2026-08-02). A profile that
  //     declares no need, no eligibility fact and no usable location cannot be
  //     satisfied by any amount of crawling, so counting it "below target"
  //     would queue it for endless backfill — manufacturing junk to hit a
  //     quota, the exact trap the floor was warned about. It is reported as
  //     `unconfigured`, with the missing prerequisites NAMED, and excluded
  //     from the floor and from `needs_rediscovery`. Measured in prod
  //     2026-08-02: `profile-demo-general-support` (27 matches, 0 awardable) and
  //     `profile-demo-general-funding` were both in the below-target set.
  const unconfigured = configuration?.unconfigured === true
  const missing_prerequisites = unconfigured ? (configuration.missing_prerequisites || []) : []
  if (unconfigured) gaps.push(`unconfigured_profile:${missing_prerequisites.length}_prerequisites_unmet`)
  const result_target = Number.isFinite(Number(resultTarget)) ? Number(resultTarget) : resolveFleetResultTarget()
  const below_result_target = !unconfigured && result_target > 0 && awardable.length < result_target
  const result_shortfall = below_result_target ? result_target - awardable.length : 0
  if (below_result_target) gaps.push(`result_floor_shortfall:${awardable.length}_of_${result_target}`)

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

  // Re-discovery can only fix acquisition gaps (2-4b), never a code-level
  // surfacing regression or a stale-decision eligibility defect (5).
  // An unconfigured profile is never queued for re-discovery: re-running the
  // crawlers over an empty profile is what produced the 27 invented rows.
  const needs_rediscovery = !unconfigured && (institution_gap || hyperlocal_gap || low_results || below_result_target)

  return {
    profile_id: profileId,
    surfaced_qualifying: qualifying.length,
    surfaced_actionable: actionable.length,
    surfaced_awardable: awardable.length,
    pointer_count,
    geo_stub_count,
    deadline_passed_count,
    surfaced_total: surfacedRows.length,
    unsurfaced_count: Number(unsurfacedCount) || 0,
    surfacing_gap,
    institution_gap,
    missing_schools,
    hyperlocal_gap,
    low_results,
    result_target,
    below_result_target,
    result_shortfall,
    unconfigured,
    missing_prerequisites,
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
export async function auditProfileResultCoverage(db, profileId, { floor = DEFAULT_MIN_SCORE, thesis = null, resultTarget = null } = {}) {
  const isPg = db?.dialect === 'postgres'
  const activeClause = isPg
    ? '(o.is_active IS NULL OR o.is_active = TRUE)'
    : '(o.is_active IS NULL OR o.is_active = 1)'

  const surfacedRows = await db
    .prepare(
      `SELECT m.match_score, m.match_decision, o.title, o.sponsor, o.description, o.categories,
              o.opportunity_kind, o.deadline, o.deadline_at, o.deadline_type,
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

  // Per-profile requested result number: the ledger override if one is set,
  // else the fleet default. Best-effort — an unreadable ledger falls back to
  // the fleet default rather than silently disabling the floor.
  let effTarget = resultTarget
  if (effTarget === null || effTarget === undefined) {
    try {
      const { readFloorLedger } = await import('./profileResultFloorLedger.js')
      const { resolveProfileResultTarget } = await import('../../config/profileResultFloor.js')
      effTarget = resolveProfileResultTarget(profileId, await readFloorLedger(db))
    } catch {
      effTarget = null
    }
  }

  // Does this profile declare ANYTHING that can be searched for? Same detector
  // the crawl entry point and the boot sweep use, so all three agree.
  let configuration = null
  try {
    const { loadProfileContext } = await import('../profileHelpers.js')
    const { assessProfileConfiguration } = await import('../profile/profileConfiguration.js')
    configuration = assessProfileConfiguration(await loadProfileContext(db, profileId))
  } catch {
    configuration = null // unknown → treated exactly as before (never assumed unconfigured)
  }

  return auditProfileResultCoverageFromData({
    profileId,
    surfacedRows: rows,
    unsurfacedCount,
    thesis: effThesis || {},
    floor,
    resultTarget: effTarget,
    configuration,
  })
}

/**
 * auditAllProfilesResultCoverage — sweep every REAL, active profile (synthetic
 * Amy training profiles are excluded — they are reaped, not remediated). Returns
 * per-profile audits + an aggregate summary. Read-only.
 */
export async function auditAllProfilesResultCoverage(db, { limit = 500, floor = DEFAULT_MIN_SCORE, ledger = null } = {}) {
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

  // Read the floor ledger ONCE for the whole sweep — resolving the target
  // per profile inside the loop would re-read system_kv 33+ times per run.
  let effLedger = ledger
  let resolveTarget = null
  try {
    if (!effLedger) {
      const { readFloorLedger } = await import('./profileResultFloorLedger.js')
      effLedger = await readFloorLedger(db)
    }
    ;({ resolveProfileResultTarget: resolveTarget } = await import('../../config/profileResultFloor.js'))
  } catch { /* fall back to the fleet default inside the pure audit */ }

  const audits = []
  for (const p of profiles) {
    try {
      const resultTarget = resolveTarget ? resolveTarget(p.id, effLedger) : null
      const a = await auditProfileResultCoverage(db, p.id, { floor, resultTarget })
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
    // The per-profile RESULT FLOOR (owner rule 2026-08-01): how many profiles
    // hold fewer AWARDABLE results than their requested number.
    below_result_target: audits.filter((a) => a.below_result_target).length,
    // Profiles that CANNOT be served until a human fills them in. Reported as
    // its own class so a silence here means "every profile is configured",
    // never "we quietly stopped counting some of them".
    unconfigured: audits.filter((a) => a.unconfigured).length,
    ineligible_surfaced_matches: audits.filter((a) => a.ineligible_surfaced_match).length,
    needs_rediscovery: audits.filter((a) => a.needs_rediscovery).length,
    // Padding signals: profiles whose displayed count is inflated by expired rows
    // or geo-stubs (so a human/Sam can see WHY a "healthy" total wasn't actionable).
    padded_by_deadline: audits.filter((a) => (a.deadline_passed_count || 0) > 0).length,
    padded_by_geo_stub: audits.filter((a) => (a.geo_stub_count || 0) > 0).length,
  }
  return { audits, summary }
}

// ── Observability: persist the last sweep to system_kv (Agent Observability
// Rule) so Sam diagnostics + Anya's owner tools can SEE what the sweep found. ──
export const COVERAGE_SWEEP_KV_KEY = 'coverage_audit_last_run'
const KV_KEY = COVERAGE_SWEEP_KV_KEY

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
  const startedAt = new Date().toISOString()
  // Heartbeat BEFORE any work: a sweep that dies mid-heal (process restart,
  // OOM, deploy) previously left NO trace in system_kv — the record only landed
  // at the very end, so `coverage_audit_last_run` looked write-only/absent.
  // With a status:'running' record up front, Sam's coverage.sweepHealth check
  // can detect a never-completing sweep instead of seeing nothing at all.
  await recordCoverageSweep(db, { ok: null, status: 'running', started_at: startedAt })
  try {
    const result = await runProfileCoverageSweepInner(db, { autoheal, maxHeal, limit, startedAt })
    await recordCoverageSweep(db, result)
    return result
  } catch (err) {
    // An exception must still leave a terminal record (status:'failed') so the
    // failure is observable — the caller's log line alone is not persistent.
    await recordCoverageSweep(db, { ok: false, status: 'failed', started_at: startedAt, error: String(err?.message || err) })
    throw err
  }
}

async function runProfileCoverageSweepInner(db, { autoheal, maxHeal, limit, startedAt }) {
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

  // General eligibility net: re-score every currently-surfacing match through the
  // FAITHFUL crawler-os path and demote the ones the engine hard-rejects (catches
  // every ineligibility class — applicant-type, geo/entity, family-shown-student-
  // aid, institution-exclusive — beyond the student-aid predicate). Only genuine
  // rejects are demoted; REVIEW-band rows are left alone (recall).
  let surfacedEligHeal = null
  try {
    const { reScoreSurfacedIneligible } = await import('./surfacedEligibility.js')
    surfacedEligHeal = await reScoreSurfacedIneligible(db, { limit })
    if (surfacedEligHeal?.demoted > 0) {
      log.info('coverage sweep demoted stale ineligible surfaced matches (faithful re-score)', {
        demoted: surfacedEligHeal.demoted, profilesAffected: surfacedEligHeal.profilesAffected,
      })
    }
  } catch (err) {
    log.warn('surfaced-eligibility re-score unavailable in coverage sweep (non-fatal)', { error: err?.message })
  }

  // The floor ledger drives BOTH the per-profile target used by the audit and
  // the attempt/cooldown/exhaustion gating of the heal queue below.
  let floorLedger = { targets: {}, profiles: {} }
  let floorApi = null
  let activeCatalogCount = 0
  try {
    floorApi = await import('./profileResultFloorLedger.js')
    floorLedger = await floorApi.readFloorLedger(db)
    activeCatalogCount = await floorApi.countActiveCatalogRows(db)
  } catch (err) {
    log.warn('result-floor ledger unavailable in coverage sweep (non-fatal)', { error: err?.message })
  }

  const { audits, summary } = await auditAllProfilesResultCoverage(db, { limit, ledger: floorLedger })

  // Telemetry for zero/low-result profiles (reuses the existing low-coverage table).
  try {
    const { recordLowCoverageEvent } = await import('../matching/professionalDevelopmentPolicy.js')
    for (const a of audits.filter((x) => x.low_results)) {
      await recordLowCoverageEvent(db, { profileId: a.profile_id, qualifiedCount: a.surfaced_actionable ?? a.surfaced_qualifying, minScore: DEFAULT_MIN_SCORE })
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

  // ── Bounded, CONVERGING self-heal of the acquisition gaps ─────────────────
  //
  // Two defects in the previous version, both visible in prod on 2026-08-01:
  //
  //   1. NO CONVERGENCE. It re-ran `runProfileDiscoveryLive` for the same worst
  //      profiles every night with identical arguments and no record of what
  //      had already been tried, so an unsatisfiable gap (Noor Hassan's
  //      `institution_gap:Lewiston High School` — a high school that sponsors
  //      no catalog aid) was a permanent nightly retry.
  //   2. IT RANKED BY THE PADDED COUNT. Ordering by `surfaced_actionable` put
  //      Demo General Support Persona (25 actionable, **0 awardable**) behind profiles that
  //      already had real awards.
  //
  // Now: the queue is gated by the floor ledger (exhausted / cooling-down
  // profiles are skipped, and a drifted world re-opens them), ordered
  // FEWEST-ATTEMPTS-FIRST then deepest shortfall — the attempts key is what
  // stops retries starving never-tried profiles out of the budget, the exact
  // way `enforceAmountEnrichment` starved for a week — and every outcome is
  // folded back with honest burn semantics.
  const floorAssessments = new Map()
  if (floorApi) {
    for (const a of audits) {
      floorAssessments.set(
        a.profile_id,
        floorApi.assessProfileFloor({
          profileId: a.profile_id,
          awardable: a.surfaced_awardable ?? 0,
          ledger: floorLedger,
          activeCatalogCount,
        }),
      )
    }
  }

  const { orderFloorQueue, FLOOR_OUTCOME } = await import('../../config/profileResultFloor.js').catch(() => ({}))

  const skippedByLedger = []
  const candidates = audits
    .filter((a) => a.needs_rediscovery)
    .filter((a) => {
      const f = floorAssessments.get(a.profile_id)
      // Only the RESULT-FLOOR class is ledger-gated. A profile queued for an
      // institution/hyperlocal gap keeps its existing behaviour — refusing it
      // on a floor verdict would silently retire a different, unrelated gap.
      if (!f || !a.below_result_target) return true
      if (!f.eligible) { skippedByLedger.push({ profile_id: a.profile_id, reason: f.reason, attempts: f.attempts }) }
      return f.eligible
    })
    .map((a) => ({
      audit: a,
      profile_id: a.profile_id,
      attempts: floorAssessments.get(a.profile_id)?.attempts ?? 0,
      shortfall: a.result_shortfall ?? 0,
      escalation: floorAssessments.get(a.profile_id)?.escalation ?? 1,
    }))

  const healQueue = (orderFloorQueue ? orderFloorQueue(candidates) : candidates).slice(0, Math.max(0, maxHeal))
  const healed = []
  const exhausted = []
  if (autoheal && healQueue.length) {
    try {
      const { runProfileDiscoveryLive } = await import('../crawlerOsService.js')
      for (const item of healQueue) {
        const a = item.audit
        // `before` is the AWARDABLE count — what the owner would recognise as
        // funding — not the pointer-padded total the old loop reported.
        const before = a.surfaced_awardable ?? 0
        let run = null
        let ranOk = false
        try {
          run = await runProfileDiscoveryLive({ db, profileId: a.profile_id })
          // A run that was SKIPPED (deleted profile, no sources selected) or
          // that reports failure has told us nothing about this profile's
          // ceiling — it must not spend an attempt.
          ranOk = Boolean(run) && run.ok !== false && run.skipped !== true
        } catch (err) {
          log.warn('coverage self-heal failed for profile (non-fatal)', { profile: a.profile_id, error: err?.message })
          ranOk = false
        }

        let after = null
        try {
          after = await auditProfileResultCoverage(db, a.profile_id, {
            resultTarget: floorAssessments.get(a.profile_id)?.target ?? null,
          })
        } catch (err) {
          // The recount failed, so the outcome is UNKNOWN. Writing a mark here
          // would be the #946 defect (a permanent mark for an answer we do not
          // have), so nothing is folded in at all.
          log.warn('coverage self-heal recount failed (non-fatal, attempt NOT spent)', {
            profile: a.profile_id, error: err?.message,
          })
        }

        const afterAwardable = after?.surfaced_awardable ?? null
        healed.push({
          profile_id: a.profile_id,
          before,
          after: afterAwardable ?? before,
          target: a.result_target ?? null,
          escalation: item.escalation,
          ran: ranOk,
          gaps_before: a.gaps,
        })
        log.info('coverage self-heal re-discovered profile', {
          profile: a.profile_id, before, after: afterAwardable, target: a.result_target, escalation: item.escalation, ran: ranOk,
        })

        // Fold the outcome into the ledger — only ever AFTER a successful
        // recount, and only for profiles the floor actually queued.
        if (floorApi && FLOOR_OUTCOME && after && a.below_result_target) {
          const added = Math.max(0, (afterAwardable ?? before) - before)
          const outcome = !ranOk
            ? FLOOR_OUTCOME.TRANSIENT
            : (added > 0 ? FLOOR_OUTCOME.ADDED : FLOOR_OUTCOME.NO_NEW_RESULTS)
          floorLedger = floorApi.recordFloorAttempt(floorLedger, a.profile_id, {
            outcome,
            target: after.result_target,
            awardable: afterAwardable,
            added,
            fingerprint: floorAssessments.get(a.profile_id)?.fingerprint ?? null,
            evidence: {
              lanes_queried: Number(run?.sources?.length) || 0,
              queries_issued: Number(run?.web?.queries?.length) || 0,
              pages_fetched: Number(run?.web?.fetched) || 0,
              candidates_extracted: Number(run?.web?.extracted) || 0,
              rejected_by_engine: Number(run?.web?.rejected) || 0,
              added_total: added,
            },
          })
          const entry = floorLedger.profiles?.[a.profile_id]
          if (entry?.exhausted_at) {
            const { describeExhaustion } = await import('../../config/profileResultFloor.js')
            log.info('result floor EXHAUSTED for profile (no further nightly retries until drift or cooldown)', {
              profile: a.profile_id, verdict: describeExhaustion(entry),
            })
          }
        }
      }
    } catch (err) {
      log.warn('coverage self-heal unavailable (non-fatal)', { error: err?.message })
    }
  }

  // Record the OBSERVED floor state for every profile the sweep looked at, so a
  // profile that reached its target has any stale exhaustion cleared even when
  // it was never in the heal queue.
  if (floorApi) {
    try {
      for (const a of audits) {
        const f = floorAssessments.get(a.profile_id)
        if (!f) continue
        if (floorLedger.profiles?.[a.profile_id]?.last_attempt_at &&
            healQueue.some((h) => h.profile_id === a.profile_id)) continue
        floorLedger = floorApi.refreshFloorObservation(floorLedger, a.profile_id, {
          target: f.target, awardable: a.surfaced_awardable ?? 0, fingerprint: f.fingerprint,
        })
      }
      await floorApi.writeFloorLedger(db, floorLedger)
    } catch (err) {
      log.warn('could not persist result-floor ledger after sweep (non-fatal)', { error: err?.message })
    }

    // "We stopped looking for this profile" is a STANDING fact, not a one-time
    // log line on the night it was decided. Report every profile still carrying
    // an exhausted verdict, so a silence in the owner's report always means "no
    // profile has been given up on" rather than "the decision scrolled past".
    try {
      const { describeExhaustion } = await import('../../config/profileResultFloor.js')
      for (const a of audits) {
        const entry = floorLedger.profiles?.[a.profile_id]
        if (!entry?.exhausted_at) continue
        exhausted.push({
          profile_id: a.profile_id,
          name: a.display_name ?? null,
          exhausted_at: entry.exhausted_at,
          verdict: describeExhaustion(entry),
        })
      }
    } catch { /* reporting is best-effort; the ledger is already durable */ }
  }

  const result = {
    ok: true,
    status: 'completed',
    started_at: startedAt,
    summary,
    autoheal: Boolean(autoheal),
    healed_count: healed.length,
    healed,
    // The RESULT-FLOOR ledger's own outcomes, so "we stopped looking" is a
    // reported, evidenced fact rather than a silent absence of retries.
    result_floor: {
      below_target: summary.below_result_target ?? 0,
      queued: healQueue.length,
      skipped_by_ledger: skippedByLedger,
      exhausted,
      // NOT a shortfall — a prerequisite. Named, so the owner can act.
      unconfigured: audits
        .filter((a) => a.unconfigured)
        .map((a) => ({ profile_id: a.profile_id, name: a.display_name ?? null, missing_prerequisites: a.missing_prerequisites })),
    },
    eligibility_heal: eligibilityHeal
      ? { demoted: eligibilityHeal.repaired ?? 0, profilesAffected: eligibilityHeal.profilesAffected ?? 0 }
      : null,
    surfaced_eligibility_heal: surfacedEligHeal
      ? { demoted: surfacedEligHeal.demoted ?? 0, profilesAffected: surfacedEligHeal.profilesAffected ?? 0 }
      : null,
    top_gaps: audits.filter((a) => a.has_gap).slice(0, 25).map((a) => ({ id: a.profile_id, name: a.display_name, gaps: a.gaps })),
  }
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
