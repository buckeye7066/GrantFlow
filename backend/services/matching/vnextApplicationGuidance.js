function isMissingVnextApplicationsTable(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || error || '')
  return code === '42P01' || /no such table:\s*vnext_applications/i.test(message) ||
    /relation\s+["']?vnext_applications["']?\s+does not exist/i.test(message)
}

/** Batch-load profile-scoped workflow state without turning guidance into N+1 queries. */
export async function loadVnextGuidanceByOpportunity(db, profileId, opportunityIds = []) {
  const ids = [...new Set(opportunityIds.filter(Boolean).map(String))]
  if (!profileId || ids.length === 0) return new Map()
  try {
    const rows = await db.prepare(`
      SELECT id, opportunity_id, state, stage
        FROM vnext_applications
       WHERE profile_id = ? AND opportunity_id IN (${ids.map(() => '?').join(', ')})
    `).all(String(profileId), ...ids)
    return new Map((rows || []).map((row) => [String(row.opportunity_id), {
      vnext_application_id: row.id,
      vnext_application_state: row.state,
      vnext_application_stage: row.stage,
    }]))
  } catch (error) {
    // Older/test schemas can legitimately predate the feature. Guidance then
    // retains its no-application behavior; unrelated DB failures stay loud.
    if (isMissingVnextApplicationsTable(error)) return new Map()
    throw error
  }
}

