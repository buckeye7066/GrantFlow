// EVA scheduler / maintenance — stale-run detection and heartbeat monitoring.
//
// The morning email itself is NOT scheduled here — EVA data flows into the
// EXISTING Anya 09:00 report via defaultLoadEvaPortfolioQa (one email preserved).
// This module runs a lightweight best-effort maintenance sweep that:
//   - marks OPEN findings 'stale' when no fresh run has re-observed them within
//     the stale window (we can vouch neither that they still fail NOR that they
//     are resolved — an honest third state), and
//   - reports heartbeat health so a silent runner surfaces.
// It never throws and never sends anything.
import { createLogger } from '../../utils/logger.js'
import { LIMITS } from './evaTypes.js'
import { latestRun, latestHeartbeat } from './evaRunStore.js'

const log = createLogger('service:eva:scheduler')

/**
 * Mark open findings stale when the latest run is older than the stale window.
 * A finding that was open and hasn't been re-observed by a fresh run cannot be
 * presented as either failing-today or resolved. Returns a summary; never throws.
 */
export async function runEvaMaintenance(db, { now = null, staleMs = LIMITS.DEFAULT_STALE_MS } = {}) {
  try {
    if (!db?.prepare) return { ran: false, reason: 'no_db' }
    const nowMs = now ? new Date(now).getTime() : Date.now()
    const run = await latestRun(db)
    const heartbeat = await latestHeartbeat(db)

    const runAgeMs = run ? nowMs - new Date(run.completed_at || run.received_at).getTime() : Infinity
    const runStale = !run || runAgeMs > staleMs
    const hbAgeMs = heartbeat ? nowMs - new Date(heartbeat.last_seen_at).getTime() : Infinity
    const heartbeatState = !heartbeat ? 'missing' : hbAgeMs > staleMs ? 'stale' : 'ok'

    let markedStale = 0
    if (runStale) {
      // Only transition ACTIVE (non-resolved) findings that weren't touched by a
      // fresh run. When runStale, no run this window re-observed anything, so all
      // open, non-stale findings become stale.
      const at = new Date(nowMs).toISOString()
      const res = await db.prepare(
        `UPDATE eva_findings SET lifecycle_state = 'stale', updated_at = ?
         WHERE lifecycle_state NOT IN ('resolved', 'stale')`,
      ).run(at)
      markedStale = Number(res?.changes ?? res?.rowCount ?? 0)
    } else {
      // Fresh runs exist, but a finding a fresh run did NOT re-observe is just
      // as unvouchable: when an app fails startup its journeys never execute,
      // so its old failures (e.g. the pre-launcher ERR_CONNECTION_REFUSED
      // class) were re-rendered as "recurring" every morning forever — nothing
      // could ever pass-resolve them. Age them out individually by
      // last_seen_at: re-observation makes a finding fresh again, silence does
      // not keep it alive.
      const at = new Date(nowMs).toISOString()
      const cutoff = new Date(nowMs - staleMs).toISOString()
      const res = await db.prepare(
        `UPDATE eva_findings SET lifecycle_state = 'stale', updated_at = ?
         WHERE lifecycle_state NOT IN ('resolved', 'stale') AND last_seen_at < ?`,
      ).run(at, cutoff)
      markedStale = Number(res?.changes ?? res?.rowCount ?? 0)
    }

    // Prune replay nonces older than the freshness window. A request bearing an
    // old timestamp is rejected at the freshness check BEFORE the nonce is even
    // consulted, so a nonce older than the skew window can never enable a replay
    // and is safe to delete — this keeps eva_seen_nonces bounded.
    let prunedNonces = 0
    try {
      const cutoff = new Date(nowMs - LIMITS.SIGNATURE_MAX_SKEW_MS - 60_000).toISOString()
      const res = await db.prepare('DELETE FROM eva_seen_nonces WHERE seen_at < ?').run(cutoff)
      prunedNonces = Number(res?.changes ?? res?.rowCount ?? 0)
    } catch {
      /* nonce table may not exist yet (no ingest ever) — ignore */
    }

    const summary = { ran: true, runStale, heartbeatState, markedStale, prunedNonces, runAgeHours: run ? Math.round(runAgeMs / 3600000) : null }
    log.info('eva maintenance sweep', summary)
    return summary
  } catch (err) {
    log.warn('eva maintenance failed (non-fatal)', { error: err?.message })
    return { ran: false, reason: 'exception', error: String(err?.message || err) }
  }
}
