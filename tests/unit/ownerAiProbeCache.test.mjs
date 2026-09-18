import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProviderStatusCache } from '../../tools/owner-ai/bridge.mjs'
test('heartbeats reuse bounded native metadata checks; expiry rechecks both subscriptions', async () => {
  let time = 0
  let calls = 0
  const cache = createProviderStatusCache({ now: () => time, probe: async provider => { calls++; return provider === 'codex' ? 'ready' : 'auth_required' } })
  assert.deepEqual(await cache.read(), { codex: 'ready', claude: 'auth_required' })
  time = 1500
  await cache.read()
  assert.equal(calls, 2)
  time = 30001
  await cache.read()
  assert.equal(calls, 4)
})
test('failed native rechecks remove prior ready claims rather than preserving stale auth', async () => {
  let time = 0
  let fails = false
  const cache = createProviderStatusCache({ now: () => time, probe: async () => { if (fails) throw Error('private metadata'); return 'ready' } })
  await cache.read()
  time = 30001
  fails = true
  assert.deepEqual(await cache.read(), { codex: 'unavailable', claude: 'unavailable' })
})