import { randomUUID } from 'node:crypto'

export const STALE_REFRESH_RECEIPT_KEY = 'stale_match_explain_last_run'
const STEP_NAME = 'stale_match_explain_refresh'
const MAX_RECEIPT_AGE_MS = 4 * 60 * 60 * 1000
const changes = result => Number(result?.changes ?? result?.rowCount ?? 0)

export async function beginStaleRefreshReceipt(db, { signal } = {}) {
  signal?.throwIfAborted()
  const at = new Date().toISOString()
  const receipt = { name: STEP_NAME, run_id: randomUUID(), at, started_at: at,
    completed_at: null, trigger: 'recurring-link-verification', ok: false,
    status: 'running', complete: false, remaining_candidates: null, remaining_stale: null }
  const value = JSON.stringify(receipt)
  await db.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(STALE_REFRESH_RECEIPT_KEY, value, at)
  signal?.throwIfAborted()
  return { receipt, value }
}

export async function finishStaleRefreshReceipt(db, attempt, step, { signal } = {}) {
  signal?.throwIfAborted()
  const safe = Object.fromEntries(Object.entries(step).filter(([key, value]) =>
    key !== 'error' && (value === null || ['string', 'number', 'boolean'].includes(typeof value))))
  const at = new Date().toISOString()
  const receipt = { ...attempt.receipt, ...safe, name: STEP_NAME, at, completed_at: at,
    ok: step.ok === true, complete: step.ok === true && step.complete === true,
    status: step.ok !== true ? 'failed' : step.status ?? 'pending' }
  const result = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?')
    .run(JSON.stringify(receipt), at, STALE_REFRESH_RECEIPT_KEY, attempt.value)
  if (changes(result) !== 1) throw new Error('Stored-match refresh receipt was superseded; completion not published')
  signal?.throwIfAborted()
  return receipt
}

/** Overlay only the latest recurring evidence in memory; the historical boot record is untouched. */
export async function withLatestStaleRefreshReceipt(db, boot, now = Date.now()) {
  let receipt
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(STALE_REFRESH_RECEIPT_KEY)
    if (!row) return boot
    receipt = JSON.parse(row.value)
    if (!receipt || typeof receipt !== 'object' || receipt.name !== STEP_NAME ||
        !Number.isFinite(Date.parse(receipt.started_at))) throw new Error('Invalid refresh receipt')
  } catch {
    receipt = { name: STEP_NAME, ok: false, complete: false, status: 'unavailable',
      remaining_candidates: null, remaining_stale: null }
  }
  const bootAt = Date.parse(boot?.at)
  const startedAt = Date.parse(receipt.started_at)
  if (Number.isFinite(bootAt) && Number.isFinite(startedAt) && startedAt < bootAt) return boot
  const age = now - Date.parse(receipt.at)
  const fresh = Number.isFinite(age) && age >= 0 && age <= MAX_RECEIPT_AGE_MS
  const complete = fresh && receipt.ok === true && receipt.complete === true && receipt.status === 'complete' &&
    receipt.remaining_candidates === 0 && receipt.remaining_stale === 0 &&
    receipt.verification_failed === false && receipt.verification_truncated === false
  const current = { ...receipt, ok: complete, complete,
    status: !fresh && receipt.status !== 'unavailable' ? 'stale' : receipt.status }
  const steps = (Array.isArray(boot?.steps) ? boot.steps : []).filter(step => step?.name !== STEP_NAME)
  steps.push(current)
  return { ...(boot ?? {}), steps, recurring_stale_match_refresh: current,
    failed: steps.filter(step => step?.ok === false).length }
}
