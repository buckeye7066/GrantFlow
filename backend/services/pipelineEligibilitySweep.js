/**
 * pipelineEligibilitySweep.js
 *
 * One-shot cleanup for pipeline rows that the applicant-type gate would now
 * block. The gate is enforced at WRITE time (opportunityMatcher.saveToProfilePipeline
 * Gate 2.5), but rows added before that gate existed — e.g. institution-only
 * federal grants (OSEP personnel preparation, NRSA institutional training,
 * OESE comprehensive centers, NSF Space Grant) sitting in an INDIVIDUAL's
 * pipeline — must be swept out too.
 *
 * Behaviour (rule-aligned):
 *   - Only rows whose applicant-type eligibility is an EXPLICIT `mismatch` for
 *     the profile are removed. Directory-style resources are EXEMPT (must always
 *     survive). Demographic / field mismatches are NOT touched (score, not drop).
 *   - Removal is REVERSIBLE: each removed row is tombstoned via recordDismissal
 *     (so it doesn't immediately re-add) and deleted via reconcileDismissedGrants;
 *     a user can re-add it manually (POST /grants/from-opportunity clears the
 *     tombstone), exactly like any other dismissal.
 *   - `apply:false` performs a dry run (reports what WOULD be removed).
 */

import { evaluateApplicantTypeEligibility } from './applicantTypeGate.js'
import { isDirectoryLikeOpportunity } from './opportunityMatcher.js'
import { recordDismissal, reconcileDismissedGrants } from './pipelineDismissals.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('service:pipeline-eligibility-sweep')

async function resolveProfileApplicantType(db, profileId) {
  let row = null
  try {
    row = await db
      .prepare('SELECT applicant_type, primary_type FROM profiles WHERE id = ? LIMIT 1')
      .get(String(profileId))
  } catch { row = null }
  let category = null
  try {
    const sec = await db
      .prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1")
      .get(String(profileId))
    if (sec?.data) {
      const d = typeof sec.data === 'string' ? JSON.parse(sec.data) : sec.data
      category = d?.profile_category || d?.applicant_type || null
    }
  } catch { category = null }
  return row?.applicant_type || row?.primary_type || category || null
}

async function loadPipelineRows(db, profileId) {
  // Join the pipeline grant to its catalog opportunity so the gate sees the rich
  // eligibility text (the grants row alone usually only carries title/funder).
  try {
    return await db.prepare(`
      SELECT g.id AS grant_id, g.title AS title, g.funder AS funder, g.deadline AS deadline,
             g.application_url AS application_url, g.funding_opportunity_id AS funding_opportunity_id,
             fo.description AS description, fo.eligibility AS eligibility,
             fo.eligibility_bullets AS eligibility_bullets, fo.applicant_types AS applicant_types,
             fo.eligible_applicants AS eligible_applicants, fo.eligibility_types AS eligibility_types,
             fo.opportunity_kind AS opportunity_kind, fo.type AS type, fo.opportunity_type AS opportunity_type,
             fo.source AS source, fo.source_url AS source_url, fo.is_directory_resource AS is_directory_resource
      FROM grants g
      LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
      WHERE g.profile_id = ?
    `).all(String(profileId))
  } catch {
    // Catalog column set varies across deployments — fall back to grants-only.
    try {
      return await db
        .prepare('SELECT id AS grant_id, title, funder, deadline, application_url, funding_opportunity_id FROM grants WHERE profile_id = ?')
        .all(String(profileId))
    } catch { return [] }
  }
}

/**
 * Sweep one profile's pipeline. Returns { profileId, applicantType, scanned,
 * flagged: [{grant_id,title,reason}], removed }.
 */
export async function sweepProfilePipelineApplicantType(
  db,
  profileId,
  { userId = 'system_eligibility_sweep', apply = true } = {},
) {
  if (!db || !profileId) return { profileId: profileId ?? null, applicantType: null, scanned: 0, flagged: [], removed: 0 }
  const applicantType = await resolveProfileApplicantType(db, profileId)
  const rows = await loadPipelineRows(db, profileId)
  const flagged = []

  for (const r of rows || []) {
    const oppLike = {
      title: r.title,
      description: r.description,
      eligibility: r.eligibility,
      eligibility_bullets: r.eligibility_bullets,
      applicant_types: r.applicant_types,
      eligible_applicants: r.eligible_applicants,
      eligibility_types: r.eligibility_types,
      opportunity_kind: r.opportunity_kind,
      type: r.type,
      opportunity_type: r.opportunity_type,
      source: r.source,
      source_url: r.source_url,
      is_directory_resource: r.is_directory_resource,
    }
    if (isDirectoryLikeOpportunity(oppLike)) continue
    const res = evaluateApplicantTypeEligibility(oppLike, applicantType)
    if (res.decision !== 'mismatch') continue
    flagged.push({ grant_id: r.grant_id, title: r.title, reason: res.reason })
    if (apply) {
      await recordDismissal(db, {
        profileId,
        userId,
        reason: `applicant_type_sweep:${res.reason}`,
        grantRow: {
          id: r.grant_id,
          title: r.title,
          funder: r.funder,
          deadline: r.deadline,
          application_url: r.application_url,
          source_url: r.source_url,
          funding_opportunity_id: r.funding_opportunity_id,
        },
      }).catch((e) => log.warn('dismissal_record_failed', { grant: r.grant_id, err: e?.message }))
    }
  }

  let removed = 0
  if (apply && flagged.length) {
    try { removed = await reconcileDismissedGrants(db) } catch (e) { log.warn('reconcile_failed', { err: e?.message }) }
  }

  log.info('applicant_type_sweep', {
    profileId: String(profileId), applicantType, scanned: (rows || []).length, flagged: flagged.length, removed, apply,
  })
  return { profileId: String(profileId), applicantType, scanned: (rows || []).length, flagged, removed }
}

export default { sweepProfilePipelineApplicantType }
