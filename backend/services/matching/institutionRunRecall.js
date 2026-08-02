/**
 * institutionRunRecall — the IN-RUN half of the institution-attendance recall key.
 *
 * WHY THIS EXISTS (2026-08-02). Every institution/catalog recall fix shipped as
 * a BOOT NET (`enforceInstitutionAidLinkage`, `enforceProfileDiscoveredCatalogLinkage`,
 * `enforceDeclaredFieldOfStudyRecall`, `enforceCrisisNeedRecall`) — they repair
 * the fleet between boots. But a profile that is created, crawled, and read
 * BETWEEN boots never meets any of them:
 *
 *   - every Amy synthetic (created + crawled + evaluated + reaped inside one
 *     run) — which is why `institution_recall_miss` stayed red on 21 of 21
 *     cohort days while the boot nets shipped and the engine was proven right
 *     (replaying the real pair returns ACCEPT 100);
 *   - any newly-onboarded real student whose first crawl runs before the next
 *     boot — their own school's aid sits in the catalog unscored until then.
 *
 * This step runs INSIDE runProfileDiscoveryLive, after persistRun, and gives
 * the DISCOVERING profile the same attendance-authorized look at the catalog
 * the boot net gives the fleet. It is deliberately a mirror, not a widening:
 *
 *   - ATTENDANCE, NOT ASPIRATION — `resolveAttendedInstitutions` only (#1089:
 *     nineteen target_colleges is the flood; aspiration seeds QUERIES, never
 *     authorizes a match).
 *   - THE WHOLE NAME, NOT ONE WORD — `opportunitySponsoredByInstitution`
 *     bidirectional distinctive-token equality on the SPONSOR.
 *   - THE ENGINE STILL DECIDES — a REJECT is a REJECT and is never written.
 *   - Same match-row identity as the boot net (`il:{profile}:{opp}`,
 *     matcher_version 'institution-link', ON CONFLICT DO NOTHING) so the two
 *     writers can never duplicate a row, the profile's own 'crawler-os' match
 *     always wins, and the boot net's convergence pass (which drops rows the
 *     attendance gate no longer authorizes) governs BOTH writers' rows.
 *   - Bounded: no fetches (DB-only), per-school candidate cap, per-run link cap.
 *
 * Recommendation admission mirrors `crawler-os/matchEngine.isRecommendable`:
 * direct funding requires ACCEPT; only a DIRECTORY locator is recommendable at
 * REVIEW. (REVIEW programs still land in the match table — the product surface —
 * exactly like the boot net.)
 */

import {
  resolveAttendedInstitutions,
  opportunitySponsoredByInstitution,
  institutionSponsorLikePattern,
} from '../../config/profileInstitutions.js'
import { computeMatchDecision } from '../matchEngine.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('institutionRunRecall')

const DEFAULT_CANDIDATE_LIMIT = 200
const DEFAULT_LINK_LIMIT = 40

function boundedIntEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? Math.min(v, 2000) : fallback
}

/**
 * Recall attendance-authorized catalog aid for ONE just-crawled profile.
 *
 * @param {object} db live DB handle (dialect-aware)
 * @param {object} opts
 * @param {object} opts.profile   the live profiles row
 * @param {object} opts.sections  the profile's sections map
 * @param {Map}   [opts.idRemap]  persistRun's os-id -> live-id remap (dedupe aid)
 * @param {Array} [opts.existingRecommendations] this run's recommendation list
 * @param {boolean} [opts.dryRun] when true, nothing is written
 * @returns {{ recommendations: Array, linked: number, scanned: number,
 *             rejectedByEngine: number, schools: number, skipped?: string }}
 */
export async function recallInstitutionAidForRun(db, {
  profile,
  sections,
  idRemap = null,
  existingRecommendations = [],
  dryRun = false,
} = {}) {
  const none = { recommendations: [], linked: 0, scanned: 0, rejectedByEngine: 0, schools: 0 }
  const profileId = profile?.id ?? null
  if (!db || !profileId) return { ...none, skipped: 'no_profile' }

  const schools = resolveAttendedInstitutions(sections ?? {})
  if (schools.length === 0) return { ...none, skipped: 'no_attended_institution' }

  const candidateLimit = boundedIntEnv('INSTITUTION_RUN_RECALL_CANDIDATES', DEFAULT_CANDIDATE_LIMIT)
  const linkLimit = boundedIntEnv('INSTITUTION_RUN_RECALL_LIMIT', DEFAULT_LINK_LIMIT)
  const isPg = db?.dialect === 'postgres'
  const activeTrue = isPg ? 'TRUE' : '1'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'

  // Rows this run already recommends (post-remap live ids) must not duplicate.
  const alreadyRecommended = new Set()
  for (const rec of existingRecommendations ?? []) {
    const raw = rec?.opportunity_id
    if (!raw) continue
    alreadyRecommended.add(idRemap?.get?.(raw) ?? raw)
  }

  let scanned = 0
  let linked = 0
  let rejectedByEngine = 0
  const recommendations = []
  const seen = new Set()

  for (const school of schools) {
    const pattern = institutionSponsorLikePattern(school)
    if (!pattern) continue
    let candidates
    try {
      candidates = await db
        .prepare(
          `SELECT * FROM funding_opportunities
            WHERE sponsor IS NOT NULL AND LOWER(sponsor) LIKE ?
              AND (is_active IS NULL OR is_active = ${activeTrue})
            LIMIT ?`,
        )
        .all(pattern.toLowerCase(), candidateLimit)
    } catch (err) {
      log.warn('institution_run_recall: candidate query failed (non-fatal)', {
        profile: profileId, school, error: String(err?.message || err),
      })
      continue
    }

    for (const opp of candidates || []) {
      if (linked >= linkLimit) break
      if (!opp?.id || seen.has(opp.id)) continue
      if (!opportunitySponsoredByInstitution(school, opp)) continue
      seen.add(opp.id)
      scanned += 1

      let decision
      try {
        decision = computeMatchDecision(profile, opp, { profileSections: sections })
      } catch (err) {
        log.warn('institution_run_recall: scoring failed (non-fatal)', {
          profile: profileId, opportunity: opp.id, error: String(err?.message || err),
        })
        continue
      }
      const verdict = String(decision?.decision ?? '').toUpperCase()
      // The engine stays the sole authority — a REJECT is a REJECT.
      if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
      const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
      if (score === null) continue

      if (!dryRun) {
        try {
          await db
            .prepare(
              `INSERT INTO profile_opportunity_matches
                 (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                  match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                  computed_at, updated_at, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'institution-link', ${nowFn}, ${nowFn}, ${nowFn})
               ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
            )
            .run(
              `il:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
              decision?.explanation ?? null,
              JSON.stringify(decision?.matchedNeeds ?? []),
              JSON.stringify({ institution: school, gate: 'attendance' }),
              null, 'institution_attendance_link',
            )
          linked += 1
        } catch (err) {
          log.warn('institution_run_recall: insert failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
          continue
        }
      } else {
        linked += 1
      }

      // Recommendation admission mirrors isRecommendable: ACCEPT, or a
      // DIRECTORY locator at REVIEW. A REVIEW program stays match-table-only.
      const kind = opp.opportunity_kind ?? null
      const recommendable =
        verdict === 'ACCEPT' ||
        (verdict === 'REVIEW' && String(kind ?? '').toUpperCase() === 'DIRECTORY')
      if (recommendable && !alreadyRecommended.has(opp.id)) {
        recommendations.push({
          opportunity_id: opp.id,
          title: opp.title ?? null,
          sponsor: opp.sponsor ?? null,
          kind,
          amount_min: opp.amount_min ?? null,
          amount_max: opp.amount_max ?? null,
          amount_status: opp.amount_status ?? null,
          match_score: score,
          decision: verdict,
          topical_evidence: null,
          discovered_via: 'institution_attendance_link',
        })
      }
    }
    if (linked >= linkLimit) break
  }

  return { recommendations, linked, scanned, rejectedByEngine, schools: schools.length }
}

export default { recallInstitutionAidForRun }
