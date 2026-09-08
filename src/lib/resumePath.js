/** Reject unsafe and out-of-context resume destinations before displaying a link. */
export function resumeStorageKey(userId, profileId) {
  return userId && profileId ? 'grantflow:resume:v2:' + encodeURIComponent(String(userId)) + ':' + encodeURIComponent(String(profileId)) : null
}
export function safeResumePath(value, { profileId, allowedRoutes = [], grantIds = [] } = {}) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  try {
    const url = new URL(value, 'https://grantflow.invalid')
    if (url.origin !== 'https://grantflow.invalid') return null
    const route = url.pathname.slice(1)
    if (!allowedRoutes.includes(route) || route === 'Dashboard') return null
    for (const key of ['profile_id', 'profileId']) {
      if (url.searchParams.has(key) && url.searchParams.get(key) !== String(profileId)) return null
    }
    if (route === 'ProfileDetail' && url.searchParams.get('id') !== String(profileId)) return null
    if (url.searchParams.has('grant_id') && !grantIds.map(String).includes(url.searchParams.get('grant_id'))) return null
    // Other record-specific IDs require a fresh lookup; do not guess access.
    if (route !== 'ProfileDetail' && ['id', 'applicationId', 'application_id', 'task_id', 'taskId', 'opportunity_id'].some((key) => url.searchParams.has(key))) return null
    return url.pathname + url.search + url.hash
  } catch { return null }
}
