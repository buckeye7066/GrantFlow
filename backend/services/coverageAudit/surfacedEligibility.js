/**
 * surfacedEligibility.js — re-assert the FAITHFUL match-engine eligibility
 * decision against persisted, currently-surfacing profile_opportunity_matches.
 *
 * WHY (generalizes the student-aid fix):
 * A surfaced match carries a PERSISTED decision that is never recomputed when the
 * engine improves, and `web-llm` rows are excluded from the crawler-os reconcile
 * (so they are never re-scored at all). `qualifiesForDisplay` surfaces any stored
 * ACCEPT regardless of score, so a STALE ACCEPT keeps an opportunity visible even
 * after the current engine would reject it. The student-aid boot invariant
 * (enforceStudentAidEligibility) fixes the student-aid-on-a-non-student class via
 * a robust predicate; this sweep catches EVERY genuine-ineligibility class
 * (applicant-type, geo/entity exclusivity, family shown enrolled-student aid,
 * institution-exclusive scholarships) by re-scoring each surfaced row through the
 * EXACT path discovery uses and demoting only the ones it hard-REJECTs.
 *
 * SAFETY — the fidelity lesson that shaped this:
 * A direct `services/matchEngine.computeMatchDecision(rawProfile, opp)` FALSELY
 * rejects org/nonprofit-eligible grants because it bypasses the crawler-os thesis
 * expansion (nonprofit/ministry/church → their canonical eligible types). So we
 * MUST score via `crawler-os/matchEngine.computeMatchDecision(osOpp, thesis)` —
 * the same facade the live pipeline uses (verified: it scores "Homeless Veterans
 * Reintegration" for a ministry at 78/review, not a false reject). We demote ONLY
 * a faithful `reject`; REVIEW-band rows that merely dip below the display floor
 * are LEFT ALONE (demoting them would destroy the recall PR #754 restored).
 *
 * Reversible demotion (decision→reject, score→below floor), idempotent, and gated
 * by ENFORCE_SURFACED_MATCH_ELIGIBILITY (default on). This runs in the nightly
 * coverage sweep (per-profile context is already loaded there), NOT at boot — a
 * full re-score is heavier than the cheap boot invariants.
 */

import { createLogger } from '../../utils/logger.js'
import { inferCandidateProfile } from '../../crawler-os/crawlerVocabulary.js'

const log = createLogger('coverage:surfacedEligibility')

/**
 * Force a demoted match below the display floor so it stops surfacing.
 * Need-anchored scale (owner directive 2026-07-06): display floor
 * (DISCOVERY_MIN_SCORE_FLOOR) = 25, REVIEW band starts at 15 — so 10 keeps a
 * demoted row visible in audits but never on a card. Mirrors
 * STUDENT_AID_DEMOTE_SCORE in startup/enforceInvariants.js.
 */
export const SURFACED_DEMOTE_SCORE = 10

function parseListMaybe(v) {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : [] } catch { return [] } }
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null }

/**
 * liveOppToOs — reconstruct the Crawler-OS opportunity shape the faithful matcher
 * facade consumes from a live funding_opportunities row. Only the fields that
 * drive eligibility/scoring are needed; the facade rebuilds the canonical opp.
 */
export function liveOppToOs(row = {}) {
  // The live funding_opportunities table does NOT persist the OS matching
  // fields (applicant_types lives only in-memory during a crawl). Passing []
  // here made the engine treat the opportunity as serving NOBODY and
  // hard-reject at 0 — the sweep then falsely demoted REAL eligible matches
  // (2026-07-06: NIH Parent STTR for a biotech scored reject@0 with [] but
  // review@80 with honest types). Reconstruct like ingest does: conservative
  // text inference, else '*' (unknown = NEUTRAL, never a penalty — canonical
  // missing-data doctrine; the engine still scores actual relevance).
  const storedApplicants = parseListMaybe(row.applicant_types)
  let applicantTypes = storedApplicants
  if (applicantTypes.length === 0) {
    try { applicantTypes = inferCandidateProfile(row, {}).applicant_types ?? [] } catch { applicantTypes = [] }
  }
  if (!Array.isArray(applicantTypes) || applicantTypes.length === 0) applicantTypes = ['*']
  return {
    id: row.id,
    title: row.title,
    sponsor: row.sponsor,
    summary: row.description ?? row.summary ?? null,
    applicant_types: applicantTypes,
    need_categories: parseListMaybe(row.categories),
    geography: {
      national: row.is_national === 1 || row.is_national === true,
      states: row.state ? [row.state] : [],
      counties: row.geo_county ? [row.geo_county] : [],
      zips: row.geo_zip ? [row.geo_zip] : [],
    },
    kind: row.opportunity_kind ?? null,
    is_rolling: String(row.deadline_type ?? '').toLowerCase() === 'rolling',
    deadline: row.deadline ?? null,
    funding: {
      amount_min: num(row.amount_min),
      amount_max: num(row.amount_max),
      is_loan: row.is_loan === 1 || row.is_loan === true,
      requires_cost_share: row.requires_match === 1 || row.requires_match === true,
    },
    source_id: row.source ?? null,
    trust_tier: row.source_trust_tier ?? null,
    reality_status: row.reality_status ?? null,
  }
}

function parseBool(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return null
}

/**
 * reScoreSurfacedIneligible — sweep every real, active, non-synthetic profile;
 * re-score its currently-surfacing matches through the faithful crawler-os path;
 * demote the ones the engine hard-REJECTs. Injectable deps for tests.
 *
 * @returns {Promise<{scanned,demoted,profilesAffected,affected,enforced}>}
 */
export async function reScoreSurfacedIneligible(db, {
  limit = 500,
  apply = true,
  profileId = null,
  loadContext = null,
  resolveThesis = null,
  scoreOpp = null,
} = {}) {
  if (!db?.prepare) return { scanned: 0, demoted: 0, profilesAffected: 0, affected: [], enforced: false, skipped: 'no_db' }

  let _load = loadContext
  let _thesis = resolveThesis
  let _score = scoreOpp
  let SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay, floor
  try {
    if (!_load) ({ loadProfileContext: _load } = await import('../profileHelpers.js'))
    if (!_thesis) ({ buildThesisForProfile: _thesis } = await import('../crawlerOsService.js'))
    if (!_score) ({ computeMatchDecision: _score } = await import('../../crawler-os/matchEngine.js'))
    ;({ SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay } = await import('../../config/matchSurfacing.js'))
    const { DEFAULT_MIN_SCORE, DISCOVERY_MIN_SCORE_FLOOR } = await import('../../config/matchThresholds.js')
    floor = Number(DEFAULT_MIN_SCORE) || DISCOVERY_MIN_SCORE_FLOOR
  } catch (err) {
    log.warn('surfacedEligibility deps unavailable (non-fatal)', { error: err?.message })
    return { scanned: 0, demoted: 0, profilesAffected: 0, affected: [], enforced: false, skipped: 'deps' }
  }

  const disabled = apply === false || parseBool(process.env.ENFORCE_SURFACED_MATCH_ELIGIBILITY) === false

  // Real, active, non-synthetic profiles (mirror the coverage sweep's selection).
  // When `profileId` is given (the per-crawl choke point), scope to just that one
  // so a live discovery can demote its OWN freshly-persisted ineligible surfaced
  // matches immediately, instead of waiting for the nightly fleet sweep.
  const scopeClause = profileId ? ' AND p.id = ?' : ''
  const scopeArg = profileId ? [String(profileId)] : []
  let profiles = []
  try {
    profiles = await db.prepare(
      `SELECT p.id, p.display_name FROM profiles p
        WHERE (p.status='active' OR p.status IS NULL) AND (p.deleted_at IS NULL)${scopeClause}
          AND NOT EXISTS (SELECT 1 FROM profile_sections ps WHERE ps.profile_id=p.id AND ps.section_key='amy_metadata')
        LIMIT ${Number(limit) || 500}`,
    ).all(...scopeArg)
  } catch {
    try {
      profiles = await db.prepare(
        `SELECT p.id, p.display_name FROM profiles p
          WHERE (p.status='active' OR p.status IS NULL)${scopeClause}
            AND NOT EXISTS (SELECT 1 FROM profile_sections ps WHERE ps.profile_id=p.id AND ps.section_key='amy_metadata')
          LIMIT ${Number(limit) || 500}`,
      ).all(...scopeArg)
    } catch { return { scanned: 0, demoted: 0, profilesAffected: 0, affected: [], enforced: !disabled, skipped: 'profiles' } }
  }

  const isPg = db?.dialect === 'postgres'
  const activeClause = isPg ? '(o.is_active IS NULL OR o.is_active = TRUE)' : '(o.is_active IS NULL OR o.is_active = 1)'

  let scanned = 0
  let demoted = 0
  const affected = []

  for (const p of profiles) {
    let ctx = null
    let thesis = null
    try { ctx = await _load(db, p.id) } catch { ctx = null }
    try { thesis = await _thesis(db, p.id) } catch { thesis = null }
    if (!ctx || !thesis) continue

    let rows = []
    try {
      rows = await db.prepare(
        `SELECT m.id AS match_id, m.match_score, m.match_decision, o.*,
                (UPPER(COALESCE(o.opportunity_kind,'')) IN ('DIRECTORY','PAST_AWARD_INTEL')) AS is_dir
           FROM profile_opportunity_matches m JOIN funding_opportunities o ON o.id = m.opportunity_id
          WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
            AND ${activeClause}`,
      ).all(p.id)
    } catch { rows = [] }

    const toDemote = []
    for (const r of rows) {
      const isDir = r.is_dir === 1 || r.is_dir === true
      // Only rows that currently SURFACE (ACCEPT or >= floor); directories always survive.
      if (isDir) continue
      if (!qualifiesForDisplay({ is_directory: false, match_decision: r.match_decision, match_score: r.match_score }, floor)) continue
      let d = null
      try { d = _score(liveOppToOs(r), thesis, { sections: ctx.sections }) } catch { d = null }
      if (!d) continue
      // Faithful hard-reject only. REVIEW/below-floor rows are LEFT ALONE (recall).
      if (String(d.decision).toLowerCase() !== 'reject') continue
      toDemote.push({ match_id: r.match_id, title: r.title, prev: r.match_score })
    }

    if (toDemote.length === 0) continue
    scanned += toDemote.length

    if (!disabled) {
      for (const t of toDemote) {
        const prev = Number(t.prev)
        const newScore = Number.isFinite(prev) ? Math.min(prev, SURFACED_DEMOTE_SCORE) : SURFACED_DEMOTE_SCORE
        try {
          // Core columns (match_decision/match_score) are guaranteed; explanation is best-effort.
          await db.prepare(
            `UPDATE profile_opportunity_matches
                SET match_decision = 'reject', match_score = ?, match_explanation = ?
              WHERE id = ?`,
          ).run(newScore, 'Demoted by surfacedEligibility sweep: faithful engine hard-rejects this opportunity for the profile (stale surfacing decision).', t.match_id)
          demoted += 1
        } catch {
          try {
            await db.prepare(`UPDATE profile_opportunity_matches SET match_decision='reject', match_score=? WHERE id=?`).run(newScore, t.match_id)
            demoted += 1
          } catch (err) { log.warn('demote failed (non-fatal)', { match: t.match_id, error: err?.message }) }
        }
      }
    }
    affected.push({ profile_id: p.id, name: p.display_name ?? null, count: toDemote.length, sample: toDemote.slice(0, 4).map((t) => t.title) })
  }

  if (demoted > 0) {
    log.info('demoted stale ineligible surfaced matches (faithful re-score)', {
      demoted, profilesAffected: affected.length, sample: affected.slice(0, 8),
    })
  }
  return { scanned, demoted, profilesAffected: affected.length, affected, enforced: !disabled }
}

export default { reScoreSurfacedIneligible, liveOppToOs, SURFACED_DEMOTE_SCORE }
