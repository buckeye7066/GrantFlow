/**
 * THE WHOLE PROFILE REACHES THE CRAWLERS (owner order 2026-09-08).
 *
 * `buildProfileSignals` emits ~35 channels and `profileContextToThesisInput`
 * read 11. Occupation, GPA/ACT/SAT, household income and need level,
 * immigration status, rural/Appalachian/tribal qualifiers, licensure,
 * first-generation status, target colleges and a second city/county were all
 * computed, carried to the bridge, and DROPPED before any crawl ran.
 *
 * Measured on one real profile: a senior homeowner in rural Indiana whose
 * declared needs (housing/utilities/medical bills/food) reached the query
 * builder while his occupation, income band and rural status did not — so no
 * query could ever look for the programs those facts unlock.
 *
 * These tests pin the CHAIN, not one function: a fact declared on the profile
 * must survive the bridge, survive `buildThesis`, and become a real search.
 * Any one of those three links breaking silently is what caused the original
 * defect.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildThesis } from '../profileIntelligence.js'
import { buildWebQueries } from '../webQueries.js'

/** A thesis input shaped the way the bridge now produces one. */
const thesisInput = (over = {}) => ({
  profile_id: 'p-whole',
  applicant_types: ['individual'],
  needs: ['housing', 'utilities'],
  tags: [],
  need_categories: ['housing'],
  sections: [],
  location: { state: 'IN', states: ['IN'], county: 'La Grange', city: 'Lagrange', zip: '46761' },
  occupation: ['truck_driver'],
  credentials: ['cdl'],
  is_licensed_professional: true,
  academics: { gpa: 3.8 },
  financial: { householdIncome: 41000, householdSize: 3, needLevel: 'urgent' },
  immigration: ['permanent_resident'],
  geographic: ['rural'],
  education_profile: { firstGeneration: true, returningAdult: true, jobRetraining: true },
  secondary_location: { city: 'Fort Wayne', state: 'IN' },
  ...over,
})

test('buildThesis carries every newly-bridged channel — a dropped one dies here', () => {
  const t = buildThesis(thesisInput())
  assert.deepEqual(t.occupation, ['truck_driver'])
  assert.deepEqual(t.credentials, ['cdl'])
  assert.equal(t.is_licensed_professional, true)
  assert.equal(t.academics.gpa, 3.8)
  assert.equal(t.financial.householdIncome, 41000)
  assert.deepEqual(t.immigration, ['permanent_resident'])
  assert.deepEqual(t.geographic, ['rural'])
  assert.equal(t.education_profile.firstGeneration, true)
  assert.equal(t.secondary_location.city, 'Fort Wayne')
})

test('MISSING = NEUTRAL: a profile that declares none of it emits empties, never guesses', () => {
  const t = buildThesis({ profile_id: 'p-bare', applicant_types: ['individual'], needs: [], location: {} })
  assert.deepEqual(t.occupation, [])
  assert.deepEqual(t.credentials, [])
  assert.equal(t.is_licensed_professional, false)
  assert.equal(t.academics, null)
  assert.equal(t.financial, null)
  assert.deepEqual(t.geographic, [])
  assert.equal(t.education_profile, null)
})

test('the declared facts become REAL SEARCHES, not just thesis fields', () => {
  const t = buildThesis(thesisInput())
  const queries = buildWebQueries(t, { max: 40, seed: 1 }).map((q) => String(q).toLowerCase())
  const joined = queries.join(' │ ')

  // Occupation, rural status, immigration status, income band, urgency and
  // first-generation status each have to produce something searchable.
  assert.ok(joined.includes('truck driver'), 'occupation never became a query')
  assert.ok(joined.includes('rural'), 'geographic qualifier never became a query')
  assert.ok(joined.includes('permanent resident'), 'immigration status never became a query')
  assert.ok(joined.includes('low income'), 'income band never became a query')
  assert.ok(joined.includes('emergency financial assistance'), 'urgent need level never became a query')
  assert.ok(joined.includes('first generation'), 'first-generation status never became a query')
  assert.ok(joined.includes('job retraining'), 'job retraining never became a query')
})

// The truncation is the reason CORE vs EXTRA matters: `.slice(0, max)` cuts
// from the END, so a query in the rotated EXTRA pool is one that never runs at
// the live cap. The profile-fact queries must survive a REALISTIC bound.
test('the profile-fact queries survive the live cap — they are CORE, not EXTRA', () => {
  const t = buildThesis(thesisInput())
  const queries = buildWebQueries(t, { max: 14, seed: 1 }).map((q) => String(q).toLowerCase())
  const joined = queries.join(' │ ')
  assert.ok(joined.includes('truck driver') || joined.includes('rural') || joined.includes('low income'),
    'every profile-fact query was truncated away at a realistic cap')
})

test('a silent profile adds no profile-fact queries at all', () => {
  const t = buildThesis({ profile_id: 'p-bare', applicant_types: ['individual'], needs: ['housing'], location: { state: 'IN' } })
  const joined = buildWebQueries(t, { max: 40, seed: 1 }).join(' │ ').toLowerCase()
  assert.ok(!joined.includes('truck driver'))
  assert.ok(!joined.includes('first generation'))
  // A high income states nothing means-tested, so it must not mint a low-income query.
  const rich = buildThesis(thesisInput({ financial: { householdIncome: 250000 }, education_profile: null, occupation: [], geographic: [], immigration: [] }))
  const richJoined = buildWebQueries(rich, { max: 40, seed: 1 }).join(' │ ').toLowerCase()
  assert.ok(!richJoined.includes('low income'), 'a high income minted a low-income query')
})
