import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalResultForProfile,
  canonicalizeOpportunityList,
} from '../../backend/services/matching/resultEnricher.js'
import { evaluateProfileSpecificGate } from '../../backend/services/matching/profileSpecificGate.js'
import { computeMatchDecision } from '../../backend/services/matchEngine.js'

const studentProfile = {
  profile: {
    id: 'student-1',
    primary_type: 'student',
    state: 'TN',
    needs: JSON.stringify(['education', 'technology_equipment', 'clothing_goods']),
  },
  sections: {
    basic_information: { state: 'TN', age: 18 },
    education: { current_level: 'high_school', intended_major: 'forensic science' },
  },
  signals: {
    needs: new Set(['education', 'technology_equipment', 'clothing_goods']),
    location: { state: 'TN' },
  },
}

function storedOsOpp(overrides) {
  return {
    id: overrides.id || overrides.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title: overrides.title,
    sponsor: overrides.sponsor || 'Example Funder',
    description: overrides.description,
    application_url: overrides.application_url || 'https://example.org/apply',
    source_url: overrides.source_url || overrides.application_url || 'https://example.org/source',
    is_national: 1,
    source: 'crawler-os',
    record_origin: 'crawler_os',
    opportunity_type: overrides.opportunity_type || null,
    opportunity_kind: overrides.opportunity_kind || null,
    type: overrides.type || null,
    categories: overrides.categories || [],
    keywords: overrides.keywords || [],
    match_score: overrides.match_score ?? 95,
    match_decision: overrides.match_decision || 'ACCEPT',
    match_reasons: overrides.match_reasons || ['stored_os_match'],
  }
}

test('profile-specific gate rejects high-scored stored crawler rows that do not fit the profile', () => {
  const badRows = [
    storedOsOpp({
      title: 'VA Health Care Benefits',
      description: 'Health care and disability benefits for veterans and active duty service members.',
      categories: ['veteran', 'medical'],
    }),
    storedOsOpp({
      title: 'SBA Small Business Startup Funding',
      description: 'Small business startup counseling and SBA funding for entrepreneurs.',
      categories: ['business', 'startup'],
    }),
    storedOsOpp({
      title: 'Cancer Patient Assistance Program',
      description: 'Prescription and treatment assistance for cancer patients.',
      categories: ['medical', 'patient_assistance'],
    }),
    storedOsOpp({
      title: 'Nursing License Reinstatement Scholarship',
      description: 'Continuing education and license reinstatement assistance for nurses.',
      categories: ['professional_development', 'nursing'],
    }),
  ]

  for (const opp of badRows) {
    const gate = evaluateProfileSpecificGate(studentProfile, opp)
    assert.equal(gate.pass, false, `${opp.title} should be rejected`)

    const result = canonicalResultForProfile(studentProfile, opp)
    assert.equal(result.display, false, `${opp.title} should not display`)
  }
})

test('profile-specific gate keeps a real student-aid crawler row without requiring unrelated optional fields', () => {
  const pell = storedOsOpp({
    title: 'Federal Pell Grant',
    sponsor: 'Federal Student Aid',
    description: 'Need-based grants for eligible undergraduate students to help pay tuition and college costs.',
    application_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    source_url: 'https://studentaid.gov/understand-aid/types/grants/pell',
    categories: ['education', 'scholarship'],
    keywords: ['fafsa', 'pell grant', 'student aid'],
  })

  const result = canonicalResultForProfile(studentProfile, pell)
  assert.equal(result.display, true, result.dropReason || 'Pell grant should display')
  assert.notEqual(result.opportunity.match_decision, 'REJECT')
})

test('canonical writer rejects Boots to Business while display preserves its persisted decision', () => {
  const robertLikeProfile = {
    profile: {
      id: 'robert-like',
      primary_type: 'student',
      state: 'TN',
      needs: JSON.stringify(['education', 'employment']),
    },
    sections: {
      basic_information: { state: 'TN', full_name: 'Demo College Student Persona' },
      education: { current_level: 'college', field_of_study: 'paramedicine' },
      military_service: {
        is_veteran: 'no',
        veteran: false,
        active_duty: false,
        military_service: 'none',
      },
    },
    signals: {
      needs: new Set(['education', 'employment']),
      location: { state: 'TN' },
    },
  }

  const boots = storedOsOpp({
    title: 'Boots to Business entrepreneurship training',
    sponsor: 'U.S. Small Business Administration',
    description: 'Official SBA entrepreneurship training resource for transitioning service members, veterans, National Guard/Reserve members, and military spouses.',
    categories: ['military_startup', 'veteran_startup', 'startup', 'employment'],
    keywords: ['boots to business', 'veteran_startup', 'startup', 'employment'],
    match_reasons: ['veteran_startup', 'startup', 'employment'],
  })

  const gate = evaluateProfileSpecificGate(robertLikeProfile, boots)
  assert.equal(gate.pass, false)
  assert.ok(
    ['boots_to_business_without_military_entrepreneur_signal', 'demographic_veteran_focused'].includes(gate.ruleId),
    `Unexpected Boots rejection rule: ${gate.ruleId}`,
  )

  const currentDecision = computeMatchDecision(robertLikeProfile, boots, {
    profileSections: robertLikeProfile.sections,
    signals: robertLikeProfile.signals,
  })
  assert.equal(currentDecision.decision, 'REJECT')

  // The row deliberately carries a persisted ACCEPT fixture. A SELECT/display
  // path must not run the diagnostic gate as a hidden second eligibility trial;
  // the catalog rescore writer owns replacing this stale artifact.
  const result = canonicalResultForProfile(robertLikeProfile, boots)
  assert.equal(result.display, true)
  assert.equal(result.opportunity.match_decision, 'ACCEPT')
})

test('profile-specific gate keeps Boots to Business for a real veteran startup profile', () => {
  const veteranStartupProfile = {
    profile: {
      id: 'veteran-startup',
      primary_type: 'veteran_entrepreneur',
      state: 'WV',
      needs: JSON.stringify(['startup', 'business', 'equipment']),
      is_veteran: true,
    },
    sections: {
      business: { owns_business: true, business_name: 'Mountain Food Truck' },
      military_service: { is_veteran: true, branch: 'Army' },
    },
    signals: {
      needs: new Set(['startup', 'business', 'equipment']),
      location: { state: 'WV' },
    },
  }

  const boots = storedOsOpp({
    title: 'Boots to Business entrepreneurship training',
    sponsor: 'U.S. Small Business Administration',
    description: 'Official SBA entrepreneurship training resource for transitioning service members, veterans, National Guard/Reserve members, and military spouses.',
    opportunity_type: 'grant',
    categories: ['military_startup', 'veteran_startup'],
    keywords: ['boots to business', 'veteran_startup'],
    match_reasons: ['veteran_startup'],
  })

  const gate = evaluateProfileSpecificGate(veteranStartupProfile, boots)
  assert.equal(gate.pass, true, gate.reason || 'Veteran startup profile should keep Boots to Business')

  const pipelineGate = evaluateProfileSpecificGate(veteranStartupProfile, boots, { mode: 'pipeline' })
  assert.equal(pipelineGate.pass, false)
  assert.equal(pipelineGate.ruleId, 'directory_not_pipeline_grant')
})

test('canonicalizeOpportunityList filters stale OS rows before sorting and display', () => {
  const rows = [
    storedOsOpp({
      title: 'SBA Small Business Startup Funding',
      description: 'Small business startup counseling and SBA funding for entrepreneurs.',
      categories: ['business', 'startup'],
      match_score: 99,
    }),
    storedOsOpp({
      title: 'Federal Student Aid Work-Study',
      sponsor: 'Federal Student Aid',
      description: 'Federal Work-Study jobs and financial aid for eligible students.',
      application_url: 'https://studentaid.gov/understand-aid/types/work-study',
      source_url: 'https://studentaid.gov/understand-aid/types/work-study',
      categories: ['education', 'employment'],
      keywords: ['work-study', 'student aid'],
      match_score: 70,
    }),
  ]

  const { kept, dropped } = canonicalizeOpportunityList(studentProfile, rows)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].title, 'Federal Student Aid Work-Study')
  assert.equal(Object.values(dropped).reduce((sum, n) => sum + n, 0), 1)
})
