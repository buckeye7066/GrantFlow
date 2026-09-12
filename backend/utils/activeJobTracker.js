/**
 * activeJobTracker.js
 *
 * Lightweight in-memory registry of "what long-running background job is
 * running right now" — forensic visibility for a silent process exit.
 *
 * WHY THIS EXISTS: a container killed by SIGKILL (an OOM-kill, or a platform
 * restart) gives Node NO chance to run any handler — nothing in the process
 * can log "I am about to die". The only forensic trail available afterward is
 * whatever was ALREADY logged in the moments before the gap. backend/start.js's
 * periodic heartbeat logs process.memoryUsage() alongside a snapshot of this
 * registry so the next silent restart leaves behind "this job had been running
 * for N ms when the log stream stopped" instead of forcing a from-scratch
 * reconstruction from scattered per-request log lines (see the investigation
 * that added this: the 2026-09-12T04:01Z GrantFlow prod restart).
 *
 * Not a queue, not a lock, not a scheduler — just a small map schedulers set/
 * clear around their own work. Safe to call from anywhere; never throws.
 */

const activeJobs = new Map()

/**
 * Mark a job as running. `detail` is a short, cheap-to-compute string (e.g.
 * "42/95 profiles") — callers may update it repeatedly while the job runs
 * without needing to clear/re-set.
 */
export function setActiveJob(name, detail = null) {
  try {
    const key = String(name)
    const existing = activeJobs.get(key)
    activeJobs.set(key, { startedAt: existing?.startedAt ?? Date.now(), detail: detail ?? null })
  } catch { /* never let bookkeeping break the caller's real work */ }
}

export function clearActiveJob(name) {
  try {
    activeJobs.delete(String(name))
  } catch { /* ignore */ }
}

/** Pure snapshot for the heartbeat / diagnostics — never throws. */
export function getActiveJobsSnapshot(now = Date.now()) {
  try {
    return [...activeJobs.entries()].map(([name, { startedAt, detail }]) => ({
      name,
      running_ms: Math.max(0, now - startedAt),
      ...(detail ? { detail } : {}),
    }))
  } catch {
    return []
  }
}

/**
 * Wrap an async function so the job is marked active for its duration and
 * always cleared, even on throw. Convenience for the common case.
 */
export async function withActiveJob(name, detail, fn) {
  setActiveJob(name, detail)
  try {
    return await fn()
  } finally {
    clearActiveJob(name)
  }
}
