export const OWNER_ADMIN_EMAIL = 'buckeye7066@gmail.com'

function normalizedEmail(user) {
  return String(user?.primary_email || user?.email || '').trim().toLowerCase()
}

/**
 * The owner and every DB-recognized administrator keep the full GrantFlow
 * workspace. Everyone else receives the simplified end-user experience.
 *
 * This is a presentation policy only. Server-side authorization remains the
 * source of truth for every protected route and tool.
 */
export function hasFullAdminWorkspace(user) {
  if (!user || typeof user !== 'object') return false
  return Boolean(
    user.is_admin === true ||
      user.is_admin === 1 ||
      user.isAdmin === true ||
      user.role === 'admin' ||
      (Array.isArray(user.roles) && user.roles.includes('admin')) ||
      normalizedEmail(user) === OWNER_ADMIN_EMAIL,
  )
}

export function usesSimplifiedWorkspace(user) {
  return Boolean(user) && !hasFullAdminWorkspace(user)
}
