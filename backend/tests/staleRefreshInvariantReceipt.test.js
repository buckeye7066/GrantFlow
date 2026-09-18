import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const refresh = vi.hoisted(() => vi.fn())
vi.mock('../services/matching/staleMatchExplainRefresh.js', () => ({ runStaleMatchExplainRefresh: refresh }))
const previousKey = process.env.RUNTIME_SECRETS_KEY
process.env.RUNTIME_SECRETS_KEY = previousKey || 'b'.repeat(64)
const { enforceStaleMatchExplainRefresh, projectPersistedStep } = await import('../startup/enforceInvariants.js')
afterAll(() => {
  if (previousKey === undefined) delete process.env.RUNTIME_SECRETS_KEY
  else process.env.RUNTIME_SECRETS_KEY = previousKey
})
beforeEach(() => { refresh.mockReset() })

function result(overrides = {}) {
  return {
    ok: true, scanned: 2, refreshed: 2, would_refresh: 0, write_enabled: true,
    truncated: false, remaining_candidates: 0, remaining_stale: 0,
    verification_scanned: 2, verification_truncated: false, verification_failed: false,
    verified_at: '2026-09-18T00:00:00.000Z', complete: true, status: 'complete',
    unscorable: 0, skipped_no_profile: 0, convergence_errors: 0,
    concurrent_changes_skipped: 0, ...overrides,
  }
}
async function project(value) {
  refresh.mockResolvedValue(value)
  const step = await enforceStaleMatchExplainRefresh({})
  return { step, persisted: projectPersistedStep(step) }
}

it('keeps a completion verification failure failed through the real wrapper and projection', async () => {
  const { step, persisted } = await project(result({ ok: false, remaining_candidates: null, remaining_stale: null,
    verification_failed: true, verified_at: null, complete: false, status: 'failed' }))
  expect(step.ok).toBe(false)
  expect(persisted).toMatchObject({ ok: false, repaired: 2, complete: false, status: 'failed',
    remaining_candidates: null, remaining_stale: null, verification_failed: true, verified_at: null })
})
it('persists verified zero counts and explicit false flags instead of omitting them', async () => {
  const { persisted } = await project(result())
  expect(persisted).toMatchObject({ ok: true, complete: true, status: 'complete', remaining_candidates: 0,
    remaining_stale: 0, verification_failed: false, verification_truncated: false, verification_scanned: 2 })
})
it('distinguishes a pending batch from the whole drain being complete', async () => {
  const { persisted } = await project(result({ remaining_candidates: 4, remaining_stale: null,
    complete: false, status: 'pending', truncated: true }))
  expect(persisted).toMatchObject({ ok: true, complete: false, status: 'pending', remaining_candidates: 4,
    remaining_stale: null, truncated: true })
})
it('carries exact stale evidence even when the substring candidate count is zero', async () => {
  const { persisted } = await project(result({ remaining_stale: 1, complete: false, status: 'pending' }))
  expect(persisted).toMatchObject({ remaining_candidates: 0, remaining_stale: 1, complete: false, status: 'pending' })
})
it('retains incomplete exact-audit evidence without converting unknown into zero', async () => {
  const { persisted } = await project(result({ remaining_stale: null, verification_truncated: true,
    complete: false, status: 'pending' }))
  expect(persisted).toMatchObject({ remaining_stale: null, verification_truncated: true, complete: false })
})
it('keeps disabled writes separate from an enabled completed drain', async () => {
  const { step, persisted } = await project(result({ write_enabled: false, refreshed: 0, would_refresh: 2,
    remaining_candidates: 2, remaining_stale: null, complete: false, status: 'disabled' }))
  expect(step.wouldRepair).toBe(2)
  expect(persisted).toMatchObject({ enforced: false, repaired: 0, complete: false, status: 'disabled' })
})
it('keeps unresolved profile, scoring and persistence counters in the durable receipt', async () => {
  const { persisted } = await project(result({ ok: false, unscorable: 1, skipped_no_profile: 2,
    convergence_errors: 3, concurrent_changes_skipped: 4, complete: false, status: 'failed' }))
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare('INSERT INTO system_kv VALUES (?, ?)').run('receipt', JSON.stringify(persisted))
    const readback = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key=?').get('receipt').value)
    expect(readback).toMatchObject({ ok: false, unscorable: 1, skipped_no_profile: 2,
      convergence_errors: 3, concurrent_changes_skipped: 4, complete: false, status: 'failed' })
  } finally { db.close() }
})
it('does not widen the diagnostic projection for unrelated invariant steps', () => {
  expect(projectPersistedStep({ name: 'unrelated', ok: true, complete: true, status: 'complete',
    remaining_candidates: 0, verification_scanned: 10 })).toEqual({ name: 'unrelated', ok: true, repaired: 0, scanned: 0 })
})
it('does not fabricate a verified backlog after the worker throws', async () => {
  refresh.mockRejectedValue(Error('fixture worker failure'))
  const persisted = projectPersistedStep(await enforceStaleMatchExplainRefresh({}))
  expect(persisted.ok).toBe(false)
  expect(persisted.error).toContain('fixture worker failure')
  expect(persisted.remaining_candidates).toBeUndefined()
})
