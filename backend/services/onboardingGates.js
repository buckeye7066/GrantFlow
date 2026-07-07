/**
 * onboardingGates.js — canonical server-side resolution of the onboarding /
 * guided-tour state an auth payload advertises to the frontend.
 *
 * THE RULE (owner-directed, 2026-07-06): an ADMIN/owner account is only ever
 * interviewed by Anya at most once. A SECONDARY login must NEVER re-trigger
 * the interview for an admin — regardless of `pending_reinterview` backfills.
 *
 * Background: the one-time admin bulk reset that put existing users back
 * through the new-user experience (intro video → Anya's gap interview →
 * guided first-cycle tour) stamps `users.guided_cycle_tour_status =
 * 'pending_reinterview'`. The frontend's OnboardingSequencer mounts
 * ResetOnboardingFlow whenever it sees that status, and the status only
 * clears once the user sits through the whole sequence — so an admin who
 * dismissed it kept getting the interview on every subsequent login.
 *
 * Enforcement is layered per the repo's invariant philosophy:
 *   1. Per-call gate (this module): every place that serializes
 *      `guided_cycle_tour_status` into an auth payload — `buildUserPayload`
 *      (login responses, backend/routes/auth.js), the GET /api/auth/me
 *      handler (backend/server.js), and the PATCH /api/auth/onboarding-state
 *      echo — resolves the status through resolveGuidedCycleTourStatus().
 *   2. Boot net: `enforceAdminReinterviewSuppression()` in
 *      backend/startup/enforceInvariants.js repairs the DB rows themselves on
 *      every boot, so the flag cannot sit on an admin row waiting for a code
 *      path that forgot to resolve.
 *
 * Non-admin users are NEVER touched by this gate — their reset flow is the
 * deliberate product behavior.
 */

/** Dialect-tolerant truthiness for user boolean columns (PG boolean, SQLite 0/1, text imports). */
function truthyFlag(value) {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 'true' ||
    value === 't' ||
    value === 'TRUE'
  )
}

export function isAdminUserRow(userRow) {
  return truthyFlag(userRow?.is_admin)
}

/**
 * Has this account already had its one interview / first-run experience —
 * or simply signed in before (which makes ANY new prompt a "secondary login"
 * re-trigger)? Any of these durable signals qualifies:
 *   - has_completed_onboarding (Anya intake funnel or manual completion)
 *   - onboarding_completed_at  (same, timestamp form)
 *   - last_login_at            (the account has signed in at least once
 *                               before — stamped at the createSessionAndTokens
 *                               choke point on every fresh login)
 */
export function hasHadFirstRunAlready(userRow) {
  if (!userRow) return false
  return (
    truthyFlag(userRow.has_completed_onboarding) ||
    Boolean(userRow.onboarding_completed_at) ||
    Boolean(userRow.last_login_at)
  )
}

/**
 * Resolve the guided_cycle_tour_status an auth payload should advertise.
 *
 * - Non-admins: raw stored value, always (their flow is unchanged).
 * - Admins: 'pending_reinterview' is only ever served to a genuinely FRESH
 *   admin account (never interviewed, never signed in) — that is their
 *   at-most-once shot. Any admin with a completed/skipped interview or any
 *   prior sign-in resolves to 'completed', so a secondary login can never
 *   re-open the interview.
 *
 * Pure + synchronous (callable from any payload serializer). Expects a users
 * row that includes is_admin, guided_cycle_tour_status,
 * has_completed_onboarding, onboarding_completed_at, last_login_at (all
 * SELECT * call sites already have them).
 */
export function resolveGuidedCycleTourStatus(userRow) {
  const raw = userRow?.guided_cycle_tour_status ?? null
  if (raw !== 'pending_reinterview') return raw
  if (!isAdminUserRow(userRow)) return raw
  if (hasHadFirstRunAlready(userRow)) return 'completed'
  return raw
}

/**
 * Resolve the one-time FORCED WELCOME VIDEO an auth payload should advertise.
 *
 * Returns `{ id, url, label }` for the newest UNCONSUMED forced_welcome_videos
 * row that targets this user — matched by primary_email OR by any profile
 * currently linked to the user (profiles.user_id = userRow.id) — else null.
 * `id` is the forced_welcome_videos row id (what the consume endpoint clears);
 * `url` is the public streaming path for the underlying media asset.
 *
 * The frontend's OnboardingSequencer renders this ABOVE every other first-run
 * branch, so a targeted user sees the video full-screen before any interview /
 * tour / dashboard. Once consumed, the row stops matching and this returns null
 * forever after — zero behavior change for everyone with no forced row.
 *
 * FAIL-OPEN: any error (missing table on an un-migrated DB, query failure)
 * resolves to null. A welcome video must NEVER break login.
 *
 * Async — every call site (buildUserPayload, GET /api/auth/me, the PATCH echo)
 * is already async. Works on both dialects (SQLite .get() is sync but awaiting
 * a non-promise is a no-op; the pg shim returns a promise).
 *
 * @param {Object} db - request-scoped DB handle (req.db)
 * @param {Object} userRow - users row (needs id + primary_email)
 * @returns {Promise<{id: string, url: string, label: string|null}|null>}
 */
export async function resolveForcedWelcomeVideo(db, userRow) {
  try {
    if (!db || !userRow?.id) return null
    const normalizedEmail = String(userRow.primary_email ?? '').trim().toLowerCase()
    const row = await db
      .prepare(
        `SELECT fwv.id AS id, fwv.media_asset_id AS media_asset_id, fwv.label AS label
           FROM forced_welcome_videos fwv
          WHERE fwv.consumed_at IS NULL
            AND (
              (fwv.match_email IS NOT NULL AND LOWER(TRIM(fwv.match_email)) = ?)
              OR (fwv.match_profile_id IS NOT NULL AND fwv.match_profile_id IN (
                    SELECT id FROM profiles WHERE user_id = ?
                 ))
            )
          ORDER BY fwv.created_at DESC
          LIMIT 1`,
      )
      .get(normalizedEmail, userRow.id)
    if (!row?.id || !row?.media_asset_id) return null
    return {
      id: row.id,
      url: `/api/media/${row.media_asset_id}`,
      label: row.label ?? null,
    }
  } catch {
    // Fail-open: never let a welcome-video lookup break authentication.
    return null
  }
}

export default {
  isAdminUserRow,
  hasHadFirstRunAlready,
  resolveGuidedCycleTourStatus,
  resolveForcedWelcomeVideo,
}
