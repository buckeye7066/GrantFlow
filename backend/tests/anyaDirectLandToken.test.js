/**
 * The single-use HMAC authorization for a direct-to-main merge. Pure crypto +
 * an injectable/in-memory nonce store — no network, no real DB.
 */
import { describe, it, expect } from 'vitest'
import {
  issueDirectLandToken,
  verifyDirectLandToken,
  computeDirectLandToken,
  recordAndConsumeNonce,
  sha256Hex,
  getDirectLandSecret,
} from '../services/anyaDirectLandToken.js'

const SECRET = 'test-direct-land-secret'
const PATCH = 'diff --git a/backend/services/x.js b/backend/services/x.js\n--- a/backend/services/x.js\n+++ b/backend/services/x.js\n@@ -1 +1 @@\n-a\n+b\n'
const HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

describe('direct-land token (HMAC binding)', () => {
  it('a freshly issued token verifies against the same patch + head_sha', () => {
    const t = issueDirectLandToken({ patch: PATCH, headSha: HEAD, secret: SECRET, now: 1000 })
    const v = verifyDirectLandToken({ ...t, patch: PATCH, headSha: HEAD, secret: SECRET, now: 2000 })
    expect(v.ok).toBe(true)
    expect(t.patch_sha256).toBe(sha256Hex(PATCH))
  })

  it('a TAMPERED patch fails verification (bad signature)', () => {
    const t = issueDirectLandToken({ patch: PATCH, headSha: HEAD, secret: SECRET, now: 1000 })
    const v = verifyDirectLandToken({ ...t, patch: PATCH + '\n+evil()', headSha: HEAD, secret: SECRET, now: 2000 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('bad_signature')
  })

  it('a TAMPERED head_sha fails verification (bad signature)', () => {
    const t = issueDirectLandToken({ patch: PATCH, headSha: HEAD, secret: SECRET, now: 1000 })
    const v = verifyDirectLandToken({ ...t, patch: PATCH, headSha: 'ffffffffffffffffffffffffffffffffffffffff', secret: SECRET, now: 2000 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('bad_signature')
  })

  it('an EXPIRED token is refused', () => {
    const t = issueDirectLandToken({ patch: PATCH, headSha: HEAD, secret: SECRET, now: 1000, ttlMs: 500 })
    const v = verifyDirectLandToken({ ...t, patch: PATCH, headSha: HEAD, secret: SECRET, now: 9_999_999 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('expired')
  })

  it('a token signed with a DIFFERENT secret is refused', () => {
    const t = issueDirectLandToken({ patch: PATCH, headSha: HEAD, secret: SECRET, now: 1000 })
    const v = verifyDirectLandToken({ ...t, patch: PATCH, headSha: HEAD, secret: 'other-secret', now: 2000 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('bad_signature')
  })

  it('issuance without a secret throws (fail closed — no proof possible)', () => {
    expect(() => issueDirectLandToken({ patch: PATCH, headSha: HEAD, secret: '' })).toThrow(/secret/i)
  })

  it('computeDirectLandToken is deterministic and changes with each bound field', () => {
    const base = computeDirectLandToken({ patch: PATCH, headSha: HEAD, nonce: 'n1', expiry: 5, secret: SECRET })
    expect(computeDirectLandToken({ patch: PATCH, headSha: HEAD, nonce: 'n1', expiry: 5, secret: SECRET })).toBe(base)
    expect(computeDirectLandToken({ patch: PATCH, headSha: HEAD, nonce: 'n2', expiry: 5, secret: SECRET })).not.toBe(base)
    expect(computeDirectLandToken({ patch: PATCH, headSha: HEAD, nonce: 'n1', expiry: 6, secret: SECRET })).not.toBe(base)
  })

  it('getDirectLandSecret reads env (primary + alias)', () => {
    expect(getDirectLandSecret({ DIRECT_LAND_TOKEN_SECRET: 'a' })).toBe('a')
    expect(getDirectLandSecret({ ANYA_DIRECT_LAND_SECRET: 'b' })).toBe('b')
    expect(getDirectLandSecret({})).toBe('')
  })
})

describe('recordAndConsumeNonce — single use', () => {
  function memDb() {
    const rows = new Map()
    return {
      prepare(sql) {
        return {
          async get(key) { return rows.has(key) ? { x: 1 } : undefined },
          async run(key, value, updated) { rows.set(key, { value, updated }) },
        }
      },
    }
  }

  it('first use succeeds, second use of the SAME nonce is rejected (reused)', async () => {
    const db = memDb()
    const first = await recordAndConsumeNonce(db, 'nonce-1')
    const second = await recordAndConsumeNonce(db, 'nonce-1')
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('reused')
  })

  it('no DB → fail closed (cannot guarantee single-use)', async () => {
    const res = await recordAndConsumeNonce(null, 'nonce-x')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no_store')
  })
})
