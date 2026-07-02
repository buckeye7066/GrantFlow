/**
 * John — funding lane personalization.
 *
 * Locks the quality contract added with the MBA-level rewrite: the org's own
 * evidence (organization_type + public_evidence signals) maps to the funding
 * categories GrantFlow would actually surface for that kind of org, and the
 * deterministic writer's subject + value proposition are shaped by that lane.
 *
 * Honesty guard: lanes name categories of funders, never promises — every
 * composed email must still pass the same safety classifiers the draft
 * service enforces.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyDefaultJohnEnv, makeQualifiedLead } from './john-test-helpers.mjs'
import { matchFundingLane, DEFAULT_FUNDING_FRAME } from '../../backend/services/john/johnFundingLanes.js'
import { extractOrgSignals } from '../../backend/services/john/johnEvidenceSufficiency.js'
import { composeEmailFromLead } from '../../backend/services/john/johnEmailWriter.js'
import { evaluateDraftSafety, getJohnConfig } from '../../backend/services/john/johnOutreachSafety.js'
import { SAFETY_STATUS } from '../../backend/services/john/johnTypes.js'

function laneFor(lead) {
  return matchFundingLane(lead, extractOrgSignals(lead))
}

test('matchFundingLane maps org types to their funding lanes', () => {
  const cases = [
    [{ organization_type: 'volunteer fire department' }, 'fire_ems'],
    [{ organization_type: 'church' }, 'faith'],
    [{ organization_type: 'food pantry' }, 'food_security'],
    [{ organization_type: 'elementary school PTO' }, 'education'],
    [{ organization_type: 'veterans service organization' }, 'veterans'],
    [{ organization_type: 'free health clinic' }, 'health'],
    [{ organization_type: 'animal shelter' }, 'animal_welfare'],
    [{ organization_type: 'community theater' }, 'arts_culture'],
    [{ organization_type: 'small business' }, 'small_business'],
  ]
  for (const [lead, expected] of cases) {
    const lane = laneFor(lead)
    assert.equal(lane?.key, expected, `expected ${expected} for ${lead.organization_type}`)
    assert.ok(lane.categories.length > 20, 'lane names concrete funding categories')
    assert.ok(lane.subjectLead, 'lane provides a subject lead-in')
  }
})

test('matchFundingLane falls back to evidence text when the type is missing', () => {
  const lane = laneFor({
    organization_type: null,
    public_evidence: [{ summary: 'raising funds to replace expired SCBA packs for its volunteers' }],
  })
  assert.equal(lane?.key, 'fire_ems')

  const foodLane = laneFor({
    organization_type: 'nonprofit',
    public_evidence: [{ type: 'focus_areas', value: ['food security', 'senior services'] }],
  })
  assert.equal(foodLane?.key, 'food_security')
})

test('matchFundingLane returns null (generic frame) when nothing matches', () => {
  const lane = laneFor({
    organization_type: 'organization',
    public_evidence: [{ summary: 'a general community group doing local projects' }],
  })
  assert.equal(lane, null)
  // The generic frame stays honest and never names a lane.
  assert.equal(DEFAULT_FUNDING_FRAME.key, null)
  assert.match(DEFAULT_FUNDING_FRAME.categories, /grants, foundation programs/)
})

test('lane copy never promises funding (honesty contract)', () => {
  // Every lane's categories/observation must survive the safety classifier
  // when embedded in a body. Spot-check the strings directly for banned words.
  const leads = [
    'volunteer fire department', 'church', 'food pantry', 'school', 'veterans group',
    'health clinic', 'animal shelter', 'arts council', 'small business', 'housing nonprofit',
    'youth mentoring program', 'conservation trust', 'student',
  ].map((t) => ({ organization_type: t }))
  for (const lead of leads) {
    const lane = laneFor(lead)
    if (!lane) continue
    const text = `${lane.subjectLead} ${lane.categories} ${lane.observation}`
    assert.doesNotMatch(text, /guarantee|approved|congratulations|will (get|receive|win|secure)/i)
    assert.doesNotMatch(text, /[—–]/, 'no em/en dashes in lane copy')
  }
})

test('writer: a food pantry hears about food-security funders, with a lane subject', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({
      organization_name: 'Hope Food Pantry',
      organization_type: 'food pantry',
      contact_points: [{ type: 'email', value: 'director@hope.test', name: 'Dana Fields', role: 'Executive Director', confidence: 0.9 }],
      public_evidence: [
        { summary: 'opened a saturday distribution for senior households', source_url: 'https://hope.test/news', specificity: 'high' },
        { type: 'focus_areas', value: ['food security', 'senior services'] },
      ],
    })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.equal(r.ok, true)
    assert.equal(r.subject, 'Food security funding options for Hope Food Pantry')
    assert.match(r.body_text, /hunger relief foundations/)
    assert.match(r.body_text, /saturday distribution/i)
    assert.doesNotMatch(r.body_text, /firefighter/i, 'no cross-lane bleed')
    assert.equal(r.personalization.funding_lane, 'food_security')
    assert.equal(r.personalization.organization_type, 'food pantry')
  } finally {
    restore()
  }
})

test('writer: a church hears about ministry/faith funders', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({
      organization_name: 'Grace Community Church',
      organization_type: 'church',
      contact_points: [{ type: 'email', value: 'office@grace.test', confidence: 0.7 }],
      public_evidence: [
        { type: 'mission_statement', text: 'Serving our neighborhood through youth mentoring and a weekly meal ministry.' },
      ],
    })
    const cfg = getJohnConfig()
    const r = await composeEmailFromLead(lead, { config: cfg })
    assert.equal(r.subject, 'Ministry and outreach funding options for Grace Community Church')
    assert.match(r.body_text, /faith-based and congregational funders/)
    // The org's own mission text is the hook, up top.
    assert.match(r.body_text.split('\n\n')[1], /weekly meal ministry/)
    assert.equal(r.personalization.funding_lane, 'faith')

    // Lane-personalized copy still passes the full safety gate.
    const safety = evaluateDraftSafety({
      lead,
      draft: { subject: r.subject, body: r.body_text, recipient_email: r.recipient_email },
      config: cfg,
    })
    assert.equal(safety.status, SAFETY_STATUS.PASSED, JSON.stringify(safety.reasons))
  } finally {
    restore()
  }
})

test('writer: no lane means honest generic copy, never an invented fit', async () => {
  const restore = applyDefaultJohnEnv()
  try {
    const lead = makeQualifiedLead({
      organization_name: 'Quiet Creek Fund',
      organization_type: 'organization',
      public_evidence: [{ summary: 'supports a range of local community projects each year' }],
      // Neutralize the fixture's fire-department defaults so no lane matches.
      funding_need_summary: 'General operating support.',
      grantflow_fit_summary: 'General funders.',
      recommended_outreach_angle: 'general support',
      suggested_persona: 'director',
    })
    const r = await composeEmailFromLead(lead, { config: getJohnConfig() })
    assert.equal(r.personalization.funding_lane, null)
    assert.doesNotMatch(r.body_text, /usually funded through/)
    assert.match(r.body_text, /grants, foundation programs/)
    assert.match(r.body_text, /Quiet Creek Fund/)
  } finally {
    restore()
  }
})
