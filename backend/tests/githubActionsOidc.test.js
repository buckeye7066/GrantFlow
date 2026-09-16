import crypto from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetGithubActionsOidcForTests, isZipClosureRequest, verifyZipClosureOidc, ZIP_CLOSURE_AUDIENCE } from '../services/githubActionsOidc.js'

function fixture(overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  jwk.kid = 'fixture-key'
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({
    iss: 'https://token.actions.githubusercontent.com', aud: ZIP_CLOSURE_AUDIENCE,
    nbf: now - 10, exp: now + 300, repository: 'buckeye7066/GrantFlow',
    ref: 'refs/heads/main', event_name: 'workflow_dispatch',
    sub: 'repo:buckeye7066/GrantFlow:environment:production-audit',
    job_workflow_ref: 'buckeye7066/GrantFlow/.github/workflows/nationwide-zip-closure.yml@refs/heads/main',
    ...overrides,
  })).toString('base64url')
  const input = `${header}.${claims}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')
  return { token: `${input}.${signature}`, jwk }
}

describe('GitHub Actions ZIP-closure identity', () => {
  beforeEach(() => _resetGithubActionsOidcForTests())

  it('is usable only on the three bounded ZIP closure operations', () => {
    expect(isZipClosureRequest('GET', '/api/admin/geo/crawl/status')).toBe(true)
    expect(isZipClosureRequest('GET', '/api/admin/geo/zip-coverage?x=1')).toBe(true)
    expect(isZipClosureRequest('POST', '/api/admin/geo/crawl/start')).toBe(true)
    expect(isZipClosureRequest('POST', '/api/admin/users/delete')).toBe(false)
    expect(isZipClosureRequest('POST', '/api/admin/geo/zip-coverage')).toBe(false)
  })

  it('accepts only a signed token bound to the production workflow and main ref', async () => {
    const { token, jwk } = fixture()
    const claims = await verifyZipClosureOidc(token, { fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) })
    expect(claims?.repository).toBe('buckeye7066/GrantFlow')
  })

  it.each([
    ['fork', { repository: 'attacker/fork' }],
    ['branch', { ref: 'refs/heads/feature' }],
    ['workflow', { job_workflow_ref: 'buckeye7066/GrantFlow/.github/workflows/other.yml@refs/heads/main' }],
    ['environment subject', { sub: 'repo:buckeye7066/GrantFlow:environment:preview' }],
  ])('rejects a token with the wrong %s', async (_label, override) => {
    const { token, jwk } = fixture(override)
    expect(await verifyZipClosureOidc(token, { fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) })).toBeNull()
  })
})
