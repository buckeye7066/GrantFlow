/**
 * selfHealStatus.js — observability for the on-demand self-heal run.
 *
 * Per the standing "Agent Observability Rule": any capability that touches an
 * agent's scope must be wired so Sam's diagnostics can SEE it and Anya's tools
 * can use it. The full self-heal (runSelfHeal) is now runnable on demand by Sam
 * (nightly sweep) and Anya (owner.run_self_heal); this module persists the LAST
 * run's structured result so:
 *   - Sam's diagnostics (getSystemDiagnostics → self_heal block) surface it.
 *   - Anya's owner.get_self_heal_status reader returns it truthfully.
 *
 * Storage reuses the EXISTING system_kv single-row pattern (see
 * services/maintenance/maintenanceMode.js) — no parallel telemetry system is
 * invented. The value is a single JSON row keyed by `self_heal_last_run`.
 */

const KV_KEY = 'self_heal_last_run'

async function ensureKv(db) {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    .run()
}

/**
 * Persist the structured result of a self-heal run. Best-effort: a failure to
 * record observability must never abort the heal itself, so the caller wraps
 * this in its own try/catch.
 *
 * @param {object} db
 * @param {object} summary - the structured summary returned by runSelfHeal
 */
export async function recordSelfHealRun(db, summary) {
  if (!db) return
  await ensureKv(db)
  const now = new Date().toISOString()
  const value = JSON.stringify({ ...summary, recorded_at: now })
  const res = await db
    .prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
    .run(value, now, KV_KEY)
  const changed = Number(res?.changes ?? res?.rowCount ?? 0)
  if (!changed) {
    await db
      .prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(KV_KEY, value, now)
  }
}

/**
 * Read the last recorded self-heal run, or null if one has never run.
 * Never throws — returns null on any storage error so diagnostics stay green.
 *
 * @param {object} db
 * @returns {Promise<object|null>}
 */
export async function getLastSelfHealRun(db) {
  if (!db) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(KV_KEY)
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    return { ...parsed, updated_at: row.updated_at ?? parsed.recorded_at ?? null }
  } catch {
    return null
  }
}
