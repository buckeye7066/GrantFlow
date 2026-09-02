/**
 * Fail closed: no catalog row is owner-visible until its link was positively
 * verified within the current freshness window. The verifier can restore rows
 * after a successful probe; this migration only removes unsupported visibility.
 */
export default async function up(db) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const hidden = db?.dialect === 'postgres' ? true : 1
  const result = await db.prepare(`
    UPDATE funding_opportunities
       SET is_hidden = ?
     WHERE COALESCE(is_active, TRUE) = TRUE
       AND COALESCE(is_hidden, FALSE) = FALSE
       AND (
         LOWER(TRIM(COALESCE(link_status, ''))) NOT IN ('ok', 'redirect', 'verified')
         OR last_verified_at IS NULL
         OR last_verified_at < ?
       )
  `).run(hidden, cutoff)
  const changed = Number(result?.changes ?? result?.rowCount ?? 0)
  const now = new Date().toISOString()
  try {
    await db.prepare(`
      INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('visible_catalog_fail_closed_last_run', JSON.stringify({ hidden: changed, cutoff, timestamp: now }), now)
  } catch {
    // Visibility is authoritative even if the optional summary table is absent.
  }
}
