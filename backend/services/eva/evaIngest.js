// EVA signed ingest — the trust boundary between the untrusted Windows edge
// runner and the GrantFlow coordinator.
//
// The runner signs each upload with an HMAC-SHA256 over a canonical string
// binding: runner_id, timestamp, nonce, idempotency_key, and the sha256 of the
// raw body. GrantFlow rejects: missing/invalid signatures, replayed nonces,
// stale timestamps, unknown runner ids, malformed schemas, oversized payloads,
// and conflicting duplicate idempotency keys.
//
// The shared secret lives in EVA_RUNNER_SECRETS (JSON map of runnerId->secret)
// or EVA_RUNNER_SECRET (single secret for a lone runner) — env only, never in
// source, logs, or responses. verifySignature does a constant-time compare.
import crypto from 'crypto'
import { createLogger } from '../../utils/logger.js'
import { validateResultPayload, redactDeep, LIMITS } from './evaTypes.js'
import { persistRun } from './evaRunStore.js'

const log = createLogger('service:eva:ingest')

// ---- Secret resolution (env only) -----------------------------------------

function loadRunnerSecrets(env = process.env) {
  const out = new Map()
  if (env.EVA_RUNNER_SECRETS) {
    try {
      const parsed = JSON.parse(env.EVA_RUNNER_SECRETS)
      for (const [id, secret] of Object.entries(parsed)) {
        if (typeof secret === 'string' && secret.length >= 16) out.set(id, secret)
      }
    } catch {
      log.warn('EVA_RUNNER_SECRETS is not valid JSON; ignoring')
    }
  }
  // Single-runner convenience: EVA_RUNNER_SECRET + EVA_RUNNER_ID.
  if (env.EVA_RUNNER_SECRET && env.EVA_RUNNER_ID && env.EVA_RUNNER_SECRET.length >= 16) {
    out.set(env.EVA_RUNNER_ID, env.EVA_RUNNER_SECRET)
  }
  return out
}

export function isIngestConfigured(env = process.env) {
  return loadRunnerSecrets(env).size > 0
}

// ---- Signature ------------------------------------------------------------

// Canonical signing string. Order and delimiter are contract; the runner MUST
// build it identically. bodyDigest binds the exact bytes so the body can't be
// swapped under a valid header.
export function buildSigningString({ runnerId, timestamp, nonce, idempotencyKey, bodyDigest }) {
  return ['v1', runnerId, timestamp, nonce, idempotencyKey, bodyDigest].join('\n')
}

export function computeBodyDigest(rawBody) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function signPayload({ secret, runnerId, timestamp, nonce, idempotencyKey, rawBody }) {
  const bodyDigest = computeBodyDigest(rawBody)
  const signingString = buildSigningString({ runnerId, timestamp, nonce, idempotencyKey, bodyDigest })
  return crypto.createHmac('sha256', secret).update(signingString).digest('hex')
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// ---- Nonce replay store (dedicated table created lazily) ------------------

async function ensureNonceTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS eva_seen_nonces (
       nonce TEXT PRIMARY KEY, runner_id TEXT NOT NULL, seen_at TEXT NOT NULL
     )`,
  ).run()
}

// Records the nonce; returns false if it was already seen (replay).
async function claimNonce(db, { nonce, runnerId, at }) {
  await ensureNonceTable(db)
  const existing = await db.prepare('SELECT nonce FROM eva_seen_nonces WHERE nonce = ? LIMIT 1').get(String(nonce))
  if (existing) return false
  try {
    await db.prepare('INSERT INTO eva_seen_nonces (nonce, runner_id, seen_at) VALUES (?, ?, ?)').run(String(nonce), String(runnerId), at)
    return true
  } catch {
    // Unique violation under a race = treated as replay.
    return false
  }
}

// ---- Public: verify + ingest ----------------------------------------------

/**
 * Verify signature headers + freshness + replay for a raw request body.
 * Returns { ok, status, error?, parsed? }. Does NOT persist.
 *
 * @param headers { 'x-eva-runner-id','x-eva-timestamp','x-eva-nonce','x-eva-idempotency-key','x-eva-signature' }
 */
export async function verifyRequest(db, { rawBody, headers = {}, env = process.env, now = null }) {
  const nowMs = now ? new Date(now).getTime() : Date.now()
  const runnerId = headers['x-eva-runner-id']
  const timestamp = headers['x-eva-timestamp']
  const nonce = headers['x-eva-nonce']
  const idempotencyKey = headers['x-eva-idempotency-key']
  const signature = headers['x-eva-signature']

  if (!runnerId || !timestamp || !nonce || !idempotencyKey || !signature) {
    return { ok: false, status: 401, error: 'missing_signature_headers' }
  }

  // Payload size cap (defence-in-depth; the route also caps body size).
  const bodyLen = Buffer.isBuffer(rawBody) ? rawBody.length : Buffer.byteLength(String(rawBody), 'utf8')
  if (bodyLen > LIMITS.MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }

  const secrets = loadRunnerSecrets(env)
  const secret = secrets.get(runnerId)
  if (!secret) {
    return { ok: false, status: 401, error: 'unknown_runner' }
  }

  // Freshness: reject stale/future timestamps beyond the skew window.
  const tsMs = Number(timestamp)
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > LIMITS.SIGNATURE_MAX_SKEW_MS) {
    return { ok: false, status: 401, error: 'stale_timestamp' }
  }

  const expected = signPayload({ secret, runnerId, timestamp, nonce, idempotencyKey, rawBody })
  if (!timingSafeHexEqual(signature, expected)) {
    return { ok: false, status: 401, error: 'invalid_signature' }
  }

  // Parse only after the signature is proven, so we never parse untrusted bytes
  // that failed auth.
  let parsed
  try {
    parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'))
  } catch {
    return { ok: false, status: 400, error: 'malformed_json' }
  }

  const validation = validateResultPayload(parsed)
  if (!validation.ok) {
    return { ok: false, status: 422, error: 'schema_invalid', details: validation.errors.slice(0, 20) }
  }

  // Replay: claim the nonce. A duplicate idempotency_key with a NEW nonce is
  // handled in ingest() as an idempotent no-op; a reused nonce is a replay.
  const fresh = await claimNonce(db, { nonce, runnerId, at: new Date(nowMs).toISOString() })
  if (!fresh) {
    return { ok: false, status: 409, error: 'replayed_nonce' }
  }

  return { ok: true, status: 200, parsed, runnerId, nonce, idempotencyKey, bodyLen }
}

/**
 * Full ingest: verify, then redact + persist. Returns { ok, status, result?, error? }.
 * Redaction happens here (belt-and-suspenders with the runner's own redaction)
 * so nothing unsanitized is ever written.
 */
export async function ingest(db, { rawBody, headers = {}, env = process.env, now = null }) {
  const verified = await verifyRequest(db, { rawBody, headers, env, now })
  if (!verified.ok) return verified

  // Idempotency: a duplicate key is a benign retry — return the stored run.
  const redacted = redactDeep(verified.parsed)
  try {
    const result = await persistRun(db, redacted, {
      idempotencyKey: verified.idempotencyKey,
      nonce: verified.nonce,
      payloadBytes: verified.bodyLen,
      now,
    })
    return { ok: true, status: result.duplicate ? 200 : 201, result }
  } catch (err) {
    // A conflicting duplicate idempotency key (unique index) surfaces here.
    if (String(err?.message || '').match(/unique|duplicate/i)) {
      return { ok: false, status: 409, error: 'duplicate_idempotency_key' }
    }
    log.error('eva ingest persist failed', { error: err?.message })
    return { ok: false, status: 500, error: 'persist_failed' }
  }
}
