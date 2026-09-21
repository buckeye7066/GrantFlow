import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getOwnerAiScope, runWithScheduledOwnerAiScope, ownerAiJobParameters } from '../services/ownerAi/ownerAiScope.js'
const bridge = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../services/ownerAi/ownerAiBroker.js', () => ({ tryOwnerSubscription: bridge.run }))
import { invokeJsonWithFallback } from '../utils/aiProviders.js'

let db
beforeEach(() => {
  vi.stubEnv('OWNER_AI_BACKGROUND_ENABLED', 'true')
  vi.stubEnv('OWNER_AI_EMAIL', 'owner@example.test')
  vi.stubEnv('OWNER_AI_USER_ID', '')
  vi.stubEnv('ADMIN_EMAIL', 'other-admin@example.test')
  vi.stubEnv('ADMIN_EMAILS', '')
  vi.stubEnv('OWNER_AI_ALLOW_PAID_FALLBACK', 'false')
  bridge.run.mockReset()
  db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  db.prepare('INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, ?)').run('scheduled-owner', 'owner@example.test', 1)
})
afterEach(() => { db.close(); vi.unstubAllEnvs() })
const options = () => ({ workload: 'amy_training', timeoutMs: 1000 })

it.each(['amy_training', 'robert_discovery'])('authorizes the explicitly enabled %s scheduler using the current database owner', async workload => {
  let signal
  const result = await runWithScheduledOwnerAiScope(db, { ...options(), workload }, active => {
    signal = active
    expect(getOwnerAiScope().identity.userId).toBe('scheduled-owner')
    return 'subscription eligible'
  })
  expect(result).toBe('subscription eligible')
  expect(signal.aborted).toBe(true)
  expect(getOwnerAiScope()).toBeNull()
})
it('keeps the default disabled and refuses arbitrary workloads', async () => {
  vi.stubEnv('OWNER_AI_BACKGROUND_ENABLED', '')
  expect(await runWithScheduledOwnerAiScope(db, options(), () => getOwnerAiScope())).toBeNull()
  vi.stubEnv('OWNER_AI_BACKGROUND_ENABLED', 'true')
  await expect(runWithScheduledOwnerAiScope(db, { ...options(), workload: 'customer_checkout' }, () => true)).rejects.toThrow(/workload/)
})
it.each(['deleted', 'demoted', 'wrong_id'])('does not grant subscription access when configured ownership is %s', async kind => {
  if (kind === 'deleted') db.prepare('DELETE FROM users').run()
  if (kind === 'demoted') db.prepare('UPDATE users SET is_admin = 0').run()
  if (kind === 'wrong_id') vi.stubEnv('OWNER_AI_USER_ID', 'another-user')
  const work = vi.fn()
  await expect(runWithScheduledOwnerAiScope(db, options(), work)).rejects.toThrow(/owner/i)
  expect(work).not.toHaveBeenCalled()
})
it('propagates scheduler lease cancellation and retains scope until cooperative settlement', async () => {
  const lease = new AbortController()
  const running = runWithScheduledOwnerAiScope(db, { ...options(), signal: lease.signal }, signal => {
    expect(getOwnerAiScope().signal).toBe(signal)
    lease.abort(new Error('lease lost'))
    signal.throwIfAborted()
  })
  await expect(running).rejects.toThrow('lease lost')
})
it('uses the subscription gateway and falls back to free inference without paid credit', async () => {
  const receipt = { ok: true, provider: 'subscription:codex', billing_mode: 'subscription', json: { awards: [] } }
  bridge.run.mockResolvedValueOnce(receipt).mockResolvedValueOnce(null)
  const freeCreate = vi.fn(async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"awards":[]}' } }] }))
  const infer = () => invokeJsonWithFallback({ openai: null, prompt: 'Extract source facts', maxTokens: 100, timeoutMs: 1000,
    freeRoutes: [{ id: 'fixture', baseURL: 'http://localhost:11434/v1', model: 'fixture' }],
    freeClientFactory: () => ({ chat: { completions: { create: freeCreate } } }) })
  expect(await runWithScheduledOwnerAiScope(db, options(), infer)).toEqual(receipt)
  expect(freeCreate).not.toHaveBeenCalled()
  expect(await runWithScheduledOwnerAiScope(db, options(), infer)).toMatchObject({ ok: true, billing_mode: 'free_or_local' })
  expect(freeCreate).toHaveBeenCalledOnce()
})
it('cannot confer durable subscription authority on queued customer work', async () => {
  const result = await runWithScheduledOwnerAiScope(db, options(), () => ownerAiJobParameters({ _owner_ai: { forged: true } }, { id: 'customer-job', type: 'comprehensive' }))
  expect(result).toEqual({})
})
it('holds the running scope until cancelled work really settles', async () => {
  const lease = new AbortController()
  let release
  let started
  const ready = new Promise(resolve => { started = resolve })
  let settled = false
  const running = runWithScheduledOwnerAiScope(db, { ...options(), signal: lease.signal }, () => {
    started()
    return new Promise(resolve => { release = resolve })
  }).catch(error => error).finally(() => { settled = true })
  await ready
  lease.abort(new Error('lease lost'))
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  release()
  expect((await running).message).toBe('lease lost')
})
