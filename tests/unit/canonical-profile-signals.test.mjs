import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCanonicalSignals,
  fromLegacyHelpers,
  fromNormalizer,
  fromAnalysisShape,
  emptyCanonicalSignals,
} from '../../backend/services/profile/canonicalSignals.js'

// ── emptyCanonicalSignals ────────────────────────────────────────────────────

test('emptyCanonicalSignals: returns correct zero-signal baseline', () => {
  const s = emptyCanonicalSignals()
  assert.strictEqual(s.applicantType, 'individual')
  assert.ok(Array.isArray(s.applicantTypes), 'applicantTypes must be Array')
  assert.strictEqual(s.applicantTypes.length, 0)
  assert.ok(Array.isArray(s.keywords), 'keywords must be Array')
  assert.ok(Array.isArray(s.needs), 'needs must be Array')
  assert.ok(Array.isArray(s.family), 'family must be Array')
  assert.ok(Array.isArray(s.military), 'military must be Array')
  assert.strictEqual(s.location.state, null)
  assert.strictEqual(s.location.zipCode, null)
  assert.strictEqual(s.financial.annualBudget, null)
  assert.strictEqual(s.financial.requestedAmount, null)
  assert.strictEqual(s.organization.einNumber, null)
  assert.strictEqual(s.organization.orgType, null)
})

// ── fromLegacyHelpers ────────────────────────────────────────────────────────

test('fromLegacyHelpers: converts Sets to Arrays', () => {
  const legacySignals = {
    applicantType: 'individual',
    applicantTypes: new Set(['individual', 'veteran']),
    keywords: ['housing', 'food'],
    keywordSet: new Set(['housing', 'food']),
    needs: new Set(['housing', 'food']),
    family: new Set(['single_parent']),
    military: new Set(['veteran']),
    demographics: new Set(['senior']),
    health: new Set(['diabetes']),
    occupation: new Set(['unemployed']),
    immigration: new Set(['refugee']),
    geographic: new Set(['rural']),
    assistance: new Set(['snap']),
    interests: new Set(['gardening']),
    sports: new Set(['soccer']),
    phrases: new Set(['housing stability']),
    intentPhrases: new Set(['find better housing']),
    proBonoTerms: new Set(['pro bono legal']),
    location: { state: 'TN', county: 'Hamilton', city: 'Chattanooga', zip: '37402' },
    financial: { householdIncome: 25000, fundingAmountNeeded: 5000 },
    organization: { ein: '12-3456789', is501c3: true },
    education: { level: 'bachelors' },
    academics: { gpa: 3.5 },
    schools: [{ name: 'UTK' }],
    coverage: { pct: 80 },
    rawSections: { basic_information: {} },
  }

  const s = fromLegacyHelpers(legacySignals)

  // All Set fields → Arrays
  assert.ok(Array.isArray(s.applicantTypes), 'applicantTypes must be Array')
  assert.ok(Array.isArray(s.needs), 'needs must be Array')
  assert.ok(Array.isArray(s.family), 'family must be Array')
  assert.ok(Array.isArray(s.military), 'military must be Array')
  assert.ok(Array.isArray(s.demographics), 'demographics must be Array')
  assert.ok(Array.isArray(s.health), 'health must be Array')
  assert.ok(Array.isArray(s.occupation), 'occupation must be Array')
  assert.ok(Array.isArray(s.immigration), 'immigration must be Array')
  assert.ok(Array.isArray(s.geographic), 'geographic must be Array')
  assert.ok(Array.isArray(s.assistance), 'assistance must be Array')
  assert.ok(Array.isArray(s.interests), 'interests must be Array')
  assert.ok(Array.isArray(s.sports), 'sports must be Array')
  assert.ok(Array.isArray(s.phrases), 'phrases must be Array')
  assert.ok(Array.isArray(s.intentPhrases), 'intentPhrases must be Array')
  assert.ok(Array.isArray(s.proBonoTerms), 'proBonoTerms must be Array')

  // Values preserved
  assert.ok(s.applicantTypes.includes('veteran'), 'applicantTypes should include veteran')
  assert.ok(s.needs.includes('housing'), 'needs should include housing')
  assert.ok(s.family.includes('single_parent'), 'family should include single_parent')
  assert.ok(s.military.includes('veteran'), 'military should include veteran')
  assert.ok(s.keywords.includes('housing'), 'keywords preserved')
})

test('fromLegacyHelpers: normalizes location (zip → zipCode)', () => {
  const s = fromLegacyHelpers({
    location: { state: 'TN', zip: '37402', city: 'Chattanooga', county: 'Hamilton' },
  })
  assert.strictEqual(s.location.zipCode, '37402', 'zip should map to zipCode')
  assert.strictEqual(s.location.state, 'TN')
  assert.strictEqual(s.location.city, 'Chattanooga')
  assert.strictEqual(s.location.county, 'Hamilton')
  // legacy 'zip' field is not kept at top level in canonical
  assert.strictEqual(s.location.zip, undefined, 'canonical location has no zip field')
})

test('fromLegacyHelpers: normalizes financial fields (fundingAmountNeeded → requestedAmount)', () => {
  const s = fromLegacyHelpers({
    financial: {
      householdIncome: 30000,
      fundingAmountNeeded: 10000,
      householdSize: 3,
    },
  })
  assert.strictEqual(s.financial.householdIncome, 30000)
  assert.strictEqual(s.financial.requestedAmount, 10000, 'fundingAmountNeeded maps to requestedAmount')
  assert.strictEqual(s.financial.householdSize, 3)
})

test('fromLegacyHelpers: normalizes organization fields (ein → einNumber)', () => {
  const s = fromLegacyHelpers({
    organization: {
      ein: '12-3456789',
      is501c3: true,
      samRegistered: false,
      naicsCode: '722330',
    },
  })
  assert.strictEqual(s.organization.einNumber, '12-3456789', 'ein maps to einNumber')
  assert.strictEqual(s.organization.is501c3, true)
  assert.strictEqual(s.organization.naicsCode, '722330')
})

test('fromLegacyHelpers: handles null / missing signals gracefully', () => {
  assert.doesNotThrow(() => fromLegacyHelpers(null))
  assert.doesNotThrow(() => fromLegacyHelpers(undefined))
  assert.doesNotThrow(() => fromLegacyHelpers({}))

  const s = fromLegacyHelpers(null)
  assert.strictEqual(s.applicantType, 'individual')
  assert.deepStrictEqual(s.needs, [])
})

// ── fromNormalizer ────────────────────────────────────────────────────────────

test('fromNormalizer: maps normalizeProfile output to canonical shape', () => {
  const normalized = {
    entityType: 'individual',
    state: 'TN',
    zip: '37402',
    county: 'Hamilton',
    city: 'Chattanooga',
    needCategories: ['housing', 'food'],
    isVeteran: true,
    isStudent: false,
    hasChronicIllness: false,
  }

  const s = fromNormalizer(normalized)

  assert.strictEqual(s.applicantType, 'individual')
  assert.ok(s.applicantTypes.includes('individual'), 'applicantTypes includes entity type')
  assert.strictEqual(s.location.state, 'TN')
  assert.strictEqual(s.location.zipCode, '37402')
  assert.ok(s.needs.includes('housing'), 'needs includes housing')
  assert.ok(s.needs.includes('food'), 'needs includes food')
  assert.ok(s.military.includes('veteran'), 'isVeteran=true adds veteran to military')
  assert.ok(!s.demographics.includes('student'), 'isStudent=false does not add student')
})

test('fromNormalizer: maps hasChronicIllness to demographics', () => {
  const s = fromNormalizer({
    entityType: 'individual',
    needCategories: [],
    hasChronicIllness: true,
  })
  assert.ok(s.demographics.includes('disability'), 'hasChronicIllness adds disability to demographics')
})

test('fromNormalizer: handles null / missing input gracefully', () => {
  assert.doesNotThrow(() => fromNormalizer(null))
  const s = fromNormalizer(null)
  assert.strictEqual(s.applicantType, 'individual')
  assert.deepStrictEqual(s.needs, [])
})

// ── fromAnalysisShape ────────────────────────────────────────────────────────

test('fromAnalysisShape: maps income field back to financial', () => {
  const analysis = {
    applicantType: 'individual',
    income: { householdIncome: 20000 },
    needs: new Set(['utilities']),
    keywords: ['utilities'],
    family: new Set(['single_parent']),
    location: { state: 'GA', zip: '30301' },
    applicantTypes: new Set(['individual']),
  }

  const s = fromAnalysisShape(analysis)

  assert.strictEqual(s.financial.householdIncome, 20000, 'income.householdIncome maps to financial.householdIncome')
  assert.ok(s.needs.includes('utilities'), 'needs preserved')
  assert.ok(s.family.includes('single_parent'), 'family Set converted to Array')
  assert.strictEqual(s.location.zipCode, '30301', 'zip → zipCode')
})

test('fromAnalysisShape: handles null / missing input gracefully', () => {
  assert.doesNotThrow(() => fromAnalysisShape(null))
  const s = fromAnalysisShape(null)
  assert.deepStrictEqual(s.keywords, [])
})

// ── buildCanonicalSignals ────────────────────────────────────────────────────

test('buildCanonicalSignals: builds from raw profile with sections', () => {
  const rawProfile = {
    id: 'test-profile',
    primary_type: 'individual_need',
    display_name: 'Jane Test',
    state: 'TN',
  }
  const sections = {
    family_life: { single_parent: true },
    military_service: { veteran: true, branch: 'Army' },
    financial_information: { household_income: 22000 },
  }

  const s = buildCanonicalSignals(rawProfile, sections)

  // Basic structure checks
  assert.ok(typeof s.applicantType === 'string', 'applicantType is string')
  assert.ok(Array.isArray(s.applicantTypes), 'applicantTypes is Array')
  assert.ok(Array.isArray(s.keywords), 'keywords is Array')
  assert.ok(Array.isArray(s.family), 'family is Array')
  assert.ok(Array.isArray(s.military), 'military is Array')
  assert.ok(Array.isArray(s.needs), 'needs is Array')
  assert.strictEqual(typeof s.location, 'object', 'location is object')
  assert.ok('zipCode' in s.location, 'location has zipCode (canonical)')
  assert.strictEqual('zip' in s.location, false, 'location has no legacy zip key')
  assert.strictEqual(typeof s.financial, 'object', 'financial is object')
  assert.ok('annualBudget' in s.financial, 'financial has annualBudget (canonical)')
  assert.ok('requestedAmount' in s.financial, 'financial has requestedAmount (canonical)')
  assert.strictEqual(typeof s.organization, 'object', 'organization is object')
  assert.ok('orgType' in s.organization, 'organization has orgType (canonical)')
  assert.ok('einNumber' in s.organization, 'organization has einNumber (canonical)')
})

test('buildCanonicalSignals: accepts { profile, sections } envelope', () => {
  const envelope = {
    profile: { id: 'p1', primary_type: 'organization' },
    sections: { organization_details: { organization_type: 'nonprofit', ein: '99-9999999' } },
  }

  const s = buildCanonicalSignals(envelope)
  assert.ok(Array.isArray(s.applicantTypes), 'applicantTypes is Array from envelope')
})

test('buildCanonicalSignals: returns empty signals for null input', () => {
  const s = buildCanonicalSignals(null)
  assert.strictEqual(s.applicantType, 'individual')
  assert.deepStrictEqual(s.needs, [])
  assert.deepStrictEqual(s.keywords, [])
})

test('buildCanonicalSignals: no Set instances in output', () => {
  const s = buildCanonicalSignals(
    { id: 'p1', primary_type: 'individual_need' },
    {
      military_service: { veteran: true },
      demographics: { african_american: true },
      health_medical: { chronic_illness: true },
      family_life: { single_parent: true },
    },
  )

  const allFields = [
    s.applicantTypes, s.keywords, s.phrases, s.intentPhrases,
    s.demographics, s.genders, s.health, s.family, s.military,
    s.occupation, s.immigration, s.geographic, s.assistance,
    s.interests, s.sports, s.proBonoTerms, s.needs, s.schools,
  ]

  for (const field of allFields) {
    assert.ok(Array.isArray(field), `Expected Array but got ${typeof field}: ${field?.constructor?.name}`)
    assert.ok(!(field instanceof Set), 'No Set instances should appear in canonical output')
  }
})

// ── Field name consistency ────────────────────────────────────────────────────

test('canonical signals: consistent financial field names across all adapters', () => {
  const legacySignals = { financial: { fundingAmountNeeded: 7500, householdIncome: 18000 } }
  const fromHelpers = fromLegacyHelpers(legacySignals)
  assert.ok('requestedAmount' in fromHelpers.financial, 'fromLegacyHelpers has requestedAmount')
  assert.ok('annualBudget' in fromHelpers.financial, 'fromLegacyHelpers has annualBudget')
  assert.ok(!('fundingAmountNeeded' in fromHelpers.financial), 'legacy key fundingAmountNeeded not in canonical')

  const normalized = { entityType: 'individual', needCategories: [], financial: { budget: 50000 } }
  const fromNorm = fromNormalizer(normalized)
  assert.ok('annualBudget' in fromNorm.financial, 'fromNormalizer has annualBudget')
  assert.strictEqual(fromNorm.financial.annualBudget, 50000, 'budget maps to annualBudget')
})

test('canonical signals: consistent organization field names across all adapters', () => {
  const legacySignals = { organization: { ein: '12-3456789', is501c3: true } }
  const s = fromLegacyHelpers(legacySignals)
  assert.ok('einNumber' in s.organization, 'fromLegacyHelpers has einNumber')
  assert.ok(!('ein' in s.organization), 'legacy key ein not in canonical organization')

  const withOrg = fromNormalizer({
    entityType: 'organization',
    needCategories: [],
    organization: { orgType: 'nonprofit', einNumber: '98-7654321' },
  })
  assert.strictEqual(withOrg.organization.einNumber, '98-7654321', 'einNumber preserved through fromNormalizer')
  assert.ok('orgType' in withOrg.organization, 'fromNormalizer has orgType')
})

test('canonical signals: applicantTypes is always Array (never Set)', () => {
  // From legacy helpers with Set
  const s1 = fromLegacyHelpers({ applicantTypes: new Set(['individual', '501c3']) })
  assert.ok(Array.isArray(s1.applicantTypes), 'fromLegacyHelpers: applicantTypes is Array')
  assert.ok(s1.applicantTypes.includes('501c3'))

  // From normalizer (no applicantTypes field)
  const s2 = fromNormalizer({ entityType: 'organization', needCategories: [] })
  assert.ok(Array.isArray(s2.applicantTypes), 'fromNormalizer: applicantTypes is Array')

  // From analysis shape with Set
  const s3 = fromAnalysisShape({ applicantTypes: new Set(['student', 'college_student']) })
  assert.ok(Array.isArray(s3.applicantTypes), 'fromAnalysisShape: applicantTypes is Array')
})
