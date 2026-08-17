import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apiRateLimitMiddleware,
  classifyApiRatePolicy,
  resetApiRateLimitStateForTests,
} from '../../backend/middleware/apiRateLimitPolicy.js'

const env = {
  NODE_ENV: 'production',
  API_RATE_LIMIT_IN_TESTS: 'true',
}

test('security and paid-work lanes require the cross-instance rate-limit authority', () => {
  const auth = classifyApiRatePolicy({ method: 'POST', path: '/api/auth/email/start' }, env)
  const matching = classifyApiRatePolicy({ method: 'POST', path: '/api/matching/profile-1' }, env)

  for (const policy of [auth, matching]) {
    assert.equal(policy.shared, true)
    assert.equal(policy.requiredShared, true)
  }
})

test('ordinary reads and mutations prefer shared buckets but retain a bounded availability fallback', () => {
  const standard = classifyApiRatePolicy({ method: 'GET', path: '/api/opportunities' }, env)
  const mutation = classifyApiRatePolicy({ method: 'PATCH', path: '/api/profiles/profile-1' }, env)

  for (const policy of [standard, mutation]) {
    assert.equal(policy.shared, true)
    assert.equal(policy.requiredShared, false)
    assert.ok(policy.max > 0)
  }
})

function missingRateLimitTableDb() {
  return {
    prepare() {
      throw new Error('no such table: api_rate_limit_buckets')
    },
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

test('ordinary mutation uses the bounded local bucket when the shared table is unavailable', async () => {
  resetApiRateLimitStateForTests()
  const middleware = apiRateLimitMiddleware({
    env: { ...env, API_MUTATION_RATE_LIMIT_MAX: '2' },
    clock: () => 1_000,
  })
  const request = {
    method: 'PATCH',
    path: '/api/profiles/profile-1',
    ip: '192.0.2.10',
    db: missingRateLimitTableDb(),
  }

  let admitted = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = responseRecorder()
    await middleware(request, response, () => { admitted += 1 })
    if (attempt < 2) assert.equal(response.statusCode, 200)
    else {
      assert.equal(response.statusCode, 429)
      assert.equal(response.body?.error, 'rate_limit_exceeded')
    }
  }
  assert.equal(admitted, 2)
})

test('paid/security lane still fails closed when the shared table is unavailable', async () => {
  resetApiRateLimitStateForTests()
  const middleware = apiRateLimitMiddleware({ env, clock: () => 1_000 })
  const response = responseRecorder()
  let admitted = false

  await middleware({
    method: 'POST',
    path: '/api/ai/draft',
    ip: '192.0.2.11',
    db: missingRateLimitTableDb(),
  }, response, () => { admitted = true })

  assert.equal(admitted, false)
  assert.equal(response.statusCode, 503)
  assert.equal(response.body?.error, 'rate_limit_store_unavailable')
  assert.equal(response.body?.rate_limit_policy, 'cost')
})
