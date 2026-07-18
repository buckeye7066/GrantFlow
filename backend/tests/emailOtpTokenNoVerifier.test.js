/**
 * SECURITY REGRESSION (round 18): the email OTP flow must PROVE inbox possession.
 *
 * Pre-existing bypass: POST /api/auth/email/start signed a JWT containing
 * code_hash = sha256(email:code) and RETURNED it to the requester. A JWT is
 * signed, NOT encrypted, so the client could base64-decode the hash and brute-
 * force all 1,000,000 six-digit codes offline (sha256 → instant), recover the
 * real code, and log in as the victim — after which the r17 credential-bound
 * profile adoption would (correctly) attach the victim's profiles. That made the
 * "identity-establishing" classification of /email/verify FALSE.
 *
 * Fix: the token carries NO verifier; verification is authoritative against the
 * server-side one-time DB code row (hashed, expiring, attempt-limited).
 *
 * This suite proves: (1) the returned token cannot be used to recover the code
 * offline and is not accepted as a bypass; (2) an online brute-force of
 * /email/verify is bounded by a max-attempts lockout; (3) the legitimate flow
 * (the real delivered code) still verifies.
 */

import { describe, expect, it, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { getAppAndDb, resetDb } from './testServer.js'

const { hashValue } = await import('../routes/auth.js')

let app, db
beforeAll(async () => {
  const loaded = await getAppAndDb()
  app = loaded.app
  db = loaded.db
})
beforeEach(() => resetDb(db))

// Generate a 6-digit code guaranteed different from `avoid`.
function wrongCode(avoid, i) {
  const n = 100000 + ((Number(avoid) + i + 1) % 900000)
  return String(n)
}

async function start(email) {
  const res = await request(app).post('/api/auth/email/start').send({ email })
  expect(res.status).toBe(202)
  return res.body
}

describe('email OTP token exposes no brute-forceable verifier', () => {
  it('the returned verification_token contains no code verifier (code cannot be recovered offline)', async () => {
    const email = 'victim@example.test'
    const body = await start(email)
    expect(typeof body.verification_token).toBe('string')
    // In non-prod the delivered code is echoed as previewCode (stands in for the
    // email channel). The ATTACKER only has verification_token, never this.
    const deliveredCode = body.previewCode
    expect(deliveredCode).toMatch(/^\d{6}$/)

    // The attacker base64-decodes the signed (not encrypted) token.
    const decoded = jwt.decode(body.verification_token)
    expect(decoded).toBeTruthy()
    // No verifier field, and the real verifier hash appears NOWHERE in the payload.
    expect(decoded.code_hash).toBeUndefined()
    const verifier = hashValue(`${email}:${deliveredCode}`)
    const payloadValues = Object.values(decoded).map((v) => String(v))
    expect(payloadValues).not.toContain(verifier)

    // And the token is not accepted as a bypass: a wrong code + the token fails.
    const res = await request(app)
      .post('/api/auth/email/verify')
      .send({ email, code: wrongCode(deliveredCode, 0), verification_token: body.verification_token })
    expect(res.status).not.toBe(200)
  })

  it('an online brute-force of /email/verify is bounded by a max-attempts lockout', async () => {
    const email = 'bruteforce@example.test'
    const body = await start(email)
    const deliveredCode = body.previewCode

    let saw429 = false
    for (let i = 0; i < 20 && !saw429; i++) {
      const res = await request(app)
        .post('/api/auth/email/verify')
        .send({ email, code: wrongCode(deliveredCode, i) })
      if (res.status === 429) {
        saw429 = true
        expect(res.body?.error_type).toBe('too_many_attempts')
      } else {
        expect(res.status).toBe(400) // invalid code, not a success
      }
    }
    expect(saw429).toBe(true)

    // Lockout invalidated the active code: even the REAL code no longer verifies
    // (the attacker must trigger a fresh /email/start, which re-alerts the owner).
    const real = await request(app).post('/api/auth/email/verify').send({ email, code: deliveredCode })
    expect(real.status).not.toBe(200)
  })

  it('the legitimate flow (the real delivered code) still verifies', async () => {
    const email = 'legit@example.test'
    const body = await start(email)
    const res = await request(app).post('/api/auth/email/verify').send({ email, code: body.previewCode })
    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeTruthy()
    expect(res.body.refreshToken).toBeTruthy()
  })
})
