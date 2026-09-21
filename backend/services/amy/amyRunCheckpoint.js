// One logical run, protected by the scheduler lease and optimistic writes.
// A corrupt/unavailable checkpoint must never silently start a replacement run.
const KEY = 'amy_active_run_checkpoint'
const changed = result => Number(result?.changes ?? result?.rowCount ?? 0)

async function ensureTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

function validate(value) {
  if (value?.version !== 1 || typeof value.run_id !== 'string' || !value.run_id ||
      !Number.isFinite(Date.parse(value.started_at)) || !Array.isArray(value.plan?.scenarios) ||
      !Array.isArray(value.members) || value.members.length !== value.plan.scenarios.length) {
    throw new Error('Invalid Amy run checkpoint')
  }
  const ids = new Set()
  for (let i = 0; i < value.members.length; i += 1) {
    const member = value.members[i]
    if (!member?.profile_id || !member.scenario_id || ids.has(member.scenario_id) ||
        member.scenario_id !== value.plan.scenarios[i]?.scenario_id) throw new Error('Invalid Amy checkpoint member')
    ids.add(member.scenario_id)
  }
  return value
}

export async function readAmyRunCheckpoint(db) {
  await ensureTable(db)
  const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KEY)
  if (!row) return null
  const serialized = row.value
  return { serialized, value: validate(JSON.parse(serialized)) }
}

export async function writeAmyRunCheckpoint(db, previous, value) {
  await ensureTable(db)
  validate(value)
  const serialized = JSON.stringify(value)
  const now = new Date().toISOString()
  const result = previous
    ? await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?').run(serialized, now, KEY, previous.serialized)
    : await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(KEY, serialized, now)
  if (changed(result) !== 1) throw new Error('Amy checkpoint changed concurrently')
  return { serialized, value: JSON.parse(serialized) }
}

export async function clearAmyRunCheckpoint(db, previous) {
  const result = await db.prepare('DELETE FROM system_kv WHERE key = ? AND value = ?').run(KEY, previous.serialized)
  if (changed(result) !== 1) throw new Error('Amy checkpoint changed before completion')
}

export function checkpointOptions(options) {
  const allowed = ['targetCount', 'dryRunDiscovery', 'keepProfiles', 'floor', 'ttlHours', 'improve',
    'applyTuning', 'applyWeights', 'applyCoverage', 'applyLearning', 'gapLearning', 'gapScanLimit',
    'anyaEnabled', 'anyaApply', 'samEnabled', 'samApply', 'saveReport', 'validationSampleSize', 'tuningOpts',
    'adversarial', 'adversarialShare', 'perCategory', 'categories']
  return Object.fromEntries(allowed.filter(key => options[key] !== undefined).map(key => [key, options[key]]))
}

export function hasCompletedCheckpointCleanup(combined, keepProfiles = false) {
  if (keepProfiles) return true
  if (!['proven', 'grace_held'].includes(combined.deletion_proof?.verdict)) return false
  return [combined.cleanup, combined.cleanup_expired, combined.adopted_orphans?.cleanup].every(result =>
    !result?.error && !(result?.errors?.length) &&
    !(result?.skipped_ids || []).some(row => (row.reasons || []).some(reason => String(reason).startsWith('delete_error'))))
}
