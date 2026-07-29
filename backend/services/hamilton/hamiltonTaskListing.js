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

  // Global access is authorized by the explicit, DB-backed admin decision only.
  // A null profile set is never sufficient by itself: requestContext reserves
  // null for admins, but callers that recompute access can observe a null
  // sentinel after an inconsistent/failed context lookup. Treating that null as
  // authority would turn an access-control disagreement into a cross-tenant leak.
  if (isAdmin === true) {
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

  if (requested) {
    if (!accessible.has(requested)) return { forbidden: true, tasks: [] }
    const tasks = await listTasks({ profileId: requested, status, limit })
    return { forbidden: false, tasks: Array.isArray(tasks) ? tasks : [] }
  }

  if (accessible.size === 0) return { forbidden: false, tasks: [] }

  const tasks = []
  for (const profileId of accessible) {
    const rows = await listTasks({ profileId, status, limit })
    if (Array.isArray(rows)) tasks.push(...rows)
  }
  return { forbidden: false, tasks }
}

export default { listScopedHamiltonTasks }
