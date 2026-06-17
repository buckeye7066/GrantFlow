// backend/utils/profileResolver.js
//
// Resolve a `profile_id` value (which may be a designated-profile slug, a UUID,
// or a stale id from a tombstoned/migrated row) to a *live* row in the
// `profiles` table.
//
// This exists because crawler jobs (and similar deferred work) get enqueued
// with whatever profile id was active at creation time. By the time the
// dispatcher picks the job up, the profile may have been re-keyed (e.g. seed
// slug -> UUID), tombstoned, or otherwise relocated. Hard-failing in that case
// produces a non-retryable dead job and violates the GrantFlow goal of
// "real funding only / avoid zero-result experiences".
//
// Resolution order:
//   1. Direct lookup by id.
//   2. If id matches a `DESIGNATED_PROFILES` config slug, look up by the
//      configured `display_name` (case-insensitive exact match).
//   3. If still not found AND the id is a designated slug, attempt to seed the
//      designated profile (idempotent), then retry direct lookup.
//
// Returns `null` if nothing matched. Otherwise returns:
//   { profile, originalId, resolvedId, repaired, strategy }
// where:
//   - `repaired === true` means `originalId !== resolvedId` (i.e. caller
//     should persist the new id back into `crawler_jobs.profile_id`).
//   - `strategy` is one of: 'direct', 'designated_display_name', 'reseed'.

import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { ensureDesignatedProfiles } from './ensureDesignatedProfiles.js'

const DESIGNATED_BY_ID = new Map(
  (Array.isArray(DESIGNATED_PROFILES) ? DESIGNATED_PROFILES : []).map((p) => [
    String(p?.id || '').trim(),
    p,
  ]),
)

async function selectProfileById(db, id) {
  if (!id) return null
  try {
    const row = await db
      .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
      .get(id)
    return row || null
  } catch {
    return null
  }
}

async function selectProfileByDisplayName(db, displayName) {
  if (!displayName) return null
  try {
    // Exact match first (case-insensitive). Avoid LIKE patterns to keep the
    // resolution deterministic and prevent accidentally matching the wrong
    // family member.
    const row = await db
      .prepare(
        `SELECT * FROM profiles
         WHERE LOWER(display_name) = LOWER(?)
           AND (status IS NULL OR status <> 'deleted')
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(displayName)
    return row || null
  } catch {
    return null
  }
}

/**
 * Resolve a profile id to a live `profiles` row. See file header for details.
 *
 * @param {object} db
 * @param {string} profileId
 * @param {object} [opts]
 * @param {boolean} [opts.allowReseed=true] - permit re-seeding designated
 *   profiles when nothing else matches. Set false for read-only callers
 *   (e.g. tests, telemetry) that must not mutate the DB.
 * @returns {Promise<null | {
 *   profile: object,
 *   originalId: string,
 *   resolvedId: string,
 *   repaired: boolean,
 *   strategy: 'direct' | 'designated_display_name' | 'reseed'
 * }>}
 */
export async function resolveProfileForId(db, profileId, opts = {}) {
  const { allowReseed = true } = opts
  const id = String(profileId || '').trim()
  if (!db || !id) return null

  // 1. Direct lookup.
  const direct = await selectProfileById(db, id)
  if (direct) {
    return {
      profile: direct,
      originalId: id,
      resolvedId: String(direct.id),
      repaired: false,
      strategy: 'direct',
    }
  }

  // 2. Designated config -> display_name lookup.
  const designated = DESIGNATED_BY_ID.get(id)
  if (designated && designated.display_name) {
    const aliased = await selectProfileByDisplayName(db, designated.display_name)
    if (aliased) {
      return {
        profile: aliased,
        originalId: id,
        resolvedId: String(aliased.id),
        repaired: String(aliased.id) !== id,
        strategy: 'designated_display_name',
      }
    }
  }

  // 3. Re-seed designated profile (best effort).
  if (allowReseed && designated) {
    try {
      await ensureDesignatedProfiles(db)
    } catch (seedErr) {
      console.warn('[profileResolver] ensureDesignatedProfiles failed during repair', {
        profileId: id,
        error: seedErr?.message || String(seedErr),
      })
    }
    const reseeded = await selectProfileById(db, id)
    if (reseeded) {
      return {
        profile: reseeded,
        originalId: id,
        resolvedId: String(reseeded.id),
        repaired: false,
        strategy: 'reseed',
      }
    }
    // Fall through: try display_name once more in case seed wrote a different id.
    const aliasedAfterSeed = await selectProfileByDisplayName(db, designated.display_name)
    if (aliasedAfterSeed) {
      return {
        profile: aliasedAfterSeed,
        originalId: id,
        resolvedId: String(aliasedAfterSeed.id),
        repaired: String(aliasedAfterSeed.id) !== id,
        strategy: 'reseed',
      }
    }
  }

  return null
}

export function isDesignatedProfileSlug(profileId) {
  const id = String(profileId || '').trim()
  return id ? DESIGNATED_BY_ID.has(id) : false
}

export default resolveProfileForId
