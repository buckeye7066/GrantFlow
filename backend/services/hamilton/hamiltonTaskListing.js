/**
 * Canonical scope resolver for Hamilton's task-list endpoint.
 *
 * A requested profile is a filter, not a hint: a non-admin may see that one
 * profile when accessible, gets 403 when inaccessible, and only receives the
 * aggregate of all accessible profiles when no profile was requested.
 */
export async function listScopedHamiltonTasks({
  isAdmin = false,
  requestedProfileId = null,
  accessibleProfileIds = new Set(),
  status = null,
  limit = 200,
  listTasks,
} = {}) {
  if (typeof listTasks !== 'function') {
    throw new TypeError('listTasks is required')
  }

  const requested = requestedProfileId ? String(requestedProfileId) : null

  // `null` is the DB-backed global-access sentinel returned for admins.
  if (isAdmin || accessibleProfileIds === null) {
    const tasks = await listTasks({
      ...(requested ? { profileId: requested } : {}),
      status,
      limit,
    })
    return { forbidden: false, tasks: Array.isArray(tasks) ? tasks : [] }
  }

  const accessible = accessibleProfileIds instanceof Set
    ? new Set([...accessibleProfileIds].map(String))
    : new Set((Array.isArray(accessibleProfileIds) ? accessibleProfileIds : []).map(String))

  if (accessible.size === 0) return { forbidden: false, tasks: [] }

  if (requested) {
    if (!accessible.has(requested)) return { forbidden: true, tasks: [] }
    const tasks = await listTasks({ profileId: requested, status, limit })
    return { forbidden: false, tasks: Array.isArray(tasks) ? tasks : [] }
  }

  const tasks = []
  for (const profileId of accessible) {
    const rows = await listTasks({ profileId, status, limit })
    if (Array.isArray(rows)) tasks.push(...rows)
  }
  return { forbidden: false, tasks }
}

export default { listScopedHamiltonTasks }
