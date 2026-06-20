/**
 * Pipeline exclusion service.
 *
 * One canonical, profile-scoped filter that removes funding opportunities the
 * user has ALREADY acted on — anything sitting in this profile's `grants`
 * pipeline (any stage) or carrying a sticky dismissal tombstone — from a list
 * of freshly-surfaced discovery / crawler results.
 *
 * Why this exists (and why it lives in ONE place):
 *   GrantFlow has multiple discovery surfaces (routes/matching.js,
 *   routes/discovery.js, crawler re-ingest loops). Each used to assemble and
 *   return catalog matches WITHOUT consulting the pipeline, so a grant the
 *   user already saved/drafted/submitted would reappear in "new results" on
 *   the next crawl. Centralizing the rule here means every surface enforces
 *   the same exclusion, permanently, instead of each re-implementing (or
 *   forgetting) it.
 *
 * Strictly profile-scoped: we only ever load THIS profile's pipeline + this
 * profile's tombstones, so results from one profile can never suppress (or
 * leak into) another profile's search. This is also the data-layer guarantee
 * against cross-profile "bleed over".
 *
 * Matching identity (most reliable first):
 *   1. funding_opportunity_id (FK to the same catalog row) — strongest.
 *   2. canonical grant fingerprint sha256(title|funder|deadline|url).
 *   3. lower(title) — last-resort, only used for dismissal tombstones whose
 *      URL drifted between crawls (mirrors pipelineDismissals.findDismissal).
 *
 * Posture: recall-over-suppression. If anything in here throws (missing
 * table on an old deploy, dialect quirk), we LOG and return the original
 * list unfiltered — a dedup filter must never blank a user's results.
 */

import { grantFingerprintFromOpportunity } from '../utils/grantFingerprint.js'
import { ensurePipelineDismissalsSchema } from './pipelineDismissals.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('service:pipelineExclusion')

function norm(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

function lowerKey(v) {
  const s = norm(v)
  return s ? s.toLowerCase() : null
}

/**
 * Safe fingerprint for an opportunity-shaped object. Returns null on any
 * failure so a bad row never aborts the whole filter.
 */
function fingerprintOf(opp) {
  try {
    return grantFingerprintFromOpportunity(opp) || null
  } catch {
    return null
  }
}

/**
 * Load this profile's exclusion index: the set of opportunity ids,
 * fingerprints, and titles that are already in the pipeline or dismissed.
 *
 * Returns null on failure (callers treat null as "exclude nothing").
 */
export async function loadPipelineExclusionIndex(db, profileId) {
  const profile = norm(profileId)
  if (!db || typeof db.prepare !== 'function' || !profile) return null

  const oppIds = new Set()
  const fingerprints = new Set()
  const titles = new Set()

  // 1. Grants already in this profile's pipeline (every stage — once a grant
  //    is being tracked, re-surfacing it as a "new" result is the bug).
  try {
    const grantRows = await db
      .prepare(
        `SELECT funding_opportunity_id, fingerprint, title, funder, deadline, url, application_url
           FROM grants
          WHERE profile_id = ?`,
      )
      .all(profile)
    for (const row of grantRows || []) {
      const oppId = norm(row.funding_opportunity_id)
      if (oppId) oppIds.add(oppId)
      const fp = norm(row.fingerprint)
      if (fp) fingerprints.add(fp)
      // Recompute a fingerprint from the row's own identity tuple too, so a
      // grant inserted before fingerprint backfill still matches a freshly
      // fingerprinted candidate.
      const derived = fingerprintOf(row)
      if (derived) fingerprints.add(derived)
      const t = lowerKey(row.title)
      if (t) titles.add(t)
    }
  } catch (err) {
    log.warn('failed to load profile pipeline grants (passing results through)', {
      profileId: profile,
      error: String(err?.message || err),
    })
    return null
  }

  // 2. Sticky dismissal tombstones for this profile.
  try {
    await ensurePipelineDismissalsSchema(db)
    const dRows = await db
      .prepare(
        `SELECT fingerprint, opportunity_id, title
           FROM pipeline_dismissals
          WHERE profile_id = ?`,
      )
      .all(profile)
    for (const row of dRows || []) {
      const oppId = norm(row.opportunity_id)
      if (oppId) oppIds.add(oppId)
      const fp = norm(row.fingerprint)
      if (fp) fingerprints.add(fp)
      const t = lowerKey(row.title)
      if (t) titles.add(t)
    }
  } catch (err) {
    // Non-fatal — we still have pipeline grants to exclude against.
    log.warn('failed to load dismissals (continuing with pipeline-only index)', {
      profileId: profile,
      error: String(err?.message || err),
    })
  }

  return { oppIds, fingerprints, titles }
}

/**
 * Decide whether a single opportunity should be excluded given an index from
 * loadPipelineExclusionIndex(). `matchTitle` defaults to false because exact
 * title collisions are common across unrelated programs ("General Operating
 * Support"); title is only authoritative for explicit dismissal tombstones,
 * which are folded into the index already and matched by id/fingerprint there.
 */
function isExcluded(opp, index, { matchTitle = false } = {}) {
  if (!index) return false
  const oppId = norm(opp?.id ?? opp?.opportunity_id ?? opp?.funding_opportunity_id)
  if (oppId && index.oppIds.has(oppId)) return true
  const fp = fingerprintOf(opp)
  if (fp && index.fingerprints.has(fp)) return true
  if (matchTitle) {
    const t = lowerKey(opp?.title ?? opp?.program_name)
    if (t && index.titles.has(t)) return true
  }
  return false
}

/**
 * Filter `opportunities` down to those NOT already in this profile's pipeline
 * or dismissed. Returns the same array reference shape (a new array) plus a
 * small stats object the caller can fold into diagnostics.
 *
 * @param {object} db
 * @param {string} profileId
 * @param {Array<object>} opportunities
 * @param {{ matchTitle?: boolean }} [opts]
 * @returns {Promise<{ results: Array<object>, excluded: number, total: number }>}
 */
export async function filterOutPipelineMembers(db, profileId, opportunities, opts = {}) {
  const list = Array.isArray(opportunities) ? opportunities : []
  if (list.length === 0) return { results: list, excluded: 0, total: 0 }

  const index = await loadPipelineExclusionIndex(db, profileId)
  if (!index || (index.oppIds.size === 0 && index.fingerprints.size === 0 && index.titles.size === 0)) {
    // Nothing to exclude (or load failed) — pass through untouched.
    return { results: list, excluded: 0, total: list.length }
  }

  const results = []
  let excluded = 0
  for (const opp of list) {
    if (isExcluded(opp, index, opts)) {
      excluded += 1
      continue
    }
    results.push(opp)
  }

  if (excluded > 0) {
    log.info('excluded opportunities already in pipeline/dismissed', {
      profileId: norm(profileId),
      excluded,
      kept: results.length,
    })
  }

  return { results, excluded, total: list.length }
}
