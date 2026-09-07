/**
 * profileLifecycle.js — ONE answer to "which profiles are current / deleted /
 * suspended / banned", shared by the profile list route and Anya's admin tools.
 *
 * Owner report 2026-09-07: as admin the owner could not see a profile in "My
 * Profiles" because it was `deleted` and the list hides deleted rows by
 * default; Anya diagnosed it but could not act. The statuses:
 *
 *   active     profiles.status IS NULL or 'active'
 *   suspended  profiles.status = 'suspended' (billing dunning or an admin pause;
 *              services/billing/accountStatus.suspendProfile)
 *   deleted    profiles.status = 'deleted' (soft delete; hard delete removes the row)
 *   banned     the profile's user is on the owner blocklist by email
 *              (services/blocklist/ownerBlocklistService; banning also suspends
 *              the profile, so a banned profile is usually suspended too)
 */

export const PROFILE_LIFECYCLE_STATUSES = Object.freeze(['active', 'suspended', 'deleted', 'banned'])

/** Parse a CSV / array of statuses into the allowed set (unknown values dropped). */
export function parseStatusFilter(raw) {
  const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const out = []
  for (const v of values) {
    const s = String(v ?? '').trim().toLowerCase()
    if (PROFILE_LIFECYCLE_STATUSES.includes(s) && !out.includes(s)) out.push(s)
  }
  return out
}

/** SQL (on profile alias `p`) that is TRUE when the profile's user is banned. */
export function bannedProfileSql(alias = 'p') {
  return `EXISTS (
    SELECT 1 FROM owner_blocklist b
      JOIN users u ON u.id = ${alias}.user_id
     WHERE b.match_type = 'email'
       AND b.enforcement = 'block'
       AND LOWER(b.match_value) = LOWER(u.primary_email)
  )`
}

/**
 * WHERE fragment (no leading AND/WHERE) selecting profiles in ANY of the
 * requested statuses. Empty/absent statuses → the default view: active only.
 */
export function statusFilterSql(statuses, alias = 'p') {
  const wanted = parseStatusFilter(statuses)
  const parts = []
  const banned = bannedProfileSql(alias)
  if (wanted.length === 0 || wanted.includes('active')) {
    parts.push(`((${alias}.status IS NULL OR ${alias}.status = 'active') AND NOT ${banned})`)
  }
  // Buckets are EXCLUSIVE: a banned user's profile is also suspended by the
  // ban, but it belongs to the "banned" box, not the "suspended" one.
  if (wanted.includes('suspended')) parts.push(`(${alias}.status = 'suspended' AND NOT ${banned})`)
  if (wanted.includes('deleted')) parts.push(`(${alias}.status = 'deleted' AND NOT ${banned})`)
  if (wanted.includes('banned')) parts.push(banned)
  return `(${parts.join(' OR ')})`
}

/** Classify one profile row (with `banned` computed) into a lifecycle status. */
export function lifecycleStatusOf(row) {
  if (row?.banned === true || Number(row?.banned) === 1) return 'banned'
  const s = String(row?.status ?? '').toLowerCase()
  if (s === 'deleted' || s === 'suspended') return s
  return 'active'
}

/**
 * List profiles by lifecycle status (admin read). Excludes Amy synthetics.
 * @returns {Promise<{ counts: object, profiles: Array }>}
 */
export async function listProfilesByStatus(db, { statuses = [], query = null, limit = 50 } = {}) {
  const wanted = parseStatusFilter(statuses)
  const max = Math.max(1, Math.min(Number(limit) || 50, 500))
  const params = []
  let where = `WHERE COALESCE(p.created_by, '') <> 'agent:amy' AND ${statusFilterSql(wanted.length ? wanted : ['active', 'suspended', 'deleted', 'banned'], 'p')}`
  const q = String(query ?? '').trim().toLowerCase()
  if (q) { where += ' AND LOWER(p.display_name) LIKE ?'; params.push(`%${q}%`) }
  const rows = await db.prepare(
    `SELECT p.id, p.display_name, p.primary_type, p.status, p.updated_at, p.user_id,
            CASE WHEN ${bannedProfileSql('p')} THEN 1 ELSE 0 END AS banned
       FROM profiles p
       ${where}
      ORDER BY p.updated_at DESC
      LIMIT ?`,
  ).all(...params, max)
  const profiles = (rows || []).map((r) => ({
    id: r.id,
    display_name: r.display_name,
    primary_type: r.primary_type ?? null,
    status: r.status ?? null,
    lifecycle: lifecycleStatusOf(r),
    updated_at: r.updated_at ?? null,
  }))
  const counts = { active: 0, suspended: 0, deleted: 0, banned: 0 }
  try {
    const c = await db.prepare(
      `SELECT
         SUM(CASE WHEN (p.status IS NULL OR p.status = 'active') AND NOT ${bannedProfileSql('p')} THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN p.status = 'suspended' AND NOT ${bannedProfileSql('p')} THEN 1 ELSE 0 END) AS suspended,
         SUM(CASE WHEN p.status = 'deleted' AND NOT ${bannedProfileSql('p')} THEN 1 ELSE 0 END) AS deleted,
         SUM(CASE WHEN ${bannedProfileSql('p')} THEN 1 ELSE 0 END) AS banned
       FROM profiles p WHERE COALESCE(p.created_by, '') <> 'agent:amy'`,
    ).get()
    for (const k of Object.keys(counts)) counts[k] = Number(c?.[k]) || 0
  } catch { /* counts are informational */ }
  return { counts, profiles }
}

/**
 * Restore a soft-deleted profile (status → 'active'). Idempotent: an already
 * active profile reports `changed:false`. Never touches a suspended profile —
 * that is `reactivateProfile`'s job (billing/accountStatus), which also
 * notifies the account.
 */
export async function restoreDeletedProfile(db, { profileId, actor = 'admin' } = {}) {
  const id = String(profileId ?? '').trim()
  if (!id) return { ok: false, error: 'profile_id_required' }
  const row = await db.prepare('SELECT id, display_name, status FROM profiles WHERE id = ? LIMIT 1').get(id)
  if (!row) return { ok: false, error: 'profile_not_found', profile_id: id }
  const before = String(row.status ?? '').toLowerCase()
  if (before !== 'deleted') {
    return { ok: true, changed: false, profile_id: id, display_name: row.display_name, status_before: row.status ?? null, status_after: row.status ?? null, reason: `profile is ${before || 'active'}, not deleted` }
  }
  await db.prepare(`UPDATE profiles SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id)
  try {
    await db.prepare(
      `INSERT INTO audit_events (id, actor_type, actor_id, entity_type, entity_id, action, before_json, after_json)
       VALUES (?, 'user', ?, 'profile', ?, 'profile.restore', ?, ?)`,
    ).run(`audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, String(actor), id, JSON.stringify({ status: 'deleted' }), JSON.stringify({ status: 'active' }))
  } catch { /* audit table shape varies across deployments; the restore itself is the record */ }
  return { ok: true, changed: true, profile_id: id, display_name: row.display_name, status_before: 'deleted', status_after: 'active' }
}

export default {
  PROFILE_LIFECYCLE_STATUSES,
  parseStatusFilter,
  bannedProfileSql,
  statusFilterSql,
  lifecycleStatusOf,
  listProfilesByStatus,
  restoreDeletedProfile,
}
