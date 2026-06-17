// backend/utils/repairOrphanedJobProfiles.js
//
// Find `crawler_jobs` rows that died with `Profile X not found` (i.e. the
// snapshot builder couldn't locate the linked profile) and repair them in
// place by:
//
//   1. Resolving the stored `profile_id` to a live `profiles` row using
//      `resolveProfileForId` (designated slug -> live UUID via display_name,
//      or re-seed). See backend/utils/profileResolver.js.
//   2. Updating `crawler_jobs.profile_id` to the live id.
//   3. Re-queueing the job (status='queued') with a unique idempotency key
//      and a `result_meta.repaired_*` audit trail so we never repair the
//      same row twice.
//
// Why this exists:
//   - Mission goal: "avoid zero-result experiences" / "missing fields default
//     to neutral, not exclusionary." Dead-lettering an entire run because the
//     dispatcher's snapshot lookup couldn't locate the live profile violates
//     both rules — the underlying live profile exists, and the run can finish.
//   - Without this, the only way to recover such jobs is to manually click
//     Retry on each one, which doesn't scale (the autonomous runner can
//     produce dozens per night).
//
// Safety rails:
//   - Only touches rows that ALREADY have status='failed' AND match the
//     "Profile X not found" error pattern (FK violations and other genuine
//     non-retryable errors are left alone).
//   - Skips any row whose `result_meta` already contains a `repaired_at`
//     value, so a repaired job that fails again for a *different* reason is
//     never re-touched.
//   - Caps the number of rows repaired per call (default 200).
//   - All updates are best-effort: if any single row fails, we log and
//     continue.

import crypto from 'crypto'
import { resolveProfileForId } from './profileResolver.js'

const PROFILE_NOT_FOUND_PATTERN = /profile\s.+?\snot found/i

function safeParseJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

/**
 * Repair `crawler_jobs` rows orphaned by stale designated-profile slugs.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.limit=200] - max rows scanned per call
 * @param {(msg: string, meta?: object) => void} [opts.log]
 * @returns {Promise<{ scanned: number, repaired: number, skipped: number, errors: number, details: Array<{ jobId: string, fromProfileId: string, toProfileId: string, strategy: string }> }>}
 */
export async function repairOrphanedJobProfiles(db, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(2000, opts.limit)) : 200
  const log = typeof opts.log === 'function' ? opts.log : (msg, meta) => {
    if (meta) console.info(msg, meta)
    else console.info(msg)
  }

  const summary = {
    scanned: 0,
    repaired: 0,
    skipped: 0,
    errors: 0,
    details: [],
  }

  if (!db) return summary

  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT id, profile_id, error, result_meta, idempotency_key
         FROM crawler_jobs
         WHERE status = 'failed'
           AND error IS NOT NULL
           AND profile_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit)
  } catch (queryErr) {
    log('[repairOrphanedJobProfiles] failed to read crawler_jobs (table may be missing); skipping', {
      error: queryErr?.message || String(queryErr),
    })
    return summary
  }

  if (!Array.isArray(rows) || rows.length === 0) return summary

  for (const row of rows) {
    summary.scanned += 1

    const errorMsg = String(row.error || '')
    if (!PROFILE_NOT_FOUND_PATTERN.test(errorMsg)) {
      summary.skipped += 1
      continue
    }

    const meta = safeParseJson(row.result_meta) || {}
    if (meta && meta.repaired_at) {
      // Already repaired in a previous startup — leave alone.
      summary.skipped += 1
      continue
    }

    let resolved = null
    try {
      resolved = await resolveProfileForId(db, row.profile_id)
    } catch (resolveErr) {
      summary.errors += 1
      log('[repairOrphanedJobProfiles] resolver threw, skipping row', {
        jobId: row.id,
        profileId: row.profile_id,
        error: resolveErr?.message || String(resolveErr),
      })
      continue
    }

    if (!resolved) {
      // No live profile — leave the row failed. The underlying issue is real
      // (orphaned id with no alias). Mark we tried so we don't retry next
      // boot with the same data.
      summary.skipped += 1
      continue
    }

    const newProfileId = resolved.resolvedId
    const newMeta = {
      ...(meta && typeof meta === 'object' ? meta : {}),
      non_retryable: false,
      repaired_at: new Date().toISOString(),
      repaired_from_profile_id: row.profile_id,
      repaired_to_profile_id: newProfileId,
      repair_strategy: resolved.strategy,
    }

    // Avoid colliding with an existing queued/running job's idempotency key
    // (the resolver may map several stale slugs to the same live UUID, and
    // an unrelated queued job may already share that key).
    const newIdempotencyKey =
      `repaired_${row.id.replace(/-/g, '').slice(0, 16)}_${Date.now().toString(36)}`

    try {
      await db
        .prepare(
          `UPDATE crawler_jobs
           SET profile_id = ?,
               status = 'queued',
               error = NULL,
               started_at = NULL,
               completed_at = NULL,
               worker_id = NULL,
               retry_count = COALESCE(retry_count, 0),
               result_meta = ?,
               idempotency_key = ?
           WHERE id = ?
             AND status = 'failed'`,
        )
        .run(newProfileId, JSON.stringify(newMeta), newIdempotencyKey, row.id)

      summary.repaired += 1
      summary.details.push({
        jobId: row.id,
        fromProfileId: row.profile_id,
        toProfileId: newProfileId,
        strategy: resolved.strategy,
      })

      log('[repairOrphanedJobProfiles] re-queued orphaned job', {
        jobId: row.id,
        from: row.profile_id,
        to: newProfileId,
        strategy: resolved.strategy,
      })
    } catch (updateErr) {
      summary.errors += 1
      log('[repairOrphanedJobProfiles] update failed, skipping row', {
        jobId: row.id,
        error: updateErr?.message || String(updateErr),
      })
    }
  }

  if (summary.repaired > 0) {
    log('[repairOrphanedJobProfiles] summary', {
      scanned: summary.scanned,
      repaired: summary.repaired,
      skipped: summary.skipped,
      errors: summary.errors,
    })
  }

  return summary
}

export default repairOrphanedJobProfiles
