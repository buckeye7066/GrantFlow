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
 *   - Cleanup discovers every table carrying profile_id, deletes all of those
 *     rows transactionally, and reports any real failure. Missing optional
 *     legacy tables are tolerated; constraint/permission failures are not.
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
export const REQUIRED_TEACHING_AGENTS = Object.freeze(['amy', 'anya', 'sam', 'robert'])

function safeParse(json, fallback) {
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

function normalizeAgentIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean))]
}

export function hasRequiredTeachingReceipt(meta) {
  const taughtAt = meta?.last_taught_at || meta?.taught_at || meta?.teaching?.last_taught_at || meta?.teaching?.taught_at || null
  if (!taughtAt) return false
  const learned = normalizeAgentIds(meta?.learning_agents || meta?.teaching?.agents)
  return REQUIRED_TEACHING_AGENTS.every((agentId) => learned.includes(agentId))
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

/**
 * Mark one or more synthetic profiles as TAUGHT. This is the durable receipt for
 * the owner rule create → crawl → teach → delete: cleanup may only reap a
 * crawled profile once Amy has published its blind-spot lessons through the
 * existing mesh / finding-actor chain.
 */
export async function markProfilesTaught(
  db,
  profileIds,
  { now = new Date(), runId = null, agents = REQUIRED_TEACHING_AGENTS, receipt = null } = {},
) {
  if (!db) throw new Error('markProfilesTaught: db is required')
  const ids = [...new Set((Array.isArray(profileIds) ? profileIds : [profileIds]).filter(Boolean).map(String))]
  if (ids.length === 0) return { updated: 0, ids: [] }

  const upsertSection = db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, section_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
  const selectSection = db.prepare(
    `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?`,
  )
  const taughtAgents = normalizeAgentIds(agents)
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString()
  const result = { updated: 0, ids: [] }

  for (const profileId of ids) {
    const sec = await selectSection.get(profileId, METADATA_SECTION_KEY)
    const meta = sec?.data ? safeParse(sec.data, {}) : {}
    const learningAgents = normalizeAgentIds([
      ...normalizeAgentIds(meta.learning_agents),
      ...normalizeAgentIds(meta?.teaching?.agents),
      ...taughtAgents,
    ])
    const taughtAt = meta.taught_at || meta?.teaching?.taught_at || nowIso
    meta.taught_at = taughtAt
    meta.last_taught_at = nowIso
    meta.learning_agents = learningAgents
    if (runId) meta.last_taught_run_id = runId
    meta.teaching = {
      ...(meta.teaching && typeof meta.teaching === 'object' ? meta.teaching : {}),
      taught_at: taughtAt,
      last_taught_at: nowIso,
      run_id: runId || meta?.teaching?.run_id || meta.amy_run_id || null,
      agents: learningAgents,
      receipt: receipt && typeof receipt === 'object' ? receipt : (meta?.teaching?.receipt || null),
    }
    await upsertSection.run(profileId, METADATA_SECTION_KEY, JSON.stringify(meta), SECTION_WRITER, nowIso, nowIso)
    result.updated += 1
    result.ids.push(profileId)
  }

  return result
}

const DEPENDENT_TABLES = [
  ['profile_documents', 'profile_id'],
  ['documents', 'profile_id'],
  ['grants', 'profile_id'],
  ['crawler_jobs', 'profile_id'],
  ['profile_opportunity_matches', 'profile_id'],
  ['profile_sections', 'profile_id'],
]

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function deletedCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0) || 0
}

function isMissingOptionalRelation(error) {
  const text = String(error?.message || error).toLowerCase()
  return /no such table|no such column|does not exist|undefined table|undefined column/.test(text)
}

async function discoverProfileDependentTables(db) {
  let rows
  if (db?.dialect === 'postgres') {
    rows = await db.prepare(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema()
          AND c.column_name = 'profile_id'
          AND t.table_type = 'BASE TABLE'`,
    ).all()
  } else {
    try {
      // SQLite's table-valued pragma discovers new profile-owned tables without
      // another hand-maintained cleanup migration.
      rows = await db.prepare(
        `SELECT DISTINCT m.name AS table_name
           FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type = 'table'
            AND m.name NOT LIKE 'sqlite_%'
            AND c.name = 'profile_id'`,
      ).all()
    } catch (sqliteErr) {
      // A dialect-neutral test double may omit `dialect`; try the production
      // Postgres catalog before declaring discovery unavailable.
      try {
        rows = await db.prepare(
          `SELECT c.table_name
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = current_schema()
              AND c.column_name = 'profile_id'
              AND t.table_type = 'BASE TABLE'`,
        ).all()
      } catch {
        throw sqliteErr
      }
    }
  }
  return [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.table_name || ''))
    .filter((table) => SAFE_IDENTIFIER.test(table) && table !== 'profiles'))]
}

async function withAmyDeleteTransaction(db, work) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction(work)
  if (typeof db?.exec === 'function') {
    await db.exec('BEGIN')
    try {
      const result = await work(db)
      await db.exec('COMMIT')
      return result
    } catch (err) {
      try { await db.exec('ROLLBACK') } catch { /* preserve original failure */ }
      throw err
    }
  }
  // Production adapters always provide withTransaction/exec. This fallback is
  // retained for narrow test doubles, while still propagating every failure.
  return work(db)
}

async function deleteProfileRows(tx, table, profileId, savepointSequence) {
  const runDelete = () => tx.prepare(`DELETE FROM "${table}" WHERE profile_id = ?`).run(profileId)

  // PostgreSQL leaves a transaction in the failed state after any statement
  // error (including an FK ordering miss or a relation disappearing between
  // catalog discovery and DELETE). A JavaScript catch does not clear that
  // state. Isolate each speculative dependency-order delete in a savepoint so
  // it can be rolled back before the caller retries another table/order.
  if (tx?.dialect !== 'postgres') return runDelete()
  if (typeof tx?.exec !== 'function') {
    throw new Error('Amy PostgreSQL cleanup requires transaction savepoint support')
  }

  const savepoint = `amy_profile_delete_${savepointSequence}`
  await tx.exec(`SAVEPOINT ${savepoint}`)
  try {
    const result = await runDelete()
    await tx.exec(`RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (err) {
    try {
      await tx.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await tx.exec(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (savepointErr) {
      throw new Error(
        `Amy cleanup could not restore PostgreSQL transaction after ${table} failed: ${savepointErr?.message || savepointErr}`,
      )
    }
    throw err
  }
}

function hardDeleteAmyProfileSqlite(db, profileId) {
  const rows = db.prepare(
    `SELECT DISTINCT m.name AS table_name
       FROM sqlite_master m, pragma_table_info(m.name) c
      WHERE m.type = 'table'
        AND m.name NOT LIKE 'sqlite_%'
        AND c.name = 'profile_id'`,
  ).all()
  const discovered = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.table_name || ''))
    .filter((table) => SAFE_IDENTIFIER.test(table) && table !== 'profiles'))]
  const known = DEPENDENT_TABLES.map(([table]) => table)
  const discoveredSet = new Set(discovered)
  let pending = [...new Set([
    ...discovered.filter((table) => !known.includes(table)),
    ...known.filter((table) => discoveredSet.has(table)),
  ])]
  let dependentRows = 0

  while (pending.length > 0) {
    const deferred = []
    let progressed = false
    for (const table of pending) {
      if (!SAFE_IDENTIFIER.test(table)) throw new Error(`unsafe profile-dependent table identifier: ${table}`)
      try {
        // audit:allow dynamic-sql — catalog-derived and identifier-validated.
        dependentRows += deletedCount(db.prepare(`DELETE FROM "${table}" WHERE profile_id = ?`).run(profileId))
        progressed = true
      } catch (err) {
        if (isMissingOptionalRelation(err)) {
          progressed = true
          continue
        }
        deferred.push({ table, err })
      }
    }
    if (deferred.length > 0 && !progressed) {
      const first = deferred[0]
      throw new Error(`Amy dependent cleanup failed for ${first.table}: ${first.err?.message || first.err}`)
    }
    pending = deferred.map(({ table }) => table)
  }

  const profileDelete = db.prepare('DELETE FROM profiles WHERE id = ? AND created_by = ?').run(profileId, ORIGIN_CREATED_BY)
  if (deletedCount(profileDelete) !== 1) {
    throw new Error('Amy profile delete did not remove exactly one owned profile')
  }
  return { dependent_rows: dependentRows, dependent_tables: discovered.length }
}

/**
 * Hard-delete one Amy profile across every profile-owned table. The old fixed
 * six-table loop swallowed all child-delete errors, so a new relation could
 * strand synthetic survivors forever while the reaper kept retrying the same
 * incomplete delete. Discovery makes the relation inventory total; one
 * transaction makes cleanup all-or-nothing.
 */
export async function hardDeleteAmyProfile(db, profileId) {
  // better-sqlite3 statements are synchronous. Keep the complete discovery +
  // delete graph inside its native synchronous transaction so an `await`
  // cannot yield the shared connection while BEGIN is open and accidentally
  // commit/rollback an unrelated request's write.
  if (db?.dialect !== 'postgres' && typeof db?.transaction === 'function') {
    return db.transaction(() => hardDeleteAmyProfileSqlite(db, profileId))()
  }
  return withAmyDeleteTransaction(db, async (tx) => {
    const discovered = await discoverProfileDependentTables(tx)
    const known = DEPENDENT_TABLES.map(([table]) => table)
    const discoveredSet = new Set(discovered)
    // New relations first: they are commonly children of an older registered
    // table (for example an application artifact referencing a grant). Failed
    // constraint deletes are retried after the rest, yielding a dependency
    // order without maintaining a second schema graph in application code.
    // Only issue DELETEs for catalog-confirmed relations. The fixed registry
    // spans historical schemas, and probing its absent tables would itself
    // abort a PostgreSQL transaction before cleanup reached the real rows.
    let pending = [...new Set([
      ...discovered.filter((table) => !known.includes(table)),
      ...known.filter((table) => discoveredSet.has(table)),
    ])]
    let dependentRows = 0
    let savepointSequence = 0

    while (pending.length > 0) {
      const deferred = []
      let progressed = false
      for (const table of pending) {
        if (!SAFE_IDENTIFIER.test(table)) throw new Error(`unsafe profile-dependent table identifier: ${table}`)
        try {
          // audit:allow dynamic-sql — table comes only from the DB catalog or the
          // frozen registry and must pass SAFE_IDENTIFIER; profile id stays bound.
          const result = await deleteProfileRows(tx, table, profileId, savepointSequence++)
          dependentRows += deletedCount(result)
          progressed = true
        } catch (err) {
          // A migration may drop a catalog-confirmed optional relation between
          // discovery and DELETE. The savepoint above has already restored the
          // PostgreSQL transaction, so this race is safe to tolerate.
          if (isMissingOptionalRelation(err)) {
            progressed = true
            continue
          }
          deferred.push({ table, err })
        }
      }
      if (deferred.length > 0 && !progressed) {
        const first = deferred[0]
        throw new Error(`Amy dependent cleanup failed for ${first.table}: ${first.err?.message || first.err}`)
      }
      pending = deferred.map(({ table }) => table)
    }

    const profileDelete = await tx
      .prepare('DELETE FROM profiles WHERE id = ? AND created_by = ?')
      .run(profileId, ORIGIN_CREATED_BY)
    if (deletedCount(profileDelete) !== 1) {
      throw new Error('Amy profile delete did not remove exactly one owned profile')
    }
    return { dependent_rows: dependentRows, dependent_tables: discovered.length }
  })
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
 * @param {boolean} [opts.requireTaught=false] - HARD invariant: never delete a
 *        crawled profile until the Amy → mesh / finding-actor teaching receipt
 *        exists for all required agents.
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
export async function cleanupAmyProfiles(db, { runId = null, expiredOnly = false, force = false, dryRun = false, onlyIds = null, requireCrawled = false, requireTaught = false, minCrawledAgeMs = 0, neverCrawledMaxAgeMs = 0, now = new Date() } = {}) {
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
    if (requireTaught && crawledSignalIso && !hasRequiredTeachingReceipt(meta)) {
      // A failed mesh handoff must not create an immortal synthetic. Preserve
      // the receipt as deletion authority during its useful lifetime, then use
      // the same far-past-TTL bound as never-crawled recovery as a terminal
      // cleanup policy. A later run cannot reconstruct the original lesson.
      const maxAge = Number(neverCrawledMaxAgeMs) || 0
      const createdIso = meta?.created_at || meta?.expires_at || row.created_at
      const createdMs = createdIso ? Date.parse(createdIso) : NaN
      const terminallyExpired = maxAge > 0
        && Number.isFinite(createdMs)
        && Number.isFinite(nowMs)
        && (nowMs - createdMs) >= maxAge
        && isMetadataExpired(meta, now)
      if (!terminallyExpired) reasonsToSkip.push('not_taught')
    }
    // Guard 4b (race safety): don't reap a profile crawled so recently its run
    // could still be mid-flight / pre-learning. Expiry-independent — EXCEPT for
    // the starvation escalation below.
    //
    // STARVATION ESCALATION (2026-08-04, the b9ca2567 leak): every discovery
    // path refreshes the crawl signal (cross-profile matching, Robert's cycle,
    // the web-lane fleet sweep), so an EXPIRED synthetic that keeps being
    // re-discovered rides a fresh 6h grace on every nightly sweep and is never
    // reaped — prod row b9ca2567 (created 07-31, TTL expired 08-02) was still
    // live on 08-04, skipped `crawled_too_recently` night after night.
    // `classifySurvivorHold` (amyDeletionProof.js) already refuses to call that
    // hold legitimate past `neverCrawledMaxAgeMs` ("a synthetic still riding 6h
    // graces at that age is being starved by perpetual re-discovery, not
    // protected mid-flight") — this is the reaper-side mirror of that rule, so
    // the detector and the sweep agree. Narrow by construction: it fires only
    // when the row is BOTH past its TTL (isMetadataExpired) AND older than the
    // far-past-TTL bound (default 96h vs the 72h max TTL), and only for callers
    // that pass neverCrawledMaxAgeMs (the expired sweep / boot invariant);
    // an unexpired or younger row keeps the full mid-flight grace.
    if (minCrawledAgeMs > 0 && crawledSignalIso) {
      const crawledMs = Date.parse(crawledSignalIso)
      if (Number.isFinite(crawledMs) && Number.isFinite(nowMs) && (nowMs - crawledMs) < minCrawledAgeMs) {
        const maxAge = Number(neverCrawledMaxAgeMs) || 0
        const createdIso = meta?.created_at || meta?.expires_at || row.created_at
        const createdMs = createdIso ? Date.parse(createdIso) : NaN
        const starved =
          maxAge > 0 &&
          Number.isFinite(createdMs) &&
          Number.isFinite(nowMs) &&
          (nowMs - createdMs) >= maxAge &&
          isMetadataExpired(meta, now)
        // A crawl signal stamped AFTER the row's own TTL cannot be its training
        // run's crawl (owner 2026-09-05: synthetics "not deleted afterwards").
        // The grace exists to protect a run mid-flight between crawl and
        // learning; a nightly re-discovery of an already-expired synthetic is
        // not that, and honoring it renewed the grace every night until the
        // 96h starvation bound. The reaper's other guards (crawled, taught,
        // expired) still hold — this only stops a post-expiry re-crawl from
        // counting as protection.
        // Narrow by construction: Amy's OWN crawl marker (markProfileCrawled)
        // after expiry still holds the grace — that is a run mid-flight. Only
        // a signal that came from ANOTHER discovery path (profiles.
        // last_discovery_at advanced past the TTL while Amy's marker did not)
        // is a re-discovery, never a training crawl.
        const expiresMs = meta?.expires_at ? Date.parse(meta.expires_at) : NaN
        const amyCrawlMs = Date.parse(meta?.last_crawled_at || meta?.crawled_at || '')
        const rediscoveredAfterExpiry =
          Number.isFinite(expiresMs) &&
          crawledMs > expiresMs &&
          !(Number.isFinite(amyCrawlMs) && amyCrawlMs > expiresMs) &&
          isMetadataExpired(meta, now)
        if (!starved && !rediscoveredAfterExpiry) reasonsToSkip.push('crawled_too_recently')
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

/**
 * Canonical grace window for the standing expired-only sweep: never reap a
 * profile crawled within the last 6h — its training run (crawl → measure →
 * learn) could still be mid-flight. Deliberately wider than the nightly
 * sweep's default 2h (AMY_CLEANUP_GRACE_HOURS) because the expired sweep also
 * runs INSIDE runAmyTraining, concurrent with other agents' runs.
 */
export const AMY_EXPIRED_SWEEP_MIN_CRAWLED_AGE_MS = 6 * 60 * 60 * 1000

/**
 * Canonical resolution of AMY_NEVER_CRAWLED_MAX_AGE_HOURS (default 96h — far
 * past the 72h TTL max): the bounded escape hatch that lets a synthetic
 * profile which was created but NEVER successfully crawled (discovery
 * skipped/errored, or its run crashed) finally be reaped instead of
 * accumulating forever. 0 disables the never-crawled reap.
 */
export function amyNeverCrawledMaxAgeMs(env = process.env) {
  return Math.max(0, Number(env.AMY_NEVER_CRAWLED_MAX_AGE_HOURS ?? 96)) * 60 * 60 * 1000
}

/**
 * cleanupExpiredAmyProfiles — THE canonical expired-only sweep (no runId /
 * onlyIds scoping), shared by Amy's end-of-run second pass and the boot
 * invariant enforceAmySyntheticExpiry (backend/startup/enforceInvariants.js).
 *
 * WHY IT EXISTS (owner directive 2026-07-06 "make sure those profiles are
 * getting deleted afterwards"): the end-of-run cleanup is scoped to the ids
 * crawled in THAT run — when discovery skips/errors for the whole cohort the
 * id list is empty and it deletes NOTHING, and leftovers from prior runs are
 * permanently out of scope. This sweep reaps EXPIRED synthetics from ANY run
 * with every guard intact:
 *   - created_by='agent:amy' scope (inside listAmyProfiles) — non-Amy rows are
 *     never even scanned;
 *   - designated-profile / allow_sam_cleanup / synthetic guards;
 *   - requireCrawled with the bounded never-crawled TTL escape hatch;
 *   - requireTaught for any row that HAS been crawled (create → crawl → teach → delete);
 *   - 6h crawled grace so a mid-flight run is never reaped.
 */
export async function cleanupExpiredAmyProfiles(
  db,
  {
    now = new Date(),
    dryRun = false,
    minCrawledAgeMs = AMY_EXPIRED_SWEEP_MIN_CRAWLED_AGE_MS,
    neverCrawledMaxAgeMs = amyNeverCrawledMaxAgeMs(),
  } = {},
) {
  return cleanupAmyProfiles(db, {
    expiredOnly: true,
    requireCrawled: true,
    requireTaught: true,
    minCrawledAgeMs,
    neverCrawledMaxAgeMs,
    dryRun,
    now,
  })
}

export default {
  createAmyProfile,
  listAmyProfiles,
  markProfileCrawled,
  markProfilesTaught,
  cleanupAmyProfiles,
  cleanupExpiredAmyProfiles,
  hasRequiredTeachingReceipt,
  amyNeverCrawledMaxAgeMs,
}
