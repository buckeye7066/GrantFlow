export const PIPELINE_PRECISION_SNAPSHOT_KEY = 'pipeline_precision_last_run'
export const PIPELINE_PRECISION_SNAPSHOT_CONTRACT = 'numeric_boot_verified_task_truth_v4'

function finiteCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : 0
}

function emptyTruth(status = 'unavailable') {
  return {
    available: false,
    healthy: false,
    queueReadable: false,
    contract: null,
    status,
    asOf: null,
    cleanup: null,
    repair: null,
    verification: null,
  }
}

/**
 * Turn the durable boot snapshot into the one task-truth contract consumed by
 * both /api/version and the authenticated queue. Only numeric aggregates leave
 * this module; task IDs, profile IDs, titles, URLs and stored error text never
 * become part of health or queue responses.
 */
export function parseHamiltonTaskTruthSnapshot(value) {
  let parsed = value
  try {
    if (typeof value === 'string') parsed = JSON.parse(value)
  } catch {
    return emptyTruth('invalid')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyTruth('missing')
  }

  const repairAudit = parsed.taskRepairAudit ?? parsed.taskAudit ?? null
  const verificationAudit = parsed.verificationTaskAudit ?? parsed.taskAudit ?? null
  if (!repairAudit || typeof repairAudit !== 'object' || Array.isArray(repairAudit)
    || !verificationAudit || typeof verificationAudit !== 'object' || Array.isArray(verificationAudit)) {
    return emptyTruth('incomplete')
  }

  const status = typeof parsed.status === 'string' ? parsed.status : 'legacy'
  const contract = typeof parsed.contract === 'string' ? parsed.contract : null
  const cleanup = {
    scanned: finiteCount(parsed.scanned),
    kept: finiteCount(parsed.kept),
    removed: finiteCount(parsed.removed),
    relabeled: finiteCount(parsed.relabeled),
    deferred: finiteCount(parsed.deferred),
    tasksCancelled: finiteCount(parsed.tasksCancelled ?? parsed.tasks_cancelled),
    matchesRemoved: finiteCount(parsed.matchesRemoved ?? parsed.matches_removed),
    failed: finiteCount(parsed.failed),
    truncated: parsed.truncated === true,
    profiles: finiteCount(parsed.profiles),
    profilesAffected: finiteCount(parsed.profilesAffected ?? parsed.profiles_affected),
    byGate: parsed.byGate ?? parsed.by_gate ?? {},
  }
  const repair = {
    failed: finiteCount(repairAudit.failed),
    repairFailed: finiteCount(repairAudit.repairFailed),
    deferred: finiteCount(repairAudit.deferred),
    truncated: repairAudit.truncated === true,
  }
  const verification = {
    scanned: finiteCount(verificationAudit.scanned),
    valid: finiteCount(verificationAudit.valid),
    invalid: finiteCount(verificationAudit.invalid),
    deferred: finiteCount(verificationAudit.deferred),
    protected: finiteCount(verificationAudit.protected),
    failed: finiteCount(verificationAudit.failed),
    repairFailed: finiteCount(verificationAudit.repairFailed),
    truncated: verificationAudit.truncated === true,
    byGate: verificationAudit.byGate ?? {},
    byBucket: verificationAudit.byBucket ?? {},
  }
  const healthy = contract === PIPELINE_PRECISION_SNAPSHOT_CONTRACT
    && status === 'verified'
    && cleanup.failed === 0
    && cleanup.truncated === false
    && cleanup.deferred === 0
    && repair.failed === 0
    && repair.repairFailed === 0
    && repair.deferred === 0
    && repair.truncated === false
    && verification.invalid === 0
    && verification.deferred === 0
    && verification.failed === 0
    && verification.repairFailed === 0
    && verification.truncated === false
  const queueReadable = contract === PIPELINE_PRECISION_SNAPSHOT_CONTRACT
    && (status === 'verified' || status === 'pending_reverification')
    && cleanup.failed === 0
    && cleanup.truncated === false
    && repair.failed === 0
    && repair.repairFailed === 0
    && repair.truncated === false
    && verification.invalid === 0
    && verification.failed === 0
    && verification.repairFailed === 0
    && verification.truncated === false

  return {
    available: true,
    healthy,
    // A stale positive link is due for another probe, not evidence that the
    // source is bad. Existing tasks stay visible while all writers/workers
    // fail closed on the retryable policy result; only an actual invalid or
    // incomplete census blocks the read-only queue.
    queueReadable,
    contract,
    status,
    asOf: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
    cleanup,
    repair,
    verification,
  }
}

export async function readHamiltonTaskTruthSnapshot(db) {
  try {
    const row = await db
      .prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1')
      .get(PIPELINE_PRECISION_SNAPSHOT_KEY)
    return parseHamiltonTaskTruthSnapshot(row?.value ?? null)
  } catch {
    return emptyTruth('unavailable')
  }
}

export async function persistHamiltonTaskTruthSnapshot(db, summary) {
  const timestamp = typeof summary?.timestamp === 'string'
    ? summary.timestamp
    : new Date().toISOString()
  const value = JSON.stringify({
    contract: PIPELINE_PRECISION_SNAPSHOT_CONTRACT,
    ...summary,
    timestamp,
  })
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)',
  ).run()
  await db.prepare(`
    INSERT INTO system_kv (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(PIPELINE_PRECISION_SNAPSHOT_KEY, value, timestamp)
}
