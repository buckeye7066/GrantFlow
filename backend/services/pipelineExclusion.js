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
 *   3. normalized lower(title)|lower(funder) — catches the same award
 *      re-crawled under a NEW catalog id and/or a NEW source label so the
 *      deadline/url drifted and the fingerprint no longer lines up. This is
 *      the leak that re-surfaced pipeline grants (e.g. the same scholarship
 *      arriving as both "national_pd_program" and "national_pd_scholarship").
 *      Title alone is too collision-prone ("General Operating Support"), so
 *      we require funder too; bare lower(title) is kept only for dismissal
 *      tombstones whose funder/URL drifted (mirrors pipelineDismissals).
 *
 * Posture: fail closed on unreadable pipeline state. If the grants pipeline
 * cannot be read, callers must surface a retryable error rather than risk
 * re-showing saved/dismissed funding as fresh results.
 */

import { grantFingerprintFromOpportunity, likelySameGrantOpportunity } from '../utils/grantFingerprint.js'
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
  return s ? s.toLowerCase().replace(/\s+/g, ' ') : null
}

/**
 * Stable composite key: normalized lower(title)|lower(funder). Returns null
 * unless we have a title (funder may legitimately be missing, in which case
 * the funder slot is empty but the key is still title-anchored). This is the
 * key that survives a re-crawl under a new id / new source label / drifted
 * deadline+url, which is exactly how a pipeline grant leaks back into results.
 */
function titleFunderKey(title, funder) {
  const t = lowerKey(title)
  if (!t) return null
  const f = lowerKey(funder) || ''
  return `${t}|${f}`
}

/** Pull the title from an opportunity-shaped row (catalog or scored result). */
function titleOf(opp) {
  return opp?.title ?? opp?.program_name ?? null
}

/**
 * Pull a human title from a profile-section award entry. These come from the
 * `university_applications` section JSON and use a different (looser) shape than
 * catalog rows: financial-aid pipeline stages carry `title` / `name` / `label`,
 * imported portal awards carry `award_name` / `awardName` / `portal_name`. We
 * accept all of them so a saved/imported award is keyed under the SAME
 * normalized title the catalog exclusion uses.
 */
function sectionAwardTitle(entry) {
  if (!entry || typeof entry !== 'object') return null
  return (
    entry.title ??
    entry.name ??
    entry.label ??
    entry.award_name ??
    entry.awardName ??
    entry.portal_name ??
    entry.portalName ??
    null
  )
}

/** Pull a funder/source from a profile-section award entry (may be absent). */
function sectionAwardFunder(entry) {
  if (!entry || typeof entry !== 'object') return null
  return (
    entry.funder ??
    entry.source ??
    entry.provider ??
    entry.sponsor ??
    entry.portal_name ??
    entry.portalName ??
    null
  )
}

/** Pull the funder from an opportunity-shaped row. */
function funderOf(opp) {
  return opp?.funder ?? opp?.sponsor ?? null
}

/**
 * Safe fingerprint for an opportunity-shaped object. Returns null on any
 * failure — AND when the row carries no real identity (no title, funder, or
 * url), since the fingerprint of an all-empty tuple is a constant value that
 * would otherwise make every blank row collide with every other blank row.
 */
function fingerprintOf(opp) {
  if (!opp || typeof opp !== 'object') return null
  const hasIdentity =
    norm(titleOf(opp)) !== null ||
    norm(funderOf(opp)) !== null ||
    norm(opp.url ?? opp.application_url ?? opp.source_url) !== null
  if (!hasIdentity) return null
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
  const titleFunders = new Set()
  const titles = new Set()
  const pipelineRows = []
  // Bare normalized titles of awards the user has ALREADY secured/imported in
  // their university_applications section. Always checked (unlike `titles`,
  // which is opt-in) because these are user-confirmed awards whose funder/source
  // label routinely drifts from the catalog's — title alone is the only stable
  // identity we have for them, and re-surfacing them is exactly the bug.
  const sectionTitles = new Set()

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
      pipelineRows.push(row)
      const oppId = norm(row.funding_opportunity_id)
      if (oppId) oppIds.add(oppId)
      const fp = norm(row.fingerprint)
      if (fp) fingerprints.add(fp)
      // Recompute a fingerprint from the row's own identity tuple too, so a
      // grant inserted before fingerprint backfill still matches a freshly
      // fingerprinted candidate.
      const derived = fingerprintOf(row)
      if (derived) fingerprints.add(derived)
      const tf = titleFunderKey(row.title, row.funder)
      if (tf) titleFunders.add(tf)
      const t = lowerKey(row.title)
      if (t) titles.add(t)
    }
  } catch (err) {
    log.error('failed to load profile pipeline grants', {
      profileId: profile,
      error: String(err?.message || err),
    })
    const wrapped = new Error(`pipeline_exclusion_unavailable: ${err?.message || err}`)
    wrapped.code = 'PIPELINE_EXCLUSION_UNAVAILABLE'
    wrapped.cause = err
    throw wrapped
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

  // 3. Awards the user already secured/imported that live ONLY in the profile's
  //    `university_applications` section JSON (financial_aid_pipeline stages +
  //    imported portal awards), NOT in the `grants` table. Without these, a
  //    saved/portal-imported scholarship (e.g. "UNCF Scholarships") re-surfaces
  //    as a "new" match because its title/title+funder key was never indexed.
  //    Fold them into the SAME normalized title / title+funder keys so the
  //    existing exclusion logic catches them with no other changes.
  try {
    const sectionRows = await db
      .prepare(
        `SELECT data
           FROM profile_sections
          WHERE profile_id = ? AND section_key = 'university_applications'`,
      )
      .all(profile)
    for (const row of sectionRows || []) {
      const raw = row?.data
      let parsed
      if (raw && typeof raw === 'object') {
        parsed = raw // pg JSON columns may already be objects
      } else {
        const s = norm(raw)
        if (!s) continue
        parsed = JSON.parse(s)
      }
      const applications = Array.isArray(parsed?.applications) ? parsed.applications : []
      for (const app of applications) {
        if (!app || typeof app !== 'object') continue
        const awardEntries = [
          ...(Array.isArray(app.financial_aid_pipeline) ? app.financial_aid_pipeline : []),
          ...(Array.isArray(app.imported_portal_awards) ? app.imported_portal_awards : []),
        ]
        for (const entry of awardEntries) {
          const title = sectionAwardTitle(entry)
          const t = lowerKey(title)
          if (t) {
            titles.add(t)
            sectionTitles.add(t)
          }
          const tf = titleFunderKey(title, sectionAwardFunder(entry))
          if (tf) titleFunders.add(tf)
        }
      }
    }
  } catch (err) {
    // Non-fatal — recall over suppression. We still have pipeline grants +
    // dismissals to exclude against; never blank results because a section
    // failed to parse.
    log.warn('failed to load university_applications section awards (continuing)', {
      profileId: profile,
      error: String(err?.message || err),
    })
  }

  return { oppIds, fingerprints, titleFunders, titles, sectionTitles, pipelineRows }
}

/**
 * Decide whether a single opportunity should be excluded given an index from
 * loadPipelineExclusionIndex().
 *
 * Match order (strongest first):
 *   1. funding_opportunity_id / opportunity_id / id.
 *   2. canonical fingerprint sha256(title|funder|deadline|url).
 *   3. normalized lower(title)|lower(funder) — ON BY DEFAULT. This is the key
 *      that catches a pipeline grant re-crawled under a new id and/or a new
 *      source label (different deadline/url → different fingerprint). title is
 *      paired with funder to avoid generic-title collisions.
 *   4. bare lower(title) for user-secured/imported `university_applications`
 *      section awards — ALWAYS ON. These awards live only in the profile's
 *      section JSON (never the grants table) and their funder/source label
 *      drifts from the catalog's, so title is the only stable identity.
 *   5. bare lower(title) for everything else — OPT-IN (`matchTitle: true`),
 *      only for dismissal tombstones whose funder/URL drifted. Off by default
 *      because exact title collisions across unrelated programs are common.
 */
function isExcluded(opp, index, { matchTitle = false } = {}) {
  if (!index) return false
  const oppId = norm(opp?.id ?? opp?.opportunity_id ?? opp?.funding_opportunity_id)
  if (oppId && index.oppIds.has(oppId)) return true
  const fp = fingerprintOf(opp)
  if (fp && index.fingerprints.has(fp)) return true
  const tf = titleFunderKey(titleOf(opp), funderOf(opp))
  if (tf && index.titleFunders.has(tf)) return true
  if (Array.isArray(index.pipelineRows) && index.pipelineRows.some((row) => likelySameGrantOpportunity(opp, row))) return true
  // User-secured/imported section awards: matched on bare normalized title
  // regardless of `matchTitle`, because their funder label drifts from the
  // catalog's and the title is the only stable identity we have for them.
  const titleKey = lowerKey(titleOf(opp))
  if (titleKey && index.sectionTitles && index.sectionTitles.has(titleKey)) return true
  if (matchTitle) {
    if (titleKey && index.titles.has(titleKey)) return true
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
  if (
    !index ||
    (index.oppIds.size === 0 &&
      index.fingerprints.size === 0 &&
      index.titleFunders.size === 0 &&
      index.titles.size === 0 &&
      (index.pipelineRows?.length ?? 0) === 0 &&
      (index.sectionTitles?.size ?? 0) === 0)
  ) {
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

/**
 * Count how many concrete, populated fields an opportunity-shaped row carries.
 * Used as the tie-breaker for "most complete" when two result rows refer to the
 * same underlying opportunity.
 */
function completenessScore(opp) {
  if (!opp || typeof opp !== 'object') return 0
  let score = 0
  for (const v of Object.values(opp)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim().length === 0) continue
    score += 1
  }
  return score
}

/** Numeric match score for an opportunity-shaped row (0 when absent). */
function matchScoreOf(opp) {
  const raw = opp?.match_score ?? opp?.fit_score
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * Collapse a single result list so the user never sees the same underlying
 * opportunity twice. Two rows are considered the same award when they share
 * ANY stable key: opportunity_id, canonical fingerprint, or normalized
 * lower(title)|lower(funder). The duplicates we observed in production (the
 * same scholarship arriving as both "national_pd_program" and
 * "national_pd_scholarship", different source labels / ids) only collapse on
 * the title+funder key, which is why all three keys are checked.
 *
 * Within a duplicate group we keep the row with the highest match score, then
 * the most-complete row, then first-seen — so the surviving copy is the best
 * one. This is the SAME stable-key set used by the pipeline-exclusion filter,
 * so callers get one consistent notion of "same opportunity".
 *
 * Display-only: never mutates the DB. Recall-over-suppression — anything that
 * throws degrades to returning the original list.
 *
 * @param {Array<object>} opportunities
 * @returns {{ results: Array<object>, removed: number, total: number }}
 */
export function dedupeOpportunityList(opportunities) {
  const list = Array.isArray(opportunities) ? opportunities : []
  if (list.length <= 1) return { results: list, removed: 0, total: list.length }

  try {
    // Map every stable key → the index of the winning row in `kept`.
    const keyToIndex = new Map()
    const kept = []

    const keysFor = (opp) => {
      const keys = []
      const oppId = norm(opp?.id ?? opp?.opportunity_id ?? opp?.funding_opportunity_id)
      if (oppId) keys.push(`id:${oppId}`)
      const fp = fingerprintOf(opp)
      if (fp) keys.push(`fp:${fp}`)
      const tf = titleFunderKey(titleOf(opp), funderOf(opp))
      if (tf) keys.push(`tf:${tf}`)
      return keys
    }

    const isBetter = (candidate, incumbent) => {
      const cs = matchScoreOf(candidate)
      const is = matchScoreOf(incumbent)
      if (cs !== is) return cs > is
      return completenessScore(candidate) > completenessScore(incumbent)
    }

    for (const opp of list) {
      const keys = keysFor(opp)
      // A row with NO stable key (no id/fingerprint/title) cannot be matched to
      // anything — keep it as its own entry rather than collapsing blanks.
      if (keys.length === 0) {
        kept.push(opp)
        continue
      }
      // Find an existing group this row belongs to (any shared key).
      let groupIndex = -1
      for (const k of keys) {
        if (keyToIndex.has(k)) {
          groupIndex = keyToIndex.get(k)
          break
        }
      }
      if (groupIndex === -1) {
        groupIndex = kept.findIndex((existing) => likelySameGrantOpportunity(opp, existing))
      }
      if (groupIndex === -1) {
        const newIndex = kept.length
        kept.push(opp)
        for (const k of keys) keyToIndex.set(k, newIndex)
      } else {
        // Already seen this opportunity — keep the better copy in place and
        // (re)point every key of the winner at the group slot.
        if (isBetter(opp, kept[groupIndex])) kept[groupIndex] = opp
        for (const k of keysFor(kept[groupIndex])) keyToIndex.set(k, groupIndex)
        for (const k of keys) keyToIndex.set(k, groupIndex)
      }
    }

    const removed = list.length - kept.length
    if (removed > 0) {
      log.info('collapsed duplicate opportunities in result list', {
        removed,
        kept: kept.length,
      })
    }
    return { results: kept, removed, total: list.length }
  } catch (err) {
    log.warn('dedupeOpportunityList failed (returning list unchanged)', {
      error: String(err?.message || err),
    })
    return { results: list, removed: 0, total: list.length }
  }
}
