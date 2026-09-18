import { beforeEach, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { isCanonicalOwner } from '../../backend/services/ownerAi/ownerAiScope.js'
const keys = ['OWNER_AI_EMAIL', 'OWNER_AI_USER_ID', 'ADMIN_EMAIL', 'AGENT_CONTROL_ADMIN_EMAIL']
let saved
const owner = () => ({ ctx: { identityResolved: true, isAdmin: true, userId: 'owner-user', email: 'active-owner@example.test' }, user: { userId: 'owner-user' } })
beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.OWNER_AI_EMAIL = ' Active-Owner@Example.Test '
  process.env.ADMIN_EMAIL = 'legacy-admin@example.test'
  delete process.env.AGENT_CONTROL_ADMIN_EMAIL
  delete process.env.OWNER_AI_USER_ID
})
afterEach(() => { for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
test('explicit owner account works without changing the global administrator account', () => {
  assert.equal(isCanonicalOwner(owner()), true)
  assert.equal(process.env.ADMIN_EMAIL, 'legacy-admin@example.test')
  const other = owner(); other.ctx.email = process.env.ADMIN_EMAIL
  assert.equal(isCanonicalOwner(other), false)
})
test('an owner email never grants administrator authority or accepts an unresolved identity', () => {
  for (const flags of [{ isAdmin: false }, { identityResolved: false }, { userId: '' }]) {
    const req = owner(); Object.assign(req.ctx, flags); assert.equal(isCanonicalOwner(req), false)
  }
})
test('pinned user ID and service-token exclusions remain authoritative', () => {
  process.env.OWNER_AI_USER_ID = 'owner-user'
  assert.equal(isCanonicalOwner(owner()), true)
  const wrong = owner(); wrong.ctx.userId = 'different-user'; assert.equal(isCanonicalOwner(wrong), false)
  for (const field of ['serviceToken', 'profileTokenAuth']) {
    const req = owner(); req.user[field] = true; assert.equal(isCanonicalOwner(req), false)
  }
})
test('request claims cannot impersonate the configured owner account', () => {
  const req = owner(); req.ctx.email = 'other-admin@example.test'; req.user.email = 'active-owner@example.test'
  assert.equal(isCanonicalOwner(req), false)
})
test('deployments without an explicit owner account keep the existing canonical-admin fallback', () => {
  delete process.env.OWNER_AI_EMAIL
  const req = owner(); req.ctx.email = 'legacy-admin@example.test'
  assert.equal(isCanonicalOwner(req), true)
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'agent-owner@example.test'
  assert.equal(isCanonicalOwner(req), false)
  req.ctx.email = 'agent-owner@example.test'; assert.equal(isCanonicalOwner(req), true)
})
