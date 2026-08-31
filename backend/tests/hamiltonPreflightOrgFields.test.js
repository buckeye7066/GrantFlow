/**
 * Preflight required fields are SCOPED TO PROFILE TYPE (2026-08-23).
 *
 * Measured on prod: an ORGANIZATION profile was blocked at preflight for
 * individual/student fields it can never have — "Focus Forward Ministry" on
 * "missing first name; missing last name", "Vermilion Church of God of
 * Prophecy" on "missing school / university". An org has no first name and is
 * never a student; those are false blockers. A person keeps the person fields.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { preflightSingleSource } from '../services/hamilton/hamiltonPreflight.js'

let db
beforeAll(() => { db = new Database(':memory:') })

const SCHOLARSHIP_OPP = {
  id: 'opp-sch',
  title: 'Community College Scholarship',
  description: 'A scholarship for students.',
  application_url: 'https://example.org/apply',
}
const missingKeys = (r) => r.blockers.filter((b) => b.kind === 'missing_field').map((b) => b.key)

describe('preflight required fields scoped to profile type', () => {
  it('an ORG profile (ministry) is NOT blocked for first/last name — it needs its org name + email', async () => {
    const profile = {
      id: 'org1',
      display_name: 'Focus Forward Ministry',
      primary_type: 'ministry',
      basic_information: { email: 'vjvandev@charter.net' },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'org1', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    const keys = missingKeys(report)
    expect(keys).not.toContain('first_name')
    expect(keys).not.toContain('last_name')
    // Its org name (display_name) satisfies the org identity, email is present.
    expect(keys).not.toContain('organization_name')
    expect(keys).not.toContain('email')
  })

  it('an ORG profile is NOT blocked on "missing school / university" for a scholarship (a church is never a student)', async () => {
    const profile = {
      id: 'org2',
      display_name: 'Vermilion Church of God of Prophecy',
      basic_information: { first_name: 'Irene', email: 'x@example.org' },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'org2', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    expect(missingKeys(report)).not.toContain('school_name')
  })

  it('an ORG with NO name anywhere IS blocked for organization_name (it must have a name to apply)', async () => {
    const profile = { id: 'org3', primary_type: 'nonprofit', basic_information: { email: 'x@example.org' } }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'org3', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    const keys = missingKeys(report)
    expect(keys).toContain('organization_name')
    expect(keys).not.toContain('first_name')
  })

  it('a PERSON profile still needs first/last name (unchanged)', async () => {
    const profile = { id: 'p1', display_name: 'Demo Senior Applicant', basic_information: { email: 'a@example.com' } }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p1', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    // This profile has a display name → first/last derive from it (no block), but a
    // person with no name at all still blocks — assert the person PATH is taken
    // (school can still be required for a real student individual).
    const report2 = await preflightSingleSource(db, {
      profile: { id: 'p2', basic_information: { email: 'a@example.com' } },
      profileId: 'p2', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    expect(missingKeys(report2)).toContain('first_name')
    // A person is NOT asked for organization_name.
    expect(missingKeys(report2)).not.toContain('organization_name')
  })

  it('a PERSON applying for a scholarship gets a school WARNING, never a hard block (2026-08-30: preflight may only require what the actual form needs)', async () => {
    const profile = { id: 'p3', display_name: 'Jane Q Public', basic_information: { first_name: 'Jane', last_name: 'Public', email: 'j@example.com' } }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p3', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    // The engine files a precise per-field ask if the real form demands a
    // school; preflight no longer stops the run for it.
    expect(missingKeys(report)).not.toContain('school_name')
    expect(report.warnings.filter((w) => w.kind === 'missing_field').map((w) => w.key)).toContain('school_name')
  })

  it('a HOUSING / emergency-cash grant never even warns about school (the CGMHN / Fair Haven / Seattle CDBG class)', async () => {
    const profile = { id: 'p4', display_name: 'Jane Q Public', basic_information: { first_name: 'Jane', last_name: 'Public', email: 'j@example.com' } }
    const housingOpp = {
      id: 'opp-housing',
      title: 'Emergency Cash Assistance Grant',
      description: 'Emergency financial assistance grants and aid for households facing eviction. Community development block grant program.',
      application_url: 'https://example.org/apply',
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p4', source: { opportunity_id: 'opp-housing' }, opportunity: housingOpp,
    })
    expect(missingKeys(report)).not.toContain('school_name')
    expect(report.warnings.map((w) => w.key)).not.toContain('school_name')
  })

  it('a school stored as education.schools[] satisfies the school read (the alternation-class shape)', async () => {
    const profile = {
      id: 'p5',
      display_name: 'Jane Q Public',
      basic_information: { first_name: 'Jane', last_name: 'Public', email: 'j@example.com' },
      education: { schools: [{ name: 'Middle Tennessee State University' }] },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p5', source: { opportunity_id: 'opp-sch' }, opportunity: SCHOLARSHIP_OPP,
    })
    expect(report.warnings.map((w) => w.key)).not.toContain('school_name')
  })
})
