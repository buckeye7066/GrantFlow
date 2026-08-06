/**
 * Regression: Hamilton must derive first/last name from a single full name
 * instead of raising a false "missing first/last name" hard stop.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { preflightSingleSource } from '../services/hamilton/hamiltonPreflight.js'

let db
beforeAll(() => { db = new Database(':memory:') })

const NON_STUDENT_OPP = {
  id: 'opp1',
  title: 'General Operating Support',
  description: 'Unrestricted grant',
  application_url: 'https://example.org/apply',
}

function missingKeys(report) {
  return report.blockers.filter((b) => b.kind === 'missing_field').map((b) => b.key)
}

describe('hamiltonPreflight - name derivation', () => {
  it('does not flag first/last name when basic_information.full_name is present', async () => {
    const profile = {
      id: 'p1',
      display_name: 'Jordan Nicole Lane',
      basic_information: { full_name: 'Jordan Nicole Lane', email: 'a@example.com' },
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
      display_name: 'Jordan Nicole Lane',
      basic_information: { email: 'a@example.com' },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p2', source: { opportunity_id: 'opp1' }, opportunity: NON_STUDENT_OPP,
    })
    expect(missingKeys(report)).not.toContain('first_name')
    expect(missingKeys(report)).not.toContain('last_name')
  })

  it('still flags a genuinely missing email', async () => {
    const profile = {
      id: 'p3',
      display_name: 'Jordan Nicole Lane',
      basic_information: { full_name: 'Jordan Nicole Lane' },
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

  it('derives from display_name even when university_applications carry school names (Demo Student regression)', async () => {
    // Prod regression: a student with a display_name AND 19 university_applications
    // (each entry.name = a university, an org-like string) was flagged "missing
    // first name" on 28 sources because the deep name scan matched a nested school
    // `name` first and looksLikeOrganization rejected it. The owner's display_name
    // must win so first/last derive correctly.
    const profile = {
      id: 'p5',
      display_name: 'Demo Tennessee STEM Student',
      basic_information: { email: 'demo_stem_student@example.com' },
      university_applications: {
        applications: [
          { id: 'u1', name: 'Middle Tennessee State University', status: 'committed' },
          { id: 'u2', name: 'University of Tennessee', status: 'planning' },
        ],
      },
    }
    const report = await preflightSingleSource(db, {
      profile, profileId: 'p5', source: { opportunity_id: 'opp1' }, opportunity: NON_STUDENT_OPP,
    })
    expect(missingKeys(report)).not.toContain('first_name')
    expect(missingKeys(report)).not.toContain('last_name')
  })
})
