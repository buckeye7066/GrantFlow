/**
 * Regression: Hamilton must DERIVE first/last name from a single full name
 * (basic_information.full_name or profiles.display_name) instead of raising a
 * false "missing first/last name" hard stop.
 *
 * This reproduces the production report — Anastasia's profile carries
 * full_name "Anastasia Nicole White" but no first_name/last_name, and Hamilton
 * kept falling back to "needs first name." The fix lives at the preflight CHECK
 * choke point (hamiltonPreflight.fieldPresent), so it holds no matter which of
 * the several Hamilton profile loaders hydrated the profile.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { preflightSingleSource } from '../services/hamilton/hamiltonPreflight.js'

// One shared in-memory sqlite db across the file so the preflight's incidental
// reads (documents, authorization schema self-heal) work. Some schema-ensure
// helpers memoize "already ensured" per process, so a fresh db per test could
// skip table creation — sharing one db sidesteps that. Profiles under test are
// passed in-memory, never read from this db.
let db
beforeAll(() => { db = new Database(':memory:') })

const NON_STUDENT_OPP = { id: 'opp1', title: 'General Operating Support', description: 'Unrestricted grant', application_url: 'https://example.org/apply' }

function missingKeys(report) {
  return report.blockers.filter((b) => b.kind === 'missing_field').map((b) => b.key)
}

describe('hamiltonPreflight — name derivation', () => {
  it('does NOT flag first/last name when basic_information.full_name is present', async () => {
    const profile = {
      id: 'p1',
      display_name: 'Anastasia Nicole White',
      basic_information: { full_name: 'Anastasia Nicole White', email: 'a@example.com' },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p1', source: { opportunity_id: 'opp1' }, opportunity: NON_STUDENT_OPP,
    })
    expect(missingKeys(report)).not.toContain('first_name')
    expect(missingKeys(report)).not.toContain('last_name')
  })

  it('derives from profiles.display_name when basic_information has no name at all', async () => {
    const profile = {
      id: 'p2',
      display_name: 'Anastasia Nicole White',
      basic_information: { email: 'a@example.com' },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p2', source: { opportunity_id: 'opp1' }, opportunity: NON_STUDENT_OPP,
    })
    expect(missingKeys(report)).not.toContain('first_name')
    expect(missingKeys(report)).not.toContain('last_name')
  })

  it('still flags a genuinely-missing email (does not over-suppress real gaps)', async () => {
    const profile = {
      id: 'p3',
      display_name: 'Anastasia Nicole White',
      basic_information: { full_name: 'Anastasia Nicole White' }, // no email anywhere
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p3', source: { opportunity_id: 'opp1' }, opportunity: NON_STUDENT_OPP,
    })
    expect(missingKeys(report)).toContain('email')
    expect(missingKeys(report)).not.toContain('first_name')
  })

  it('still flags first name when there is no name on the profile at all', async () => {
    const profile = { id: 'p4', basic_information: { email: 'a@example.com' } }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p4', source: { opportunity_id: 'opp1' }, opportunity: NON_STUDENT_OPP,
    })
    expect(missingKeys(report)).toContain('first_name')
  })
})
