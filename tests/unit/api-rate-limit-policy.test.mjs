import test from 'node:test'
import assert from 'node:assert/strict'
import { SqliteDb } from '../../backend/db/index.js'
import {
  apiRateLimitMiddleware,
  classifyApiRatePolicy,
  resetApiRateLimitStateForTests,
} from '../../backend/middleware/apiRateLimitPolicy.js'

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function invoke(middleware, req) {
  const res = makeResponse()
  let nextCalled = false
  await middleware(req, res, () => { nextCalled = true })
  return { res, nextCalled }
}

test('provider webhooks and health routes are exempt', () => {
  assert.equal(classifyApiRatePolicy({ path: '/api/health', method: 'GET' }), null)
  assert.equal(classifyApiRatePolicy({ path: '/api/stripe/webhook', method: 'POST' }), null)
  assert.equal(classifyApiRatePolicy({ path: '/api/sms/inbound', method: 'POST' }), null)
})

test('ordinary mutations are bounded per authenticated user', async () => {
  resetApiRateLimitStateForTests()
  const middleware = apiRateLimitMiddleware({
    env: { API_MUTATION_RATE_LIMIT_MAX: '1', API_MUTATION_RATE_LIMIT_WINDOW_MS: '60000' },
    clock: () => 1000,
  })
  const req = { path: '/api/profiles/x', method: 'PATCH', ctx: { userId: 'u1' }, ip: '1.1.1.1' }

  assert.equal((await invoke(middleware, req)).nextCalled, true)
  const second = await invoke(middleware, req)
  assert.equal(second.nextCalled, false)
  assert.equal(second.res.statusCode, 429)
  assert.equal(second.res.body.rate_limit_policy, 'mutation')
})

test('cost limits are shared through the database across middleware instances', async () => {
  resetApiRateLimitStateForTests()
  const db = new SqliteDb(':memory:')
  const env = { API_COST_RATE_LIMIT_MAX: '1', API_COST_RATE_LIMIT_WINDOW_MS: '60000' }
  const firstInstance = apiRateLimitMiddleware({ env, clock: () => 1000 })
  const secondInstance = apiRateLimitMiddleware({ env, clock: () => 1000 })
  const req = {
    path: '/api/ai/invoke',
    method: 'POST',
    ctx: { userId: 'u-shared' },
    user: { userId: 'u-shared' },
    ip: '1.1.1.1',
    db,
  }

  assert.equal((await invoke(firstInstance, req)).nextCalled, true)
  const second = await invoke(secondInstance, req)
  assert.equal(second.nextCalled, false)
  assert.equal(second.res.statusCode, 429)
  assert.equal(second.res.body.rate_limit_policy, 'cost')
  db.close()
})
