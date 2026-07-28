/**
 * portalCompletionStore.js
 *
 * Persisted per-profile portal MERGE/COMPLETION state for the Portals dashboard.
 *
 * WHY A SEPARATE STORE: profilePortalIndex.js derives the portal TILES live
 * (which hosts apply, login URLs, green/red ready status). That derivation has
 * no notion of where the user is in the funding-source application lifecycle.
 * The owner asked for two NEW, distinct states a tile can carry:
 *
 *   - "complete"  — the user has uploaded/linked a COMPLETED application for a
 *                   funding source (e.g. a completed FAFSA link). The portal's
 *                   application is done, but its results have NOT yet been pulled
 *                   into the profile.  completed ≠ merged.
 *   - "merged"    — the portal's data has been pulled into the profile (a
 *                   two-way portalSync run merged its awards/fields). This is the
 *                   terminal state and is the ONLY state excluded from the weekly
 *                   "you still have unmerged portals" reminder.
 *
 * Anything that is neither complete nor merged is "unmerged" (the implicit
 * default — there is simply no row, or a row that was reset). The Monday-morning
 * reminder (mondayPortalReminder.js) selects portals that are NOT merged.
 *
 * The table is keyed on (profile_id, portal_host) — the same registrable-host
 * key profilePortalIndex.js uses — so a status attaches to exactly the tile it
 * describes. Self-healing schema (mirrors portalSync/store.js) so the feature
 * works on a DB where the migration runner hasn't run yet; the canonical DDL
 * also lives in ensureSchemaInvariants.js + migration 124 / pg 0125.
 *
 * Nothing here drives a portal or returns a secret — it only records + reports
 * lifecycle state. Callers verify profile access before writing.
 */

import { registrableDomain } from './hamiltonPortalCredentialService.js'
import { normalizeHost } from './hamiltonCredentialSessionService.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:portal-completion-store')

// The lifecycle states. "unmerged" is the implicit default (no row).
export const PORTAL_STATUS = Object.freeze({
  UNMERGED: 'unmerged',
  COMPLETE: 'complete', // application complete, NOT yet merged
  // A sync genuinely pulled SOME data in, but the connector cannot certify it
  // read every required domain (2026-07-28 audit #19): a portal is not "merged"
  // on one field/award write. Non-terminal — still reminder-eligible — but
  // honestly distinct from "nothing synced".
  PARTIALLY_SYNCED: 'partially_synced',
  MERGED: 'merged', // ALL required domains pulled into the profile (terminal)
})

const VALID_STATUSES = new Set(Object.values(PORTAL_STATUS))

// Per-db WeakMap cache (not a process-global boolean) so concurrent test suites
// each with their own in-memory db never race on a shared flag. Mirrors
// portalSync/store.js + profilePortalIndex.js.
let schemaReady = new WeakMap()
export function _resetPortalCompletionSchemaCache() { schemaReady = new WeakMap() }

export async function ensurePortalCompletionSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS profile_portal_status (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unmerged',
      source TEXT,
      evidence TEXT,
      grant_id TEXT,
      document_id TEXT,
      completed_at ${tsType},
      merged_at ${tsType},
      last_reminded_at ${tsType},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_profile_portal_status_profile
      ON profile_portal_status(profile_id);
    CREATE INDEX IF NOT EXISTS idx_profile_portal_status_status
      ON profile_portal_status(status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_portal_status_profile_host
      ON profile_portal_status(profile_id, portal_host);
  `)
  schemaReady.set(db, true)
}

/** Normalize an input host/URL to the registrable-host key the tiles use. */
export function portalStatusKeyHost(input) {
  if (!input) return ''
  return registrableDomain(input) || normalizeHost(input) || ''
}

function rowToStatus(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    portal_host: row.portal_host,
    status: row.status || PORTAL_STATUS.UNMERGED,
    source: row.source || null,
    evidence: row.evidence || null,
    grant_id: row.grant_id || null,
    document_id: row.document_id || null,
    completed_at: row.completed_at || null,
    merged_at: row.merged_at || null,
    last_reminded_at: row.last_reminded_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

/** Read a single (profile, host) status row, or null. */
export async function getPortalStatus(db, profileId, portalHost) {
  if (!db || !profileId || !portalHost) return null
  await ensurePortalCompletionSchema(db)
  const host = portalStatusKeyHost(portalHost)
  if (!host) return null
  try {
    const row = await db.prepare(
      'SELECT * FROM profile_portal_status WHERE profile_id = ? AND portal_host = ? LIMIT 1',
    ).get(String(profileId), host)
    return rowToStatus(row)
  } catch (err) {
    log.warn('get_portal_status_failed', { err: err?.message })
    return null
  }
}

/** Map of host -> status row for a profile (used to annotate the portals list). */
export async function getPortalStatusMap(db, profileId) {
  const out = new Map()
  if (!db || !profileId) return out
  await ensurePortalCompletionSchema(db)
  try {
    const rows = await db.prepare(
      'SELECT * FROM profile_portal_status WHERE profile_id = ?',
    ).all(String(profileId))
    for (const r of rows || []) out.set(String(r.portal_host), rowToStatus(r))
  } catch (err) {
    log.warn('get_portal_status_map_failed', { err: err?.message })
  }
  return out
}

/**
 * Upsert a portal's lifecycle status. Idempotent on (profile_id, portal_host).
 * Stamps completed_at / merged_at only on the transition INTO that state (so the
 * timestamp records when it first happened, not the last write).
 *
 * @returns the upserted status row, or null on bad input.
 */
export async function setPortalStatus(db, {
  profileId, portalHost, status,
  source = null, evidence = null, grantId = null, documentId = null,
} = {}) {
  if (!db || !profileId || !portalHost) return null
  const host = portalStatusKeyHost(portalHost)
  if (!host) return null
  const next = String(status || '').trim().toLowerCase()
  if (!VALID_STATUSES.has(next)) {
    log.warn('set_portal_status_invalid', { status, host })
    return null
  }
  await ensurePortalCompletionSchema(db)
  const isPostgres = db?.dialect === 'postgres'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'

  const existing = await getPortalStatus(db, profileId, host)
  const completedStamp = next === PORTAL_STATUS.COMPLETE && existing?.status !== PORTAL_STATUS.COMPLETE
  const mergedStamp = next === PORTAL_STATUS.MERGED && existing?.status !== PORTAL_STATUS.MERGED

  if (existing) {
    await db.prepare(
      `UPDATE profile_portal_status
          SET status = ?,
              source = COALESCE(?, source),
              evidence = COALESCE(?, evidence),
              grant_id = COALESCE(?, grant_id),
              document_id = COALESCE(?, document_id),
              completed_at = ${completedStamp ? nowFn : 'completed_at'},
              merged_at = ${mergedStamp ? nowFn : 'merged_at'},
              updated_at = ${nowFn}
        WHERE profile_id = ? AND portal_host = ?`,
    ).run(
      next, source, evidence, grantId, documentId,
      String(profileId), host,
    )
  } else {
    await db.prepare(
      `INSERT INTO profile_portal_status
         (profile_id, portal_host, status, source, evidence, grant_id, document_id,
          completed_at, merged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${completedStamp ? nowFn : 'NULL'}, ${mergedStamp ? nowFn : 'NULL'}, ${nowFn}, ${nowFn})
       ON CONFLICT(profile_id, portal_host) DO UPDATE SET
          status = excluded.status,
          source = COALESCE(excluded.source, profile_portal_status.source),
          evidence = COALESCE(excluded.evidence, profile_portal_status.evidence),
          grant_id = COALESCE(excluded.grant_id, profile_portal_status.grant_id),
          document_id = COALESCE(excluded.document_id, profile_portal_status.document_id),
          completed_at = COALESCE(excluded.completed_at, profile_portal_status.completed_at),
          merged_at = COALESCE(excluded.merged_at, profile_portal_status.merged_at),
          updated_at = ${nowFn}`,
    ).run(String(profileId), host, next, source, evidence, grantId, documentId)
  }
  return getPortalStatus(db, profileId, host)
}

/**
 * Mark a portal COMPLETE (application done, NOT merged). Refuses to downgrade a
 * portal that is already MERGED — once data is pulled in, a later "completed"
 * signal must not regress it to a reminder-eligible state.
 */
export async function markPortalComplete(db, opts = {}) {
  const existing = await getPortalStatus(db, opts.profileId, opts.portalHost)
  if (existing?.status === PORTAL_STATUS.MERGED) return existing
  return setPortalStatus(db, { ...opts, status: PORTAL_STATUS.COMPLETE })
}

/**
 * Mark a portal MERGED (terminal — excluded from reminders).
 *
 * TRUTHFUL-MERGE GUARD (owner: "ensure when the merge happens, it is true"):
 * `merged` is the only state that ENDS the weekly reminder, so it must never be
 * set on a loose inference. A merge is recorded ONLY with an explicit
 * confirmation signal proving the portal's data was genuinely pulled/linked into
 * the profile — one of:
 *   - a real portal-sync READ that succeeded (evidence carries the run), OR
 *   - an explicit human confirmation from the dashboard ("I merged this").
 * Without that signal we refuse and leave the portal not-merged (still reminded).
 * Pass { confirmed: true } (human) or a truthy `evidence`/`syncRunId`/`documentId`
 * proving the merge. A bare markPortalMerged() with no proof is rejected.
 *
 * @returns the merged status row, or null when the merge is unconfirmed (refused).
 */
export async function markPortalMerged(db, opts = {}) {
  const confirmed = opts.confirmed === true || opts.confirmed === 1 || opts.confirmed === 'true'
  const hasProof = Boolean(opts.evidence || opts.syncRunId || opts.documentId || opts.grantId)
  if (!confirmed && !hasProof) {
    log.warn('merge_refused_unconfirmed', {
      profileId: String(opts.profileId || ''),
      host: portalStatusKeyHost(opts.portalHost),
      source: opts.source || null,
    })
    return null
  }
  // Persist the proof so the merge is auditable (why it was considered true).
  const evidence = opts.evidence
    || (opts.syncRunId ? `portal_sync_run:${opts.syncRunId}` : null)
    || (confirmed ? 'human_confirmed' : null)
  return setPortalStatus(db, { ...opts, evidence, status: PORTAL_STATUS.MERGED })
}

/**
 * Mark a portal PARTIALLY_SYNCED — a real sync pulled data in, but the
 * connector could not certify every required read domain (2026-07-28 audit).
 * Non-terminal: still reminder-eligible, but the tile reads "partially synced"
 * instead of a false "merged" or a misleading "unmerged". Refuses to downgrade
 * an already-MERGED portal, and requires the same proof a merge does.
 *
 * @returns the status row, or null when unconfirmed (refused).
 */
export async function markPortalPartiallySynced(db, opts = {}) {
  const existing = await getPortalStatus(db, opts.profileId, opts.portalHost)
  if (existing?.status === PORTAL_STATUS.MERGED) return existing
  const confirmed = opts.confirmed === true || opts.confirmed === 1 || opts.confirmed === 'true'
  const hasProof = Boolean(opts.evidence || opts.syncRunId || opts.documentId || opts.grantId)
  if (!confirmed && !hasProof) {
    log.warn('partial_sync_refused_unconfirmed', {
      profileId: String(opts.profileId || ''),
      host: portalStatusKeyHost(opts.portalHost),
      source: opts.source || null,
    })
    return null
  }
  const evidence = opts.evidence
    || (opts.syncRunId ? `portal_sync_run:${opts.syncRunId}` : null)
    || (confirmed ? 'human_confirmed' : null)
  return setPortalStatus(db, { ...opts, evidence, status: PORTAL_STATUS.PARTIALLY_SYNCED })
}

/** Record that we sent a reminder for this portal (idempotency / audit). */
export async function recordReminderSent(db, profileId, portalHost) {
  if (!db || !profileId || !portalHost) return
  const host = portalStatusKeyHost(portalHost)
  if (!host) return
  await ensurePortalCompletionSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  // Ensure a row exists so the reminder timestamp has somewhere to live even for
  // an implicitly-unmerged portal (no prior status row).
  const existing = await getPortalStatus(db, profileId, host)
  if (!existing) {
    await db.prepare(
      `INSERT INTO profile_portal_status (profile_id, portal_host, status, last_reminded_at, created_at, updated_at)
       VALUES (?, ?, 'unmerged', ${nowFn}, ${nowFn}, ${nowFn})
       ON CONFLICT(profile_id, portal_host) DO UPDATE SET
          last_reminded_at = ${nowFn},
          updated_at = ${nowFn}`,
    ).run(String(profileId), host)
    return
  }
  await db.prepare(
    `UPDATE profile_portal_status SET last_reminded_at = ${nowFn}, updated_at = ${nowFn}
      WHERE profile_id = ? AND portal_host = ?`,
  ).run(String(profileId), host)
}

export default {
  PORTAL_STATUS,
  ensurePortalCompletionSchema,
  portalStatusKeyHost,
  getPortalStatus,
  getPortalStatusMap,
  setPortalStatus,
  markPortalComplete,
  markPortalMerged,
  recordReminderSent,
  _resetPortalCompletionSchemaCache,
}
