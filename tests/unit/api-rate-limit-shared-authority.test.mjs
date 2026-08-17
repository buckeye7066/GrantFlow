import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyApiRatePolicy } from '../../backend/middleware/apiRateLimitPolicy.js'

const env = {
  NODE_ENV: 'production',
  API_RATE_LIMIT_IN_TESTS: 'true',
}

test('security and paid-work lanes require the cross-instance rate-limit authority', () => {
  const auth = classifyApiRatePolicy({ method: 'POST', path: '/api/auth/email/start' }, env)
  const matching = classifyApiRatePolicy({ method: 'POST', path: '/api/matching/profile-1' }, env)
  const mutation = classifyApiRatePolicy({ method: 'PATCH', path: '/api/profiles/profile-1' }, env)

  for (const policy of [auth, matching, mutation]) {
    assert.equal(policy.shared, true)
    assert.equal(policy.requiredShared, true)
  }
})

test('standard reads use shared buckets but retain an availability fallback', () => {
  const policy = classifyApiRatePolicy({ method: 'GET', path: '/api/opportunities' }, env)
  assert.equal(policy.name, 'standard')
  assert.equal(policy.shared, true)
  assert.equal(policy.requiredShared, false)
})
