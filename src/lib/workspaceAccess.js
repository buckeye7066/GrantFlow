/**
 * GET /api/auth/me answers with an envelope ({ user, profiles,
 * active_profile_id }) for every DB-backed login; only the legacy synthetic
 * ADMIN_TOKEN path returns a flat { role } object. Callers pass both shapes
 * here, so the policy reads the user record wherever it lives — otherwise an
 * envelope silently answers "not admin" for everyone, including the owner.
 */
function unwrapUser(candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  if (candidate.user && typeof candidate.user === 'object') return candidate.user
  return candidate
}

/**
 * The owner and every DB-recognized administrator keep the full GrantFlow
 * workspace. Everyone else receives the simplified end-user experience.
 *
 * This is a presentation policy only. Server-side authorization remains the
 * source of truth for every protected route and tool.
 */
export function hasFullAdminWorkspace(candidate) {
  const user = unwrapUser(candidate)
  if (!user) return false
  return Boolean(
    user.is_admin === true ||
      user.is_admin === 1 ||
      user.isAdmin === true ||
      user.role === 'admin' ||
      (Array.isArray(user.roles) && user.roles.includes('admin')),
  )
}

export function usesSimplifiedWorkspace(user) {
  return Boolean(user) && !hasFullAdminWorkspace(user)
}
