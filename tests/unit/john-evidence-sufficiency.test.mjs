/**
 * John — evidence sufficiency + the John→Yana decision.
 *
 * These pure-function tests pin the behaviour that decides whether John can
 * write a personable, specific email or must ask Yana for more — and that the
 * rewritten template never reproduces the old bland "…work around
 * community-focused funding work" / "what caught my attention about you was …"
 * copy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyDefaultJohnEnv, makeQualifiedLead } from './john-test-helpers.mjs'
import {
  extractOrgSignals,
  assessLeadSufficiency,
} from '../../backend/services/john/johnEvidenceSufficiency.js'
import { composeEmailFromLead } from '../../backend/services/john/johnEmailWriter.js'
import { getJohnConfig } from '../../backend/services/john/johnOutreachSafety.js'

test('extractOrgSignals reads typed mission, focus, program, and website evidence', () => {
  const lead = {
    organization_name: 'Bright Futures Academy',
    public_evidence: [
      { type: 'mission_statement', text: 'We prepare first-generation students for college.' },
      { type: 'focus_areas', value: ['education', 'youth mentoring'] },
      { type: 'program_areas', value: ['after-school tutoring'] },
      { type: 'website_excerpt', text: 'Founded in 2011, we serve 400 students annually.' },
      { type: 'contact', name: 'Dana Reed', email: 'dana@bright.test' },
    ],
  }
  const s = extractOrgSignals(lead)
  assert.equal(s.mission, 'We prepare first-generation students for college.')
  assert.deepEqual(s.focusAreas, ['education', 'youth mentoring'])
  assert.deepEqual(s.programAreas, ['after-school tutoring'])
  assert.ok(s.websiteExcerpt)
  assert.equal(s.hasSpecific, true)
})

test('assessLeadSufficiency: a thin packet is insufficient and produces a Yana note', () => {
  const lead = {
    organization_name: 'Jsl Education Foundation',
    // Only a contact channel — nothing specific to personalize on.
    public_evidence: [{ type: 'contact', name: null, email: 'info@jsl.test' }],
    grantflow_fit_summary: 'Organization with a contact channel — potential GrantFlow client.',
    contact_points: [{ type: 'email', value: 'info@jsl.test' }],
  }
  const a = assessLeadSufficiency(lead, { contact: {} })
  assert.equal(a.sufficient, false)
  assert.ok(a.note && /Jsl Education Foundation/.test(a.note))
  assert.ok(a.missing.includes('mission_statement'))
  assert.ok(a.missing.includes('named_contact'))
})

test('assessLeadSufficiency: a substantive free-text hook is enough to proceed', () => {
  const lead = makeQualifiedLead({}) // default has "replacing 25-year-old SCBA gear"
  const a = assessLeadSufficiency(lead, { contact: { name: 'Chief Allen' } })
  assert.equal(a.sufficient, true)
  assert.equal(a.note, null)
})

test('rewritten template has no doubled "work" and no "about you was" filler', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    // A genuinely thin lead that would have hit the old generic fallback.
    const lead = makeQualifiedLead({
      organization_name: 'Quiet Creek Fund',
      public_evidence: [{ type: 'contact', name: 'Pat Lee', email: 'pat@quiet.test' }],
      contact_points: [{ type: 'email', value: 'pat@quiet.test', name: 'Pat Lee', confidence: 0.8 }],
    })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.equal(r.ok, true)
    assert.doesNotMatch(r.body_text, /work around/i)
    assert.doesNotMatch(r.body_text, /community-focused funding work/i)
    assert.doesNotMatch(r.body_text, /caught my attention about you was/i)
    // Still a complete, compliant email.
    assert.match(r.body_text, /Quiet Creek Fund/)
    assert.match(r.body_text, /no thanks/i)
    assert.match(r.body_text, /Anya/)
  } finally {
    restore()
  }
})

test('focus areas surface as a clean list phrase in the opening line', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({
      organization_name: 'Bright Futures Academy',
      public_evidence: [{ type: 'focus_areas', value: ['education', 'youth mentoring'] }],
    })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.match(r.body_text, /education and youth mentoring/)
    assert.equal(r.personalization.evidence_specific, true)
  } finally {
    restore()
  }
})
