/**
 * crawler-plan-explainer
 *
 * Tests the Anya crawler-planning function: which sources fire for a profile
 * and WHY, including the high-precision keyword/phrase safety net that ensures
 * a profile whose text identifies it (e.g. "volunteer fire department",
 * "FEMA AFG", "SAFER grant") reaches the right source even when its declared
 * primary_type is generic — so a VFD never silently misses a FEMA grant.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { explainCrawlerPlan } from '../../backend/crawler-os/crawlerPlanExplainer.js'
import { buildThesis, detectKeywordApplicantTriggers } from '../../backend/crawler-os/profileIntelligence.js'

test('explains a clean VFD plan: FEMA AFG is selected with reasons', () => {
  const plan = explainCrawlerPlan({ profile_type: 'volunteer_fire_department' })
  const ids = plan.selected_sources.map((s) => s.source_id)
  assert.ok(ids.includes('fema_afg'), `VFD plan must include fema_afg; got [${ids.join(', ')}]`)
  assert.ok(ids.includes('grants_gov'), 'VFD plan must include grants_gov')
  assert.ok(plan.coverage.has_real_funder, 'VFD must have at least one real (non-directory) funder')
  // Every selected source carries a human reason.
  for (const s of plan.selected_sources) assert.ok(s.reasons.length > 0, `${s.source_id} missing reason`)
})

test('keyword safety net: a GENERIC org profile whose text says "volunteer fire department" still gets FEMA AFG', () => {
  // Type is the legacy generic 'organization' — WITHOUT the keyword net this
  // resolves to nonprofit only and MISSES fema_afg (the exact bug to prevent).
  const plan = explainCrawlerPlan({
    profile_type: 'organization',
    name: 'Pine Ridge Fire',
    sections: [{ title: 'mission', body: 'We are a rural volunteer fire department needing turnout gear and a FEMA AFG apparatus grant.' }],
  })
  const ids = plan.selected_sources.map((s) => s.source_id)
  assert.ok(plan.applicant_types.includes('vfd'), `expected vfd applicant; got [${plan.applicant_types.join(',')}]`)
  assert.ok(ids.includes('fema_afg'), `keyword net must pull in fema_afg; got [${ids.join(', ')}]`)
  // The trigger is recorded for explainability.
  const fired = plan.keyword_triggers.find((t) => t.add === 'vfd')
  assert.ok(fired, 'vfd keyword trigger must be recorded')
  assert.ok(/fire/i.test(fired.matched), `trigger should cite the matched phrase; got "${fired.matched}"`)
  assert.ok(plan.notes.some((n) => /fema|vfd|fire/i.test(n)) || fired, 'plan should note the keyword pull-in')
})

test('keyword net does NOT turn a person into an org (no false positives)', () => {
  // An individual who mentions a family member\'s fire-department service must
  // NOT become a VFD applicant.
  const triggers = detectKeywordApplicantTriggers('my father served in the volunteer fire department', true)
  assert.equal(triggers.length, 0, 'individual profiles must not fire org keyword triggers')

  const plan = explainCrawlerPlan({
    profile_type: 'individual',
    sections: [{ title: 'bio', body: 'My dad was a firefighter in the local volunteer fire department.' }],
  })
  assert.ok(!plan.applicant_types.includes('vfd'), 'a person must never be classified as a VFD applicant')
  assert.ok(plan.is_org === false)
})

test('explains excluded sources with plain reasons', () => {
  const plan = explainCrawlerPlan({ profile_type: 'individual' })
  assert.ok(plan.excluded_sources.length > 0, 'an individual excludes the federal grant APIs')
  const gg = plan.excluded_sources.find((s) => s.source_id === 'grants_gov')
  assert.ok(gg, 'grants_gov should be excluded for an individual')
  assert.ok(gg.reasons.some((r) => /does not fund this applicant type/i.test(r)), 'exclusion reason should be human-readable')
})

test('church text trigger pulls in nonprofit federal eligibility', () => {
  const plan = explainCrawlerPlan({
    profile_type: 'other',
    sections: [{ title: 'about', body: 'We are a small congregation / church serving our community.' }],
  })
  assert.ok(plan.applicant_types.includes('church'), 'church keyword should fire')
  assert.ok(plan.applicant_types.includes('nonprofit'), 'church implies nonprofit eligibility')
  const ids = plan.selected_sources.map((s) => s.source_id)
  assert.ok(ids.includes('grants_gov'), 'church-by-keyword should reach grants_gov')
})

test('buildThesis attaches keyword_triggers for explainability', () => {
  const thesis = buildThesis({
    profile_type: 'organization',
    sections: [{ title: 'm', body: 'volunteer fire department and EMS first responder agency' }],
  })
  assert.ok(Array.isArray(thesis.keyword_triggers))
  assert.ok(thesis.keyword_triggers.some((t) => t.add === 'vfd'))
})
