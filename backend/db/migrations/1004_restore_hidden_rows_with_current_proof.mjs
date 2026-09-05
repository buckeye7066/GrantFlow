/**
 * Restore catalog rows that are hidden while carrying CURRENT successful link
 * proof and no recorded reason to be hidden.
 *
 * Prod 2026-09-05, measured read-only: 10,427 active rows with link_status
 * 'ok', http 200, last_verified_at inside the 30-day freshness window,
 * verification_error empty, status active and reality_status verified/rolling
 * were `is_hidden = true`. 86% of every profile's match rows pointed at such
 * rows, so live pipeline promotion had almost nothing it was allowed to
 * admit. Nothing could reach them: the verifier only re-probes broken, never-
 * verified or stale rows, and its restore guard only heals a retryable
 * quarantine, so even a fresh successful probe would have left them hidden.
 *
 * The verifier now treats an unexplained hidden success as retryable and
 * restores it on its next successful probe (linkVerificationService). This
 * migration is the one-time relief for the backlog that would otherwise wait
 * days behind the bounded probe batch. It touches ONLY rows whose stored
 * state is entirely successful and unmarked; anything carrying a
 * verification marker, a non-active status, a rejected reality status, or a
 * past deadline is left exactly as it is. The count is recorded in system_kv.
 */
const KV_KEY = 'hidden_current_proof_restore_last_run'
const FRESHNESS_DAYS = 30

export default async function up(db) {
  const isPostgres = db?.dialect === 'postgres'
  const trueSql = isPostgres ? 'TRUE' : '1'
  const falseSql = isPostgres ? 'FALSE' : '0'
  const cutoff = new Date(Date.now() - FRESHNESS_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const deadlineOpenSql = isPostgres
    ? '(deadline IS NULL OR deadline >= CURRENT_DATE)'
    : "(deadline IS NULL OR TRIM(deadline) = '' OR substr(deadline, 1, 10) >= date('now'))"
  const result = await db.prepare(`
    UPDATE funding_opportunities
       SET is_hidden = ${falseSql}
     WHERE COALESCE(is_hidden, ${falseSql}) = ${trueSql}
       AND COALESCE(is_active, ${trueSql}) = ${trueSql}
       AND LOWER(TRIM(COALESCE(link_status, ''))) IN ('ok', 'redirect', 'verified')
       AND last_verified_at IS NOT NULL
       AND last_verified_at >= ?
       AND COALESCE(verification_error, '') = ''
       AND LOWER(COALESCE(status, 'active')) NOT IN ('expired', 'retired', 'permanently_retired', 'quarantined', 'paused')
       AND LOWER(COALESCE(reality_status, 'allowed')) <> 'rejected'
       AND ${deadlineOpenSql}
  `).run(cutoff)
  const restored = Number(result?.changes ?? result?.rowCount ?? 0)
  const now = new Date().toISOString()
  try {
    await db.prepare(`
      INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(KV_KEY, JSON.stringify({ restored, cutoff, timestamp: now }), now)
  } catch { /* system_kv absent in a minimal database */ }
  console.log(`[migration:1004] restored ${restored} hidden catalog row(s) carrying current successful proof`)
}
