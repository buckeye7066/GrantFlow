import { isShouldersVnextEnabled } from '../featureFlagService.js'

function isMissingVnextApplicationsTable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || error || '')
  return code === '42P01' || /no such table:\s*vnext_applications/i.test(message) ||
    /relation\s+["']?vnext_applications["']?\s+does not exist/i.test(message)
}

// SQLite deployments can still use the historical 999-bind-variable ceiling.
// Leave room for profile_id and any driver-added bindings while keeping the
// read bounded for large, unpaginated match result sets.
export const VNEXT_GUIDANCE_QUERY_CHUNK_SIZE = 500

/** Batch-load profile-scoped workflow state without turning guidance into N+1 queries. */
export async function loadVnextGuidanceByOpportunity(
  db,
  profileId,
  opportunityIds = [],
  { userId = null, isAdmin = false } = {},
) {
  const normalizedProfileId = String(profileId ?? '').trim()
  const sourceIds = Array.isArray(opportunityIds) ? opportunityIds : []
  const ids = [...new Set(sourceIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
  if (!db?.prepare || !normalizedProfileId || ids.length === 0) return new Map()
  if (!isShouldersVnextEnabled(db, {
    userId,
    profileId: normalizedProfileId,
    isAdmin,
  })) return new Map()
  const applications = new Map()
  try {
    for (let offset = 0; offset < ids.length; offset += VNEXT_GUIDANCE_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + VNEXT_GUIDANCE_QUERY_CHUNK_SIZE)
      const rows = await db.prepare(`
        SELECT id, opportunity_id, state, stage
          FROM vnext_applications
         WHERE profile_id = ? AND opportunity_id IN (${chunk.map(() => '?').join(', ')})
      `).all(normalizedProfileId, ...chunk)
      for (const row of rows || []) {
        applications.set(String(row.opportunity_id), {
          vnext_application_id: row.id,
          vnext_application_state: row.state,
          vnext_application_stage: row.stage,
        })
      }
    }
    return applications
  } catch (error) {
    // Older/test schemas can legitimately predate the feature. Guidance then
    // retains its no-application behavior; unrelated DB failures stay loud.
    if (isMissingVnextApplicationsTable(error)) return new Map()
    throw error
  }
}
