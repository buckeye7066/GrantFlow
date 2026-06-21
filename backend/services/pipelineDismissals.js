/**
 * Pipeline Dismissals service.
 *
 * Sticky deletes for the per-profile funding pipeline. When a user removes
 * a grant from their pipeline, we record a tombstone keyed on
 * (profile_id, fingerprint, opportunity_id, source_url, title) so the
 * matcher / Process All / re-crawl loop never resurrects the same source
 * for that profile.
 *
 * Manual re-add (POST /api/grants/from-opportunity) clears the matching
 * tombstone, so users can deliberately bring a source back.
 *
 * Self-healing schema: ensurePipelineDismissalsSchema runs the same SQL
 * as migration 071/0065 idempotently, so the feature works even on
 * databases where the migration runner hasn't been invoked yet (the same
 * recall-over-suppression posture we use for saved_grants).
 */

import crypto from 'node:crypto'
import {
  grantFingerprintFromOpportunity,
  chooseGrantUrl,
} from '../utils/grantFingerprint.js'
import { createLogger } from '../utils/logger.js'
import { recordBehaviorEvent } from './behaviorLearning.js'

const log = createLogger('service:pipelineDismissals')

const ensuredDbs = new WeakSet()
const ensurePromises = new WeakMap()

export async function ensurePipelineDismissalsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredDbs.has(db)) return
  if (ensurePromises.has(db)) return ensurePromises.get(db)

  const ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'
    const createTable = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS pipeline_dismissals (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            fingerprint TEXT,
            opportunity_id TEXT,
            source_url TEXT,
            title TEXT,
            reason TEXT,
            dismissed_by TEXT,
            dismissed_at TIMESTAMPTZ DEFAULT now()
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS pipeline_dismissals (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            fingerprint TEXT,
            opportunity_id TEXT,
            source_url TEXT,
            title TEXT,
            reason TEXT,
            dismissed_by TEXT,
            dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `

    await db.prepare(createTable).run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_profile ON pipeline_dismissals(profile_id);')
      .run()
    await db
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_fingerprint ON pipeline_dismissals(profile_id, fingerprint);',
      )
      .run()
    await db
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_pipeline_dismissals_opp ON pipeline_dismissals(profile_id, opportunity_id);',
      )
      .run()
    // Partial unique index to keep one tombstone per (profile, fingerprint).
    // Best-effort — some Postgres permission setups reject CREATE UNIQUE
    // INDEX IF NOT EXISTS with WHERE clauses; we tolerate that and let the
    // recordDismissal upsert path enforce dedup at write time instead.
    try {
      await db
        .prepare(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_dismissals_unique_fp ON pipeline_dismissals(profile_id, fingerprint) WHERE fingerprint IS NOT NULL;",
        )
        .run()
    } catch (err) {
      log.warn('partial unique index not created (non-fatal)', { error: String(err?.message || err) })
    }

    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)
  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}

function normString(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

function normTitleKey(v) {
  const s = normString(v)
  return s ? s.toLowerCase() : null
}

/**
 * Compute a tombstone key from a grant row joined with its source opportunity
 * (when the FK still resolves). Returns at least one of {fingerprint,
 * opportunity_id, source_url, title}.
 */
export function buildDismissalKey({ grantRow = null, opportunity = null } = {}) {
  const merged = {
    title: grantRow?.title ?? opportunity?.title ?? null,
    funder: grantRow?.funder ?? opportunity?.sponsor ?? opportunity?.funder ?? null,
    deadline: grantRow?.deadline ?? opportunity?.deadline ?? null,
    url:
      grantRow?.url
      ?? grantRow?.application_url
      ?? opportunity?.application_url
      ?? opportunity?.url
      ?? null,
    application_url: grantRow?.application_url ?? opportunity?.application_url ?? null,
    source_url: grantRow?.source_url ?? opportunity?.source_url ?? null,
  }
  // grantFingerprintFromOpportunity uses opportunity.title/sponsor/deadline/url-ish fields.
  let fingerprint = null
  try {
    fingerprint = grantFingerprintFromOpportunity({
      title: merged.title,
      sponsor: merged.funder,
      deadline: merged.deadline,
      url: merged.url,
      application_url: merged.application_url,
      source_url: merged.source_url,
    })
  } catch {
    fingerprint = null
  }
  const sourceUrl = chooseGrantUrl({ ...merged, url: merged.url, application_url: merged.application_url, source_url: merged.source_url })
  return {
    fingerprint,
    opportunity_id: normString(grantRow?.funding_opportunity_id ?? opportunity?.id ?? null),
    source_url: sourceUrl ?? normString(merged.source_url) ?? normString(merged.application_url),
    title: normString(merged.title),
  }
}

/**
 * Record a tombstone for (profile, opportunity). Idempotent — repeated calls
 * for the same key are a no-op thanks to the partial unique index plus a
 * pre-check for non-fingerprint matches.
 */
export async function recordDismissal(
  db,
  { profileId, grantRow = null, opportunity = null, userId = null, reason = null } = {},
) {
  if (!db) return { recorded: false, reason: 'no_db' }
  const profile = normString(profileId)
  if (!profile) return { recorded: false, reason: 'no_profile_id' }

  await ensurePipelineDismissalsSchema(db)

  const key = buildDismissalKey({ grantRow, opportunity })
  const hasAnyKey = key.fingerprint || key.opportunity_id || key.source_url || key.title
  if (!hasAnyKey) {
    log.warn('refusing to record dismissal with no identifying key', { profileId: profile })
    return { recorded: false, reason: 'no_identity_key' }
  }

  // Non-fingerprint pre-check (idempotency for legacy rows that lack URLs)
  const existing = await findDismissal(db, profile, key)
  if (existing) {
    return { recorded: true, alreadyExisted: true, key }
  }

  const id = crypto.randomUUID()
  try {
    await db
      .prepare(
        `INSERT INTO pipeline_dismissals
           (id, profile_id, fingerprint, opportunity_id, source_url, title, reason, dismissed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        profile,
        key.fingerprint,
        key.opportunity_id,
        key.source_url,
        key.title,
        normString(reason),
        normString(userId),
      )
  } catch (err) {
    // Race with the unique partial index — treat as already-recorded.
    const msg = String(err?.message || '')
    if (/unique/i.test(msg) || /duplicate key/i.test(msg)) {
      return { recorded: true, alreadyExisted: true, key }
    }
    log.error('failed to record pipeline dismissal', { profileId: profile, error: msg })
    throw err
  }

  // SOFT user-behavior learning (architecture #12): a dismiss/reject nudges
  // future matching AWAY from this opportunity's categories/needs/source (e.g.
  // rejecting a loan ↓ loan-like sources). Best-effort — never throws, never
  // changes this function's behavior or return value.
  recordBehaviorEvent(db, {
    profileId: profile,
    action: 'dismissed',
    opportunity: opportunity ?? grantRow ?? null,
  }).catch(() => {})

  return { recorded: true, alreadyExisted: false, key, id }
}

/**
 * Returns the matching tombstone row or null. Match priority:
 *   1. fingerprint exact match
 *   2. opportunity_id exact match
 *   3. (lower(title), source_url) match
 *   4. lower(title) only match (last resort, blocks re-add of synthetic rows
 *      whose URL drifts between crawls)
 */
export async function findDismissal(db, profileId, opportunityOrKey) {
  if (!db || !profileId) return null
  await ensurePipelineDismissalsSchema(db)

  const key = opportunityOrKey?.fingerprint !== undefined
    ? opportunityOrKey
    : buildDismissalKey({ opportunity: opportunityOrKey })

  if (key.fingerprint) {
    const row = await db
      .prepare(
        'SELECT * FROM pipeline_dismissals WHERE profile_id = ? AND fingerprint = ? LIMIT 1',
      )
      .get(profileId, key.fingerprint)
    if (row) return row
  }

  if (key.opportunity_id) {
    const row = await db
      .prepare(
        'SELECT * FROM pipeline_dismissals WHERE profile_id = ? AND opportunity_id = ? LIMIT 1',
      )
      .get(profileId, key.opportunity_id)
    if (row) return row
  }

  const titleKey = normTitleKey(key.title)
  if (titleKey && key.source_url) {
    const row = await db
      .prepare(
        'SELECT * FROM pipeline_dismissals WHERE profile_id = ? AND lower(title) = ? AND source_url = ? LIMIT 1',
      )
      .get(profileId, titleKey, key.source_url)
    if (row) return row
  }

  if (titleKey) {
    const row = await db
      .prepare(
        'SELECT * FROM pipeline_dismissals WHERE profile_id = ? AND lower(title) = ? LIMIT 1',
      )
      .get(profileId, titleKey)
    if (row) return row
  }

  return null
}

export async function isDismissed(db, profileId, opportunity) {
  const row = await findDismissal(db, profileId, opportunity)
  return Boolean(row)
}

/**
 * Remove tombstones for an opportunity / profile pair. Called when a user
 * deliberately re-adds a previously-dismissed source via the manual
 * "from-opportunity" route. Returns the number of rows cleared.
 */
export async function clearDismissal(db, profileId, opportunity) {
  if (!db || !profileId) return 0
  await ensurePipelineDismissalsSchema(db)

  const key = buildDismissalKey({ opportunity })
  const conditions = []
  const params = []
  if (key.fingerprint) {
    conditions.push('fingerprint = ?')
    params.push(key.fingerprint)
  }
  if (key.opportunity_id) {
    conditions.push('opportunity_id = ?')
    params.push(key.opportunity_id)
  }
  const titleKey = normTitleKey(key.title)
  if (titleKey) {
    conditions.push('lower(title) = ?')
    params.push(titleKey)
  }
  if (conditions.length === 0) return 0

  const sql = `DELETE FROM pipeline_dismissals WHERE profile_id = ? AND (${conditions.join(' OR ')})`
  const result = await db.prepare(sql).run(profileId, ...params)
  const changes = Number(result?.changes ?? result?.rowCount ?? 0)
  return Number.isFinite(changes) ? changes : 0
}

/**
 * GLOBAL ENFORCEMENT SWEEP — reconcile the pipeline against every tombstone.
 *
 * Deletes any grant that matches a recorded dismissal for its own profile,
 * regardless of how it got (re-)inserted. This is the rule-by-construction
 * backstop for "a user-deleted source must stay gone": instead of trusting
 * every current and future insert path to remember the DISMISSED gate, we
 * re-assert the invariant in one place. Safe to run on every boot.
 *
 * Matching mirrors findDismissal() priority, profile-scoped throughout:
 *   - opportunity_id exact
 *   - fingerprint exact
 *   - lower(title) exact (last-resort, blocks URL-drifting re-crawls)
 *
 * A manual re-add (POST /api/grants/from-opportunity) clears the tombstone
 * first, so deliberately restored sources are never purged by this sweep.
 *
 * Returns the number of resurrected rows removed.
 */
export async function reconcileDismissedGrants(db, { limit = 100000 } = {}) {
  if (!db || typeof db.prepare !== 'function') return 0
  await ensurePipelineDismissalsSchema(db)

  // One set-based statement, valid on both SQLite and Postgres. lower() and
  // the correlated EXISTS are portable; we scope every comparison to the same
  // profile_id so a tombstone in one profile can never delete another's grant.
  const sql = `
    DELETE FROM grants
    WHERE profile_id IS NOT NULL
      AND id IN (
        SELECT g.id
        FROM grants g
        JOIN pipeline_dismissals d ON d.profile_id = g.profile_id
        WHERE
          (d.opportunity_id IS NOT NULL AND g.funding_opportunity_id IS NOT NULL
             AND d.opportunity_id = g.funding_opportunity_id)
          OR (d.fingerprint IS NOT NULL AND g.fingerprint IS NOT NULL
             AND d.fingerprint = g.fingerprint)
          OR (d.title IS NOT NULL AND g.title IS NOT NULL
             AND lower(d.title) = lower(g.title))
        LIMIT ${Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 100000}
      )
  `
  try {
    const result = await db.prepare(sql).run()
    const removed = Number(result?.changes ?? result?.rowCount ?? 0)
    if (removed > 0) {
      log.info('reconcileDismissedGrants: purged resurrected pipeline grants', { removed })
    }
    return Number.isFinite(removed) ? removed : 0
  } catch (err) {
    // Some Postgres configs reject LIMIT inside a DELETE...IN subselect; retry
    // without the LIMIT before giving up (recall-over-crash: never abort boot).
    const msg = String(err?.message || '')
    if (/LIMIT|syntax/i.test(msg)) {
      try {
        const noLimitSql = sql.replace(/\s+LIMIT\s+\d+\s*\n/, '\n')
        const result = await db.prepare(noLimitSql).run()
        const removed = Number(result?.changes ?? result?.rowCount ?? 0)
        if (removed > 0) log.info('reconcileDismissedGrants: purged (no-limit fallback)', { removed })
        return Number.isFinite(removed) ? removed : 0
      } catch (retryErr) {
        log.error('reconcileDismissedGrants failed (fallback)', { error: String(retryErr?.message || retryErr) })
        return 0
      }
    }
    log.error('reconcileDismissedGrants failed', { error: msg })
    return 0
  }
}

/**
 * Diagnostic: count tombstones for a profile.
 */
export async function countDismissals(db, profileId) {
  if (!db || !profileId) return 0
  await ensurePipelineDismissalsSchema(db)
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM pipeline_dismissals WHERE profile_id = ?')
    .get(profileId)
  return Number(row?.n ?? 0)
}
