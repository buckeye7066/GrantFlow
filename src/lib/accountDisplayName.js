/**
 * The name the app shows for the signed-in person.
 *
 * Signup derives `users.display_name` from the email local part ("mcnabbwg"),
 * while the profile the person actually filled in carries their real name
 * ("GeneMac"). An end user saw one, the owner saw the other, and both believed
 * there were two profiles (2026-09-07). For a non-admin with an active profile
 * the profile's name wins; admins keep their account name because they work
 * across every profile.
 */
export function resolveAccountDisplayName({ user, profiles, activeProfileId, isAdmin = false } = {}) {
  const accountName = String(user?.display_name || user?.full_name || '').trim()
  if (!isAdmin && activeProfileId) {
    const active = Array.isArray(profiles)
      ? profiles.find((p) => String(p?.id ?? '') === String(activeProfileId))
      : null
    const profileName = String(active?.display_name || active?.name || '').trim()
    if (profileName) return profileName
  }
  return accountName || 'User'
}

export default resolveAccountDisplayName
