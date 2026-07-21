// Cross-check: the edge-runner's signer MUST produce a signature the coordinator
// accepts. This imports BOTH the runner's sign.mjs and the coordinator's
// evaIngest.js and asserts identical output for the same inputs — so a drift in
// either the signing string or the digest fails here instead of silently
// 401-ing every real upload.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { signPayload as runnerSign, buildSigningString as runnerString, computeBodyDigest as runnerDigest } from '../src/sign.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const coordPath = pathToFileURL(join(__dirname, '..', '..', '..', 'backend', 'services', 'eva', 'evaIngest.js')).href

test('runner and coordinator produce identical signatures', async () => {
  const coord = await import(coordPath)
  const inputs = {
    secret: 'shared-secret-abcdef0123456789',
    runnerId: 'runner-x',
    timestamp: '1700000000000',
    nonce: 'nonce-123',
    idempotencyKey: 'idem-abc',
    rawBody: JSON.stringify({ schema_version: 1, hello: 'world', nested: [1, 2, 3] }),
  }
  assert.equal(runnerDigest(inputs.rawBody), coord.computeBodyDigest(inputs.rawBody), 'body digest must match')
  const bodyDigest = runnerDigest(inputs.rawBody)
  assert.equal(
    runnerString({ ...inputs, bodyDigest }),
    coord.buildSigningString({ ...inputs, bodyDigest }),
    'signing string must match',
  )
  assert.equal(runnerSign(inputs), coord.signPayload(inputs), 'HMAC signature must match')
})

test('a signed upload is accepted by the coordinator verifier', async () => {
  const coord = await import(coordPath)
  const { buildSignedHeaders } = await import('../src/sign.mjs')
  const payload = {
    schema_version: 1,
    run_id: 'run-xtest',
    runner_id: 'runner-x',
    started_at: new Date(1).toISOString(),
    completed_at: new Date(2).toISOString(),
    environment: 'fixture',
    apps: [{ app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [{ journey_id: 'login', name: 'Login', status: 'passed' }] }],
  }
  const rawBody = JSON.stringify(payload)
  const headers = buildSignedHeaders({ secret: 'shared-secret-abcdef0123456789', runnerId: 'runner-x', runId: 'run-xtest', rawBody, timestamp: 1700000000000 })

  const store = new Map()
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      return {
        run: (...a) => {
          if (/INSERT INTO eva_seen_nonces/.test(sql)) store.set(a[0], true)
          return { changes: 1 }
        },
        get: (...a) => (/eva_seen_nonces/.test(sql) ? (store.has(a[0]) ? { nonce: a[0] } : undefined) : undefined),
        all: () => [],
      }
    },
  }
  const env = { EVA_RUNNER_ID: 'runner-x', EVA_RUNNER_SECRET: 'shared-secret-abcdef0123456789' }
  const v = await coord.verifyRequest(db, { rawBody, headers, env, now: 1700000000000 })
  assert.equal(v.ok, true, `verifier should accept: ${v.error || ''}`)
})
