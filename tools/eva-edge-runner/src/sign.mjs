// EVA edge-runner request signing. MUST stay byte-identical to the coordinator's
// backend/services/eva/evaIngest.js (buildSigningString / computeBodyDigest /
// signPayload) — a cross-check test (test/sign.test.mjs) imports both and asserts
// identical signatures, so a drift fails CI rather than silently 401-ing uploads.
import crypto from 'node:crypto'

export function computeBodyDigest(rawBody) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function buildSigningString({ runnerId, timestamp, nonce, idempotencyKey, bodyDigest }) {
  return ['v1', runnerId, timestamp, nonce, idempotencyKey, bodyDigest].join('\n')
}

export function signPayload({ secret, runnerId, timestamp, nonce, idempotencyKey, rawBody }) {
  const bodyDigest = computeBodyDigest(rawBody)
  const signingString = buildSigningString({ runnerId, timestamp, nonce, idempotencyKey, bodyDigest })
  return crypto.createHmac('sha256', secret).update(signingString).digest('hex')
}

export function makeNonce() {
  return crypto.randomBytes(16).toString('hex')
}

// A stable idempotency key for a run: same runner + run_id => same key, so a
// retry of the same run is a benign no-op at the coordinator.
export function idempotencyKeyFor(runnerId, runId) {
  return crypto.createHash('sha256').update(`${runnerId}:${runId}`).digest('hex').slice(0, 32)
}

// Build the signed headers for a body. timestamp is injected (not read from a
// wall clock here) so callers stay deterministic/testable.
export function buildSignedHeaders({ secret, runnerId, runId, rawBody, timestamp, nonce }) {
  const ts = String(timestamp)
  const n = nonce || makeNonce()
  const idk = idempotencyKeyFor(runnerId, runId)
  const signature = signPayload({ secret, runnerId, timestamp: ts, nonce: n, idempotencyKey: idk, rawBody })
  return {
    'content-type': 'application/json',
    'x-eva-runner-id': runnerId,
    'x-eva-timestamp': ts,
    'x-eva-nonce': n,
    'x-eva-idempotency-key': idk,
    'x-eva-signature': signature,
  }
}
