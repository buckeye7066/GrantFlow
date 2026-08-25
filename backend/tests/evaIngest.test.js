import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeEvaDb } from './evaTestDb.js'
import { ingest, verifyRequest, signPayload, computeBodyDigest } from '../services/eva/evaIngest.js'
import { EVA_SCHEMA_VERSION, LIMITS } from '../services/eva/evaTypes.js'

const SECRET = 'unit-test-secret-abcdef0123456789'
const RUNNER = 'unit-runner'

function envelope(rawBody, { runnerId = RUNNER, secret = SECRET, ts = null, nonce = 'n-' + Math.random().toString(36).slice(2), idk = 'idk-' + Math.random().toString(36).slice(2) } = {}) {
  const timestamp = ts || String(Date.now())
  const signature = signPayload({ secret, runnerId, timestamp, nonce, idempotencyKey: idk, rawBody })
  return {
    'x-eva-runner-id': runnerId,
    'x-eva-timestamp': timestamp,
    'x-eva-nonce': nonce,
    'x-eva-idempotency-key': idk,
    'x-eva-signature': signature,
  }
}

function samplePayload(runId = 'run-1') {
  return {
    schema_version: EVA_SCHEMA_VERSION,
    run_id: runId,
    runner_id: RUNNER,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    environment: 'fixture',
    apps: [
      { app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 100, journeys: [{ journey_id: 'login', name: 'Login', status: 'passed' }] },
    ],
  }
}

let db
const env = { EVA_RUNNER_ID: RUNNER, EVA_RUNNER_SECRET: SECRET }
beforeEach(() => {
  db = makeEvaDb()
})
afterEach(() => {
  db.close()
})

describe('EVA ingest signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const raw = JSON.stringify(samplePayload())
    const r = await ingest(db, { rawBody: raw, headers: envelope(raw), env })
    expect(r.ok).toBe(true)
    expect(r.status).toBe(201)
  })

  it('rejects a missing signature (401)', async () => {
    const raw = JSON.stringify(samplePayload())
    const r = await ingest(db, { rawBody: raw, headers: {}, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.error).toBe('missing_signature_headers')
  })

  it('rejects an invalid signature / tampered body (401)', async () => {
    const raw = JSON.stringify(samplePayload())
    const headers = envelope(raw)
    const tampered = raw.replace('GrantFlow', 'Evil')
    const r = await ingest(db, { rawBody: tampered, headers, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.error).toBe('invalid_signature')
  })

  it('rejects an unknown runner id (401)', async () => {
    const raw = JSON.stringify(samplePayload())
    const headers = envelope(raw, { runnerId: 'stranger' })
    const r = await ingest(db, { rawBody: raw, headers, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.error).toBe('unknown_runner')
  })

  it('rejects a stale timestamp (401)', async () => {
    const raw = JSON.stringify(samplePayload())
    const old = String(Date.now() - LIMITS.SIGNATURE_MAX_SKEW_MS - 60000)
    const headers = envelope(raw, { ts: old })
    const r = await ingest(db, { rawBody: raw, headers, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.error).toBe('stale_timestamp')
  })
})

describe('EVA ingest replay prevention', () => {
  it('rejects a replayed nonce (409)', async () => {
    const raw = JSON.stringify(samplePayload())
    const headers = envelope(raw)
    const first = await ingest(db, { rawBody: raw, headers, env })
    expect(first.ok).toBe(true)
    const replay = await ingest(db, { rawBody: raw, headers, env })
    expect(replay.ok).toBe(false)
    expect(replay.status).toBe(409)
    expect(replay.error).toBe('replayed_nonce')
  })
})

describe('EVA ingest idempotency', () => {
  it('a duplicate idempotency key (fresh nonce) is a benign no-op returning the stored run', async () => {
    const raw = JSON.stringify(samplePayload())
    const idk = 'shared-idem-key'
    const h1 = envelope(raw, { nonce: 'n-a', idk })
    const h2 = envelope(raw, { nonce: 'n-b', idk }) // different nonce, same idempotency key
    const first = await ingest(db, { rawBody: raw, headers: h1, env })
    expect(first.status).toBe(201)
    const second = await ingest(db, { rawBody: raw, headers: h2, env })
    expect(second.ok).toBe(true)
    expect(second.status).toBe(200)
    expect(second.result.duplicate).toBe(true)
    expect(second.result.run_id).toBe(first.result.run_id)
    // Only ONE run persisted.
    const count = db.prepare('SELECT COUNT(*) c FROM eva_runs').get()
    expect(count.c).toBe(1)
  })
})

describe('EVA ingest limits + schema', () => {
  it('rejects an oversized payload (413)', async () => {
    const big = 'x'.repeat(LIMITS.MAX_PAYLOAD_BYTES + 10)
    const headers = envelope(big)
    const r = await verifyRequest(db, { rawBody: big, headers, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(413)
  })

  it('rejects malformed JSON after a valid signature (400)', async () => {
    const raw = '{not json'
    const headers = envelope(raw)
    const r = await ingest(db, { rawBody: raw, headers, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.error).toBe('malformed_json')
  })

  it('rejects a schema-invalid payload (422)', async () => {
    const raw = JSON.stringify({ schema_version: EVA_SCHEMA_VERSION, run_id: 'x', runner_id: RUNNER, started_at: 'nope', completed_at: 'nope', environment: 'bad', apps: 'notarray' })
    const headers = envelope(raw)
    const r = await ingest(db, { rawBody: raw, headers, env })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(422)
    expect(r.error).toBe('schema_invalid')
  })

  it('strips only the deployed runner legacy diagnostics before strict validation', async () => {
    const payload = samplePayload('legacy-run')
    payload.apps[0].git_state = { branch: 'main', sha: 'a'.repeat(40) }
    payload.apps[0].stale_tree = false
    payload.apps[0].journeys[0].stale_tree = false
    const raw = JSON.stringify(payload)
    const accepted = await verifyRequest(db, { rawBody: raw, headers: envelope(raw), env })
    expect(accepted.ok).toBe(true)
    expect(accepted.parsed.apps[0].git_state).toBeUndefined()
    expect(accepted.parsed.apps[0].stale_tree).toBeUndefined()
    expect(accepted.parsed.apps[0].journeys[0].stale_tree).toBeUndefined()

    payload.apps[0].unexpected_legacy_field = true
    const unknownRaw = JSON.stringify(payload)
    const rejected = await verifyRequest(db, { rawBody: unknownRaw, headers: envelope(unknownRaw), env })
    expect(rejected.ok).toBe(false)
    expect(rejected.status).toBe(422)
    expect(rejected.details.join(' ')).toMatch(/unexpected_legacy_field/)
  })
})

describe('body digest binding', () => {
  it('a body swap under a valid header is caught because the digest is signed', async () => {
    const raw = JSON.stringify(samplePayload())
    expect(computeBodyDigest(raw)).toBe(computeBodyDigest(Buffer.from(raw)))
    const headers = envelope(raw)
    const swapped = JSON.stringify(samplePayload('run-2'))
    const r = await ingest(db, { rawBody: swapped, headers, env })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_signature')
  })
})
