/**
 * The pre-authorized-spend cap must hold under CONCURRENCY.
 *
 * `canPayFor()` reads `spent_cents` and approves; `recordCharge()` then wrote
 * `SET spent_cents = spent_cents + ?` with `WHERE id = ?` and nothing else. Two
 * charges racing against one authorization therefore both read the same stale
 * `spent_cents`, both cleared the check, and both incremented — spending past
 * the envelope the authorization exists to bound. That is the whole point of a
 * payment authorization, so a check-then-write with no atomicity is not a cap.
 *
 * `concurrent charges cannot exceed the cap` FAILS against the unguarded UPDATE.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  authorizePayment,
  canPayFor,
  recordCharge,
  PaymentAuthorizationExceededError,
  revokePaymentAuthorization,
} from '../services/hamilton/hamiltonPaymentAuthorizationService.js'

const PROFILE = 'profile-cap-test'
const CATEGORY = 'application_fee'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  return db
}

async function authorize(db, maxAmountCents) {
  return authorizePayment(db, {
    userId: 'user-cap-test',
    profileId: PROFILE,
    category: CATEGORY,
    maxAmountCents,
    paymentMethodLabel: 'Test card',
    paymentMethodReference: 'tok_test',
    authorizationText: 'Owner authorized application fees for testing.',
  })
}

describe('payment authorization cap', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('records a charge inside the cap', async () => {
    const auth = await authorize(db, 10_000)
    const updated = await recordCharge(db, { authorizationId: auth.id, amountCents: 4_000 })
    expect(updated.spent_cents).toBe(4_000)
  })

  it('refuses a single charge that would breach the cap', async () => {
    const auth = await authorize(db, 10_000)
    await recordCharge(db, { authorizationId: auth.id, amountCents: 8_000 })

    await expect(recordCharge(db, { authorizationId: auth.id, amountCents: 5_000 }))
      .rejects.toBeInstanceOf(PaymentAuthorizationExceededError)
  })

  it('leaves spent_cents untouched when a charge is refused', async () => {
    const auth = await authorize(db, 10_000)
    await recordCharge(db, { authorizationId: auth.id, amountCents: 8_000 })

    await expect(recordCharge(db, { authorizationId: auth.id, amountCents: 5_000 })).rejects.toThrow()

    const after = await canPayFor(db, { profileId: PROFILE, category: CATEGORY, amountCents: 1 })
    expect(after.authorization.spent_cents).toBe(8_000)
  })

  it('concurrent charges cannot exceed the cap', async () => {
    const auth = await authorize(db, 10_000)

    // Both charges are approved by the same pre-read — exactly the race.
    const a = await canPayFor(db, { profileId: PROFILE, category: CATEGORY, amountCents: 6_000 })
    const b = await canPayFor(db, { profileId: PROFILE, category: CATEGORY, amountCents: 6_000 })
    expect(a.allowed).toBe(true)
    expect(b.allowed).toBe(true)

    const results = await Promise.allSettled([
      recordCharge(db, { authorizationId: auth.id, amountCents: 6_000 }),
      recordCharge(db, { authorizationId: auth.id, amountCents: 6_000 }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1) // exactly one may win

    const final = await canPayFor(db, { profileId: PROFILE, category: CATEGORY, amountCents: 1 })
    // 12_000 would have been spent against a 10_000 cap under the old code.
    expect(final.authorization.spent_cents).toBe(6_000)
    expect(final.authorization.spent_cents).toBeLessThanOrEqual(10_000)
  })

  it('refuses a charge against a REVOKED authorization', async () => {
    const auth = await authorize(db, 10_000)
    await revokePaymentAuthorization(db, auth.id, 'owner_revoked')

    await expect(recordCharge(db, { authorizationId: auth.id, amountCents: 100 }))
      .rejects.toBeInstanceOf(PaymentAuthorizationExceededError)
  })

  it('allows a charge that exactly consumes the remaining balance', async () => {
    const auth = await authorize(db, 10_000)
    await recordCharge(db, { authorizationId: auth.id, amountCents: 7_000 })
    const updated = await recordCharge(db, { authorizationId: auth.id, amountCents: 3_000 })
    expect(updated.spent_cents).toBe(10_000)
  })
})
