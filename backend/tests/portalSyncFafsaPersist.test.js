/**
 * Portal sync → FAFSA lifecycle persistence.
 *
 * The studentaid.gov connector reports a FAFSA stage; this is the write side —
 * the orchestrator applies it through the CANONICAL owner
 * (services/college/fafsaStatus.js) rather than as a raw section field.
 *
 * WHY IT CANNOT BE A FIELD WRITE: `fafsa_status` is not in the education
 * section's field metadata, so setProfileSectionField's guard would reject it
 * outright (the sync would report a rejected field and silently keep a stale
 * lifecycle). It is also a compound fact — stage + history + the derived
 * `fafsa_completed` boolean — that only setFafsaStage knows how to keep
 * consistent.
 *
 * Pins:
 *   - a portal-read stage ADVANCES the lifecycle and syncs the legacy boolean;
 *   - it NEVER regresses one (studentaid.gov renders stale "Submitted on…"
 *     banners beside newer state; a regression would erase verification
 *     progress the student recorded by hand) — the disagreement is REPORTED;
 *   - history is appended, not clobbered;
 *   - a connector that read no stage writes nothing at all.
 */
import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const { _internal } = await import('../services/hamilton/portalSync/index.js')
const { describeFafsaStatus } = await import('../services/college/fafsaStatus.js')

const PROFILE = 'p-fafsa'
const applyFafsa = (db, readResult) =>
  _internal.applyFafsaStatusFromRead(db, { profileId: PROFILE, actorUserId: 'u1', readResult })

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
})

function seedEducation(education) {
  db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'education', ?)")
    .run(PROFILE, JSON.stringify(education))
}

function readEducation() {
  const row = db.prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'education'").get(PROFILE)
  return row?.data ? JSON.parse(row.data) : null
}

describe('applyFafsaStatusFromRead', () => {
  it('advances the lifecycle from a portal read and syncs the legacy boolean', async () => {
    seedEducation({ fafsa_completed: false, gpa: '3.8' })

    const res = await applyFafsa(db, { fafsaStatus: { stage: 'submitted', evidence: 'Your FAFSA form was submitted on January 5, 2026.' } })

    expect(res.applied).toBe(true)
    expect(res.from).toBe('not_started')
    const education = readEducation()
    expect(education.fafsa_status.stage).toBe('submitted')
    // The legacy boolean must move with the stage.
    expect(education.fafsa_completed).toBe(true)
    // Sibling fields are merged, never clobbered.
    expect(education.gpa).toBe('3.8')
    expect(describeFafsaStatus(education).label).toBe('Submitted')
  })

  it('creates the education section when the profile has none yet', async () => {
    const res = await applyFafsa(db, { fafsaStatus: { stage: 'processed' } })
    expect(res.applied).toBe(true)
    expect(readEducation().fafsa_status.stage).toBe('processed')
  })

  it('REFUSES to regress: a stale "Submitted" banner cannot erase recorded verification progress', async () => {
    seedEducation({
      fafsa_status: { stage: 'verification', updated_at: '2026-07-01T00:00:00Z', history: [{ stage: 'verification', at: '2026-07-01T00:00:00Z' }] },
      fafsa_completed: true,
      fafsa_verification_docs: { verification_worksheet: true },
    })

    const res = await applyFafsa(db, { fafsaStatus: { stage: 'submitted', evidence: 'Submitted on January 5, 2026' } })

    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/would_regress/)
    const education = readEducation()
    expect(education.fafsa_status.stage).toBe('verification')
    // The student's own verification-document progress survives untouched.
    expect(education.fafsa_verification_docs.verification_worksheet).toBe(true)
  })

  it('is a no-op at the same stage (idempotent across repeated syncs)', async () => {
    seedEducation({ fafsa_status: { stage: 'submitted', updated_at: '2026-07-01T00:00:00Z', history: [] }, fafsa_completed: true })

    const res = await applyFafsa(db, { fafsaStatus: { stage: 'submitted' } })

    expect(res.applied).toBe(false)
    expect(res.reason).toBe('already_at_stage')
    expect(readEducation().fafsa_status.updated_at).toBe('2026-07-01T00:00:00Z')
  })

  it('appends to history rather than clobbering it', async () => {
    seedEducation({
      fafsa_status: { stage: 'submitted', updated_at: '2026-07-01T00:00:00Z', history: [{ stage: 'submitted', at: '2026-07-01T00:00:00Z' }] },
      fafsa_completed: true,
    })

    await applyFafsa(db, { fafsaStatus: { stage: 'verification' } })

    const history = readEducation().fafsa_status.history
    expect(history).toHaveLength(2)
    expect(history[0].stage).toBe('submitted')
    expect(history[1].stage).toBe('verification')
  })

  it('writes NOTHING when the connector read no stage, or reported an unknown one', async () => {
    seedEducation({ fafsa_completed: false })

    expect(await applyFafsa(db, { fafsaStatus: null })).toBe(null)
    expect(await applyFafsa(db, {})).toBe(null)
    const unknown = await applyFafsa(db, { fafsaStatus: { stage: 'made_up_stage' } })
    expect(unknown.applied).toBe(false)
    expect(unknown.reason).toBe('unknown_stage')

    expect(readEducation().fafsa_status).toBeUndefined()
  })

  it('an applied stage counts as a written field in the run summary (so the sync is not reported empty)', async () => {
    seedEducation({ fafsa_completed: false })
    const persisted = await _internal.persistReadResult(db, {
      profileId: PROFILE,
      portalHost: 'studentaid.gov',
      actorUserId: 'u1',
      readResult: { fields: [], awards: [], fafsaStatus: { stage: 'submitted' } },
    })
    expect(persisted.fieldsWritten).toBe(1)
    expect(persisted.fafsaStatus.applied).toBe(true)
  })
})
