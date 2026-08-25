/**
 * priorCycleApplicationGuard.test.js
 *
 * The guard blocks a SECOND application to a program the profile already
 * applied to - the case `ux_application_tasks_profile_subject` cannot see,
 * because it keys on row id while a recurring program (or an outside
 * submission) has a different row, or no row at all.
 *
 * The honesty properties matter as much as the blocking: an owner ATTESTATION
 * must never be presented as proof GrantFlow holds, and a mistaken claim must be
 * retractable without being deleted.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'd'.repeat(64)

const HERE = dirname(fileURLToPath(import.meta.url))
const { SqliteDb } = await import('../db/index.js')
const {
  assessDuplicateApplicationRisk,
  attestPriorApplication,
  cyclesConflict,
  listPriorApplicationClaims,
  programIdentityKey,
  recordVerifiedSubmissionClaim,
  retractPriorApplicationClaim,
  PRIOR_CLAIM_ORIGIN,
} = await import('../services/hamilton/priorCycleApplicationGuard.js')

const MIGRATION = join(HERE, '../db/migrations/184_prior_cycle_application_claims.sql')

async function makeDb({ withClaimsTable = true } = {}) {
  const db = new SqliteDb(':memory:')
  await db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      title TEXT,
      sponsor TEXT,
      apply_url TEXT,
      application_url TEXT,
      url TEXT,
      source_url TEXT,
      canonical_opportunity_key TEXT
    );
    INSERT INTO profiles (id) VALUES ('profile-1'), ('profile-2');
  `)
  // Two DISTINCT rows for the SAME program - exactly the recurring-award shape
  // the unique index on (profile, opportunity) cannot catch.
  await db.exec(`
    INSERT INTO funding_opportunities (id, title, sponsor, canonical_opportunity_key)
    VALUES ('opp-2025', 'Community Health Fellowship', 'Acme Foundation', 't:acme foundation::community fellowship health'),
           ('opp-2026', 'Community Health Fellowship', 'Acme Foundation', 't:acme foundation::community fellowship health'),
           ('opp-other', 'Rural Broadband Grant', 'Other Trust', 't:other trust::broadband grant rural');
  `)
  if (withClaimsTable) await db.exec(await readFile(MIGRATION, 'utf8'))
  return db
}

/**
 * Assert a DB write is refused, regardless of dialect. better-sqlite3 is
 * SYNCHRONOUS, so a trigger abort throws before any promise exists and
 * `.rejects` would never see it; the same statement on Postgres rejects
 * asynchronously. Catching both is what makes these assertions honest on
 * whichever database actually runs them.
 */
async function expectRefused(run, pattern) {
  let error = null
  try {
    await run()
  } catch (err) {
    error = err
  }
  expect(error, 'expected the write to be refused, but it succeeded').not.toBeNull()
  expect(String(error?.message ?? error)).toMatch(pattern)
}

let db
beforeEach(async () => { db = await makeDb() })
afterEach(async () => { await db?.close() })

describe('prior-cycle application guard', () => {
  it('reads the PERSISTED canonical key rather than recomputing it', async () => {
    // Recomputation would fall to the title tier and miss ext:-tier rows, whose
    // stored key is what the unique index actually enforces.
    expect(programIdentityKey({ canonical_opportunity_key: 'ext:pa-25-123', title: 'X', sponsor: 'Y' }))
      .toBe('ext:pa-25-123')
  })

  it('blocks a second application to the same program on a DIFFERENT row', async () => {
    await recordVerifiedSubmissionClaim(db, {
      profileId: 'profile-1',
      opportunityId: 'opp-2025',
      confirmationReference: 'ACME-2025-991',
    })
    const risk = await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1',
      opportunityId: 'opp-2026',
    })
    expect(risk).not.toBeNull()
    expect(risk.blocking_origin).toBe(PRIOR_CLAIM_ORIGIN.GRANTFLOW_VERIFIED)
    expect(risk.independently_verified).toBe(true)
  })

  it('does not block a DIFFERENT program', async () => {
    await recordVerifiedSubmissionClaim(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    expect(await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1', opportunityId: 'opp-other',
    })).toBeNull()
  })

  it('does not leak a claim across profiles', async () => {
    await recordVerifiedSubmissionClaim(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    expect(await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-2', opportunityId: 'opp-2026',
    })).toBeNull()
  })

  it('allows a PROVABLY different cycle, and blocks when either side is unknown', async () => {
    expect(cyclesConflict('2025-2026', '2026-2027')).toBe(false)
    expect(cyclesConflict('2025-2026', '2025-2026')).toBe(true)
    // Unknown on either side conflicts: a false block costs a confirmation
    // click, a false pass costs funder-side disqualification.
    expect(cyclesConflict(null, '2026-2027')).toBe(true)
    expect(cyclesConflict('2025-2026', null)).toBe(true)

    await recordVerifiedSubmissionClaim(db, {
      profileId: 'profile-1', opportunityId: 'opp-2025', cycleLabel: '2025-2026',
    })
    expect(await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1', opportunityId: 'opp-2026', cycleLabel: '2026-2027',
    })).toBeNull()
    expect(await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1', opportunityId: 'opp-2026', cycleLabel: '2025-2026',
    })).not.toBeNull()
  })

  it('blocks on an ATTESTATION but never calls it verified', async () => {
    const written = await attestPriorApplication(db, {
      profileId: 'profile-1',
      opportunityId: 'opp-2025',
      note: 'applied on the funder portal directly',
      attestedByUserId: 'user-1',
    })
    expect(written.origin).toBe(PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED)

    const risk = await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1', opportunityId: 'opp-2026',
    })
    expect(risk).not.toBeNull()
    // THE honesty property: an attestation blocks, but is reported as the
    // user's own report - never as proof GrantFlow holds.
    expect(risk.independently_verified).toBe(false)
    expect(risk.blocking_origin).toBe(PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED)
    expect(risk.instructions).toMatch(/not verified by GrantFlow/i)
  })

  it('never stores a confirmation reference on an attestation', async () => {
    await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    const row = await db.prepare(
      `SELECT origin, confirmation_reference FROM prior_cycle_application_claims WHERE profile_id = 'profile-1'`,
    ).get()
    expect(row.origin).toBe(PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED)
    expect(row.confirmation_reference).toBeNull()
  })

  it('reports a repeat attestation as a duplicate instead of a fresh write', async () => {
    const a = await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    const b = await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2026' })
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(true)
    expect(b.id).toBe(a.id)
  })

  it('retracts a claim, unblocking the program, without deleting the record', async () => {
    const written = await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    await retractPriorApplicationClaim(db, {
      profileId: 'profile-1',
      claimId: written.id,
      reason: 'I confused this with a different grant',
      retractedByUserId: 'user-1',
    })
    expect(await assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1', opportunityId: 'opp-2026',
    })).toBeNull()

    const row = await db.prepare(
      `SELECT status, retraction_reason FROM prior_cycle_application_claims WHERE id = ?`,
    ).get(written.id)
    expect(row.status).toBe('retracted')
    expect(row.retraction_reason).toMatch(/confused/)
  })

  it('refuses a retraction with no reason', async () => {
    const written = await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    await expect(retractPriorApplicationClaim(db, {
      profileId: 'profile-1', claimId: written.id, reason: '   ', retractedByUserId: 'user-1',
    })).rejects.toThrow(/reason is required/i)
  })

  it('DELETE is aborted by the append-only trigger', async () => {
    const written = await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    await expectRefused(
      () => db.prepare(`DELETE FROM prior_cycle_application_claims WHERE id = ?`).run(written.id),
      /append-only/i,
    )
    // and the row is still there, which is the point of append-only
    const still = await db.prepare(
      `SELECT id FROM prior_cycle_application_claims WHERE id = ?`,
    ).get(written.id)
    expect(still?.id).toBe(written.id)
  })

  it('an UPDATE that is not a well-formed retraction is aborted', async () => {
    const written = await attestPriorApplication(db, { profileId: 'profile-1', opportunityId: 'opp-2025' })
    // Silently upgrading an attestation to verified is the exact abuse the
    // trigger exists to stop.
    await expectRefused(
      () => db.prepare(`UPDATE prior_cycle_application_claims SET origin = 'grantflow_verified' WHERE id = ?`)
        .run(written.id),
      /may only be retracted/i,
    )
    // A retraction with no reason is equally malformed.
    await expectRefused(
      () => db.prepare(`UPDATE prior_cycle_application_claims SET status = 'retracted', retracted_at = '2026-01-01' WHERE id = ?`)
        .run(written.id),
      /may only be retracted/i,
    )
    // The attestation survived both attempts unchanged.
    const row = await db.prepare(
      `SELECT origin, status FROM prior_cycle_application_claims WHERE id = ?`,
    ).get(written.id)
    expect(row.origin).toBe(PRIOR_CLAIM_ORIGIN.OWNER_ATTESTED)
    expect(row.status).toBe('active')
  })

  it('FAILS OPEN when the claims table has not been migrated yet', async () => {
    const bare = await makeDb({ withClaimsTable: false })
    try {
      // A rolling deploy must never block legitimate applications.
      await expect(assessDuplicateApplicationRisk(bare, {
        profileId: 'profile-1', opportunityId: 'opp-2026',
      })).resolves.toBeNull()
      await expect(listPriorApplicationClaims(bare, { profileId: 'profile-1' })).resolves.toEqual([])
    } finally {
      await bare.close()
    }
  })

  it('does not throw when the opportunity does not exist', async () => {
    await expect(assessDuplicateApplicationRisk(db, {
      profileId: 'profile-1', opportunityId: 'nope',
    })).resolves.toBeNull()
  })
})

/**
 * The wiring, not just the service. A guard that is correct in isolation and
 * unreachable from the create path protects nothing.
 */
describe('ensureApplicationTask honours the guard', () => {
  let store

  beforeEach(async () => {
    store = await import('../services/hamilton/applicationTaskStore.js')
    store._resetSchemaCache?.()
    await store.ensureApplicationTaskSchema(db)
  })

  afterEach(() => { store?._resetSchemaCache?.() })

  it('refuses a second task for the same program with a 422 and a handoff', async () => {
    await recordVerifiedSubmissionClaim(db, {
      profileId: 'profile-1', opportunityId: 'opp-2025', confirmationReference: 'ACME-991',
    })

    let error = null
    try {
      await store.ensureApplicationTask(db, {
        profileId: 'profile-1', opportunityId: 'opp-2026', initialStatus: 'queued',
      })
    } catch (err) { error = err }

    expect(error, 'the guard did not fire on the create path').not.toBeNull()
    expect(error.code).toBe('prior_cycle_application_risk')
    expect(error.statusCode).toBe(422)
    // A refusal must explain itself and offer a next action, never be a silent
    // dead end.
    expect(error.handoff?.next_actions?.length).toBeGreaterThan(0)
    expect(error.handoff.independently_verified).toBe(true)

    const count = await db.prepare(
      `SELECT COUNT(*) AS n FROM application_tasks WHERE profile_id = 'profile-1'`,
    ).get()
    expect(Number(count.n)).toBe(0)
  })

  it('proceeds when a human explicitly confirms a separate cycle', async () => {
    await recordVerifiedSubmissionClaim(db, {
      profileId: 'profile-1', opportunityId: 'opp-2025', cycleLabel: '2025-2026',
    })
    const task = await store.ensureApplicationTask(db, {
      profileId: 'profile-1',
      opportunityId: 'opp-2026',
      initialStatus: 'queued',
      confirmedNewCycle: true,
    })
    expect(task?.id).toBeTruthy()
  })

  it('still ADOPTS an existing task for a program the profile already submitted', async () => {
    // Regression guard for the placement of the check. A claim minted from a
    // task's OWN verified submission matches that same program identity, so a
    // check placed before the existing-task lookup would 422 every later
    // re-entry into an application that legitimately worked.
    const first = await store.ensureApplicationTask(db, {
      profileId: 'profile-1', opportunityId: 'opp-2025', initialStatus: 'queued',
    })
    await recordVerifiedSubmissionClaim(db, {
      profileId: 'profile-1', opportunityId: 'opp-2025', taskId: first.id,
    })
    const again = await store.ensureApplicationTask(db, {
      profileId: 'profile-1', opportunityId: 'opp-2025', initialStatus: 'queued',
    })
    expect(again.id).toBe(first.id)
  })
})
