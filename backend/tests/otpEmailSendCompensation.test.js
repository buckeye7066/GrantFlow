/**
 * SECURITY REGRESSION (round 22): winner-only send + send-failure compensation,
 * exercised end-to-end through /email/start by mocking the email service to be
 * CONFIGURED (so a false return is a definitive failure, not the tolerant
 * unconfigured/dev path) and controllably succeed/fail.
 *
 *  - A configured send FAILURE after the mint → 502, the minted code is invalidated
 *    (no verifiable code the user never received) and last_sent_at is rewound (a
 *    retry is NOT cooldown-blocked).
 *  - Concurrent post-cooldown starts with a SUCCEEDING send → the sender is invoked
 *    exactly ONCE (only the serialized mint winner sends).
 */

// Raise the per-IP rate limit before auth.js loads (see otpStartOrdering.test.js).
process.env.AUTH_EMAIL_RATE_LIMIT = '1000'

import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'

const state = vi.hoisted(() => ({ sendCalls: 0, shouldSucceed: false }))

vi.mock('../services/email.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    isEmailServiceConfigured: () => true,
    sendVerificationEmail: vi.fn(async () => {
      state.sendCalls += 1
      return state.shouldSucceed
    }),
  }
})

const { getAppAndDb, resetDb } = await import('./testServer.js')

const now = () => new Date().toISOString()
const activeCodes = (db, email) =>
  db.prepare(
    `SELECT COUNT(*) c FROM user_verification_codes vc JOIN user_credentials uc ON uc.id = vc.credential_id
     WHERE uc.identifier = ? AND vc.consumed_at IS NULL AND (vc.expires_at IS NULL OR vc.expires_at >= ?)`,
  ).get(email, now())

let app, db
beforeAll(async () => { const l = await getAppAndDb(); app = l.app; db = l.db })
beforeEach(() => { resetDb(db); state.sendCalls = 0 })

describe('/email/start winner-only send + compensation (configured email service)', () => {
  it('a configured send FAILURE → 502, code invalidated, last_sent_at rewound (retry unblocked)', async () => {
    state.shouldSucceed = false
    const email = 'compensate@example.test'

    const res = await request(app).post('/api/auth/email/start').send({ email })
    expect(res.status).toBe(502)
    expect(res.body.error_type).toBe('email_send_failed')
    expect(state.sendCalls).toBe(1)

    // No verifiable code the user never received.
    expect(Number(activeCodes(db, email).c)).toBe(0)
    // last_sent_at rewound → a retry is NOT cooldown-blocked.
    const cred = db.prepare(`SELECT last_sent_at FROM user_credentials WHERE identifier = ?`).get(email)
    expect(cred.last_sent_at).toBeNull()

    // Retry immediately: must NOT be 429 (cooldown was rewound); still 502 (send still failing).
    const retry = await request(app).post('/api/auth/email/start').send({ email })
    expect(retry.status).toBe(502)
    expect(retry.status).not.toBe(429)
  })

  it('concurrent post-cooldown starts with a succeeding send invoke the sender exactly ONCE', async () => {
    state.shouldSucceed = true
    const email = 'sender-once@example.test'

    // Establish the credential + cooldown, then clear it so N race the mint.
    expect((await request(app).post('/api/auth/email/start').send({ email })).status).toBe(202)
    db.prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE identifier = ?`).run(email)
    state.sendCalls = 0

    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/auth/email/start').send({ email })),
    )
    // Only the serialized winner minted + sent; the rest 429 at the cooldown re-check.
    expect(results.filter((r) => r.status === 202).length).toBe(1)
    expect(state.sendCalls).toBe(1)
    expect(Number(activeCodes(db, email).c)).toBe(1)
  })
})
