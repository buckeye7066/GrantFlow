/**
 * Synthetic SERVICE tokens (ADMIN_TOKEN / bulk key, Anya API key, health token).
 *
 * These are validated by safeTokenEqual against configured secrets in the auth
 * layer and have NO real users row. They are the ONLY legitimate token-derived
 * admins — and their authority is bound to service-token PROVENANCE (the
 * `serviceToken` flag, set ONLY inside a safeTokenEqual auth branch and never
 * derivable from a JWT payload), NOT to the id VALUE.
 *
 * Shared here so requestContext, accessControl, ensureAdminUser and server.js
 * all use ONE source of truth (no circular imports; this module imports nothing).
 */

export const SYNTHETIC_SERVICE_ADMIN_USER_IDS = new Set([
  'system_admin_token',
  'system_anya_token',
  'system_health_token',
])

/**
 * True only for a VALIDATED synthetic service token: it carries the provenance
 * flag AND is_admin AND a reserved id. A signed JWT whose `sub` collides with a
 * reserved id but lacks `serviceToken` is NOT a synthetic service admin.
 */
export function isSyntheticServiceAdmin(user) {
  const id = user?.userId
  return Boolean(
    user?.serviceToken === true &&
      user.is_admin === true &&
      id &&
      SYNTHETIC_SERVICE_ADMIN_USER_IDS.has(String(id)),
  )
}

/** Whether a userId is one of the reserved synthetic service-token ids. */
export function isReservedSyntheticUserId(userId) {
  return Boolean(userId && SYNTHETIC_SERVICE_ADMIN_USER_IDS.has(String(userId)))
}

/**
 * A userId that collides with a reserved synthetic id but lacks service-token
 * provenance — i.e. an impersonation attempt (a JWT setting sub:'system_admin_token').
 * Such a principal must NEVER be honored (no admin, no grants), even if a
 * self-healed users row exists for that id.
 */
export function isSyntheticIdWithoutProvenance(user) {
  return Boolean(isReservedSyntheticUserId(getUserId(user)) && user?.serviceToken !== true)
}

function getUserId(user) {
  return user?.userId ?? user?.id ?? user?.user_id ?? null
}
