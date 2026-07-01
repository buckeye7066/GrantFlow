/**
 * amyProfileStore.js
 *
 * Persistence for Amy's synthetic profiles. Two jobs:
 *   1. createAmyProfile — insert a fully-seeded, schema-accurate synthetic
 *      profile tagged so it is traceable and Sam-cleanable.
 *   2. cleanupAmyProfiles — SAFELY delete Amy profiles (Sam cleanup sweep).
 *
 * SAFETY INVARIANTS (cleanup):
 *   - Only ever deletes rows where profiles.created_by === ORIGIN_CREATED_BY.
 *   - The amy_metadata section must say allow_sam_cleanup === true.
 *   - Never deletes a designated/system profile (isDesignatedProfileId guard).
 *   - Each dependent-table delete is best-effort (table may not exist on a
 *     given dialect/DB) and the whole thing is reversible (it only removes
 *     rows Amy itself created).
 *
 * Dialect-safe: uses only `db.prepare(sql).run/get/all(...)` with bound values
 * and ISO timestamps (no dialect-specific now()/JSON operators), so it works on
 * the app's SQLite and Postgres handles and on a raw better-sqlite3 handle in
 * tests. All statements are awaited (no-op await on SQLite's sync returns).
 */

import { randomUUID } from 'node:crypto'
import { supportedSectionKeys, getDefaultSectionData } from '../../config/profileSchema.js'
import { isDesignatedProfileId } from '../../utils/ensureDesignatedProfiles.js'
import { createLogger } from '../../utils/logger.js'
import {
  ORIGIN_CREATED_BY,
  SECTION_WRITER,
  METADATA_SECTION_KEY,
} from './amyConstants.js'
import { buildAmyMetadata, buildAmyTags, isMetadataExpired } from './amyMetadata.js'

const log = createLogger('services:amy:profileStore')

function safeParse(json, fallback) {
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

/**
 * Create one synthetic profile for a scenario. Seeds ALL supported sections
 * with defaults (mirrors the production POST /api/profiles create path), then
 * overlays the scenario's section overrides, and writes the amy_metadata block.
 *
 * @returns {Promise<{ profileId: string, metadata: object, tags: string[] }>}
 */
export async function createAmyProfile(db, scenario, { runId, ttlHours, now = new Date() } = {}) {
  if (!db) throw new Error('createAmyProfile: db is required')
  if (!scenario?.scenario_id) throw new Error('createAmyProfile: scenario.scenario_id is required')

  const profileId = randomUUID()
  const metadata = buildAmyMetadata({ runId, scenarioId: scenario.scenario_id, ttlHours, now })
  const tags = buildAmyTags({ runId, scenarioId: scenario.scenario_id })
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString()

  await db
    .prepare(
      `INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      profileId,
      scenario.display_name || `Amy Synthetic — ${scenario.scenario_id}`,
      scenario.primary_type || null,
      JSON.stringify(tags),
      ORIGIN_CREATED_BY,
      nowIso,
      nowIso,
    )

  const upsertSection = db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )

  const overrides = scenario.sections || {}
  for (const sectionKey of supportedSectionKeys) {
    const defaults = getDefaultSectionData(sectionKey) || {}
    const merged = overrides[sectionKey] ? { ...defaults, ...overrides[sectionKey] } : defaults
    await upsertSection.run(profileId, sectionKey, JSON.stringify(merged), SECTION_WRITER, nowIso, nowIso)
  }

  // Any override section that isn't one of the canonical seeded keys (defensive;
  // currently all categories use canonical keys).
  for (const [sectionKey, value] of Object.entries(overrides)) {
    if (supportedSectionKeys.includes(sectionKey)) continue
    await upsertSection.run(profileId, sectionKey, JSON.stringify(value || {}), SECTION_WRITER, nowIso, nowIso)
  }

  // Authoritative metadata block (the contract Sam cleanup + Anya handoff read).
  await upsertSection.run(
    profileId,
    METADATA_SECTION_KEY,
    JSON.stringify(metadata),
    SECTION_WRITER,
    nowIso,
    nowIso,
  )

  log.info('created synthetic profile', {
    profile_id: profileId,
    scenario_id: scenario.scenario_id,
    category: scenario.category,
    run_id: runId,
    expires_at: metadata.expires_at,
  })

  return { profileId, metadata, tags }
}

/**
 * List Amy-created profiles with their parsed metadata. Robust primary filter
 * is created_by === ORIGIN_CREATED_BY.
 */
export async function listAmyProfiles(db) {
  // Include last_discovery_at so the reaper can treat "discovery actually ran"
  // (any path stamps profiles.last_discovery_at) as a valid crawled signal — not
  // just Amy's own amy_metadata.crawled_at. Tolerant: older/test schemas without
  // the column fall back to the basic SELECT.
  let rows
  try {
    rows = await db
      .prepare(`SELECT id, display_name, primary_type, status, tags, created_by, created_at, last_discovery_at FROM profiles WHERE created_by = ?`)
      .all(ORIGIN_CREATED_BY)
  } catch {
    rows = await db
      .prepare(`SELECT id, display_name, primary_type, status, tags, created_by, created_at FROM profiles WHERE created_by = ?`)
      .all(ORIGIN_CREATED_BY)
  }
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    let metadata = null
    try {
      const sec = await db
        .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?`)
        .get(row.id, METADATA_SECTION_KEY)
      metadata = sec?.data ? safeParse(sec.data, null) : null
    } catch {
      metadata = null
    }
    out.push({ ...row, metadata })
  }
  return out
}

/**
 * Mark a synthetic profile as having been crawled at least once. Stamps
 * crawled_at + crawl_count + last_floor into the amy_metadata section so the
 * "do not delete until crawled" invariant is traceable and enforceable.
 */
export async function markProfileCrawled(db, profileId, { now = new Date(), floor = null } = {}) {
  try {
    const sec = await db
      .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?`)
      .get(profileId, METADATA_SECTION_KEY)
    const meta = sec?.data ? safeParse(sec.data, {}) : {}
    const nowIso = (now instanceof Date ? now : new Date(now)).toISOString()
    meta.crawled_at = meta.crawled_at || nowIso
    meta.last_crawled_at = nowIso
    meta.crawl_count = Number(meta.crawl_count || 0) + 1
    if (floor !== null && floor !== undefined) meta.last_crawl_floor = Number(floor)
    await db
      .prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(profileId, METADATA_SECTION_KEY, JSON.stringify(meta), SECTION_WRITER, nowIso, nowIso)
    return true
  } catch {
    return false
  }
}

const DEPENDENT_TABLES = [
  ['profile_documents', 'profile_id'],
  ['documents', 'profile_id'],
  ['grants', 'profile_id'],
  ['crawler_jobs', 'profile_id'],
  ['profile_opportunity_matches', 'profile_id'],
  ['profile_sections', 'profile_id'],
]

/** Hard-delete a single Amy profile across dependent tables (best-effort). */
async function hardDeleteAmyProfile(db, profileId) {
  for (const [table, col] of DEPENDENT_TABLES) {
    try {
      await db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(profileId)
    } catch {
      // Table may not exist on this DB/dialect — safe to skip.
    }
  }
  await db.prepare(`DELETE FROM profiles WHERE id = ? AND created_by = ?`).run(profileId, ORIGIN_CREATED_BY)
}

/**
 * Safely clean up Amy synthetic profiles. This is what Sam (sweep), the
 * amy:cleanup CLI, and the end-of-run cleanup call.
 *
 * @param {object} opts
 * @param {string} [opts.runId]       - restrict to one run's profiles.
 * @param {boolean} [opts.expiredOnly=false] - only delete past expires_at.
 * @param {boolean} [opts.force=false] - delete regardless of expiry (still
 *        requires the synthetic/allow_sam_cleanup guards).
 * @param {boolean} [opts.dryRun=false] - report what WOULD be deleted; no writes.
 * @param {string[]} [opts.onlyIds]    - restrict deletion to these profile ids.
 * @param {boolean} [opts.requireCrawled=false] - HARD invariant: never delete a
 *        profile that has not been crawled at least once (crawled_at present).
 * @param {number} [opts.minCrawledAgeMs=0] - safety grace: never delete a profile
 *        crawled more recently than this many ms ago (its training run could
 *        still be mid-flight, before its learning step). Expiry-independent, so a
 *        crawled profile with a corrupted/missing expires_at is still reapable
 *        once it's old enough. Use with requireCrawled for the standing sweep.
 * @param {number} [opts.neverCrawledMaxAgeMs=0] - bounded far-past-TTL escape hatch
 *        for the requireCrawled path: a synthetic profile that was created but
 *        NEVER successfully crawled (discovery skipped/errored, or its run crashed
 *        mid-flight) would otherwise accumulate forever, because the normal reap
 *        only touches crawled profiles. When this is > 0, such a profile becomes
 *        reapable ONLY once its age (now - created_at, falling back to expires_at
 *        or the profiles.created_at column) exceeds this many ms — i.e. it is far
 *        past its TTL and is never going to be crawled. The crawled+learned path
 *        is unchanged; default 0 preserves the strict "never delete un-crawled".
 * @param {Date} [opts.now]
 * @returns {Promise<{ scanned, deleted, skipped, dry_run, ids, skipped_ids }>}
 */
export async function cleanupAmyProfiles(db, { runId = null, expiredOnly = false, force = false, dryRun = false, onlyIds = null, requireCrawled = false, minCrawledAgeMs = 0, neverCrawledMaxAgeMs = 0, now = new Date() } = {}) {
  if (!db) throw new Error('cleanupAmyProfiles: db is required')
  const candidates = await listAmyProfiles(db)
  const onlyIdSet = Array.isArray(onlyIds) ? new Set(onlyIds.map(String)) : null
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const result = { scanned: candidates.length, deleted: 0, skipped: 0, dry_run: Boolean(dryRun), require_crawled: Boolean(requireCrawled), ids: [], skipped_ids: [] }

  for (const row of candidates) {
    const meta = row.metadata
    const reasonsToSkip = []

    // Guard 1: never touch a designated/system profile.
    if (isDesignatedProfileId(row.id)) reasonsToSkip.push('designated_profile')
    // Guard 2: must be explicitly cleanup-allowed.
    if (!meta || meta.allow_sam_cleanup !== true) reasonsToSkip.push('not_allow_sam_cleanup')
    // Guard 3: must be marked synthetic (defense in depth).
    if (!meta || meta.synthetic !== true) reasonsToSkip.push('not_synthetic')
    // The "has been crawled" signal is EITHER Amy's own marker
    // (amy_metadata.crawled_at, set by markAmyProfileCrawled) OR the profile's
    // real discovery stamp (profiles.last_discovery_at, set by EVERY discovery
    // path — cross-profile matching, login discovery, manual Discover, Robert's
    // cycle). Keying only off crawled_at leaked synthetics that were genuinely
    // crawled by a non-Amy path but never marked in amy_metadata: they showed
    // last_discovery_at set yet crawled_at null, so requireCrawled skipped them
    // and they lingered until the 96h never-crawled cutoff. Treating either as
    // proof-of-crawl closes that leak.
    const crawledSignalIso = meta?.last_crawled_at || meta?.crawled_at || row.last_discovery_at || null
    // Guard 4 (mission rule): do NOT delete until crawled at least once — with a
    // bounded escape hatch so never-crawled synthetics (skipped/errored discovery
    // or a crashed run) don't accumulate forever. A never-crawled profile is
    // reapable only once it is far past its TTL (neverCrawledMaxAgeMs elapsed).
    if (requireCrawled && !crawledSignalIso) {
      const maxAge = Number(neverCrawledMaxAgeMs) || 0
      let reapNeverCrawled = false
      if (maxAge > 0) {
        const createdIso = meta?.created_at || meta?.expires_at || row.created_at
        const createdMs = createdIso ? Date.parse(createdIso) : NaN
        if (Number.isFinite(createdMs) && Number.isFinite(nowMs) && (nowMs - createdMs) >= maxAge) {
          reapNeverCrawled = true
        }
      }
      if (!reapNeverCrawled) reasonsToSkip.push('not_crawled')
    }
    // Guard 4b (race safety): don't reap a profile crawled so recently its run
    // could still be mid-flight / pre-learning. Expiry-independent.
    if (minCrawledAgeMs > 0 && crawledSignalIso) {
      const crawledMs = Date.parse(crawledSignalIso)
      if (Number.isFinite(crawledMs) && Number.isFinite(nowMs) && (nowMs - crawledMs) < minCrawledAgeMs) {
        reasonsToSkip.push('crawled_too_recently')
      }
    }
    // Optional scope: a specific id set (e.g. profiles crawled this run).
    if (onlyIdSet && !onlyIdSet.has(String(row.id))) reasonsToSkip.push('not_in_only_ids')
    // Optional scope: a specific run.
    if (runId && meta?.amy_run_id !== runId) reasonsToSkip.push('run_mismatch')
    // Optional scope: only expired.
    if (expiredOnly && !force && !isMetadataExpired(meta, now)) reasonsToSkip.push('not_expired')

    if (reasonsToSkip.length > 0) {
      result.skipped += 1
      result.skipped_ids.push({ id: row.id, reasons: reasonsToSkip })
      continue
    }

    if (dryRun) {
      result.deleted += 1 // would-delete count
      result.ids.push(row.id)
      continue
    }

    try {
      await hardDeleteAmyProfile(db, row.id)
      result.deleted += 1
      result.ids.push(row.id)
    } catch (err) {
      result.skipped += 1
      result.skipped_ids.push({ id: row.id, reasons: [`delete_error:${err?.message || 'unknown'}`] })
    }
  }

  log.info('amy cleanup complete', {
    run_id: runId || 'all',
    expired_only: expiredOnly,
    force,
    dry_run: dryRun,
    scanned: result.scanned,
    deleted: result.deleted,
    skipped: result.skipped,
  })

  return result
}

export default { createAmyProfile, listAmyProfiles, markProfileCrawled, cleanupAmyProfiles }
