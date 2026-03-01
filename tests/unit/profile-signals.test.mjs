import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProfileSignals } from '../../backend/services/profileHelpers.js'

test('profile signals: includes keywords from comprehensive application data points', () => {
  const signals = buildProfileSignals({
    profile: {
      id: 'profile-test',
      primary_type: 'individual_need',
      display_name: 'Jane Doe',
    },
    sections: {
      financial_information: { unemployed: true, displaced_worker: true, low_income: true },
      government_assistance: { snap_recipient: true, ssi_recipient: true, medicaid_enrolled: true },
      health_medical: { dialysis_patient: true, hiv_aids: true, amputee: true, substance_recovery: true },
      demographics: { native_american: true, tribal_affiliation: 'Cherokee', lgbtq: true },
      family_life: { widow_widower: true, formerly_incarcerated: true, domestic_violence_survivor: true },
      occupation: { healthcare_worker: true, healthcare_worker_type: 'RN' },
      location_focus: { appalachian_region: true, rural_resident: true },
      narrative: { target_population: 'rural veterans', primary_goal: 'housing stability' },
    },
  })

  assert.ok(Array.isArray(signals.keywords), 'expected signals.keywords array')
  const kws = new Set(signals.keywords)

  // Assistance flags -> tokens/synonyms
  assert.ok(kws.has('snap') || kws.has('food') || kws.has('stamps'), 'expected SNAP tokens')
  assert.ok(kws.has('ssi') || kws.has('supplemental'), 'expected SSI tokens')
  assert.ok(kws.has('medicaid'), 'expected medicaid token')

  // Health flags
  assert.ok(kws.has('dialysis') || kws.has('kidney'), 'expected dialysis tokens')
  assert.ok(kws.has('hiv') || kws.has('aids'), 'expected HIV/AIDS tokens')
  assert.ok(kws.has('amputee') || kws.has('prosthetic'), 'expected amputee tokens')
  assert.ok(kws.has('recovery') || kws.has('sober'), 'expected recovery tokens')

  // Demographics + tribal affiliation
  assert.ok(kws.has('indigenous') || kws.has('tribal') || kws.has('native'), 'expected Native/tribal tokens')
  assert.ok(kws.has('cherokee'), 'expected tribal affiliation token')

  // Family life
  assert.ok(kws.has('widow') || kws.has('widower'), 'expected widowed tokens')
  assert.ok(kws.has('incarcerated'), 'expected formerly incarcerated token')
  assert.ok(kws.has('domestic') || kws.has('violence'), 'expected domestic violence tokens')

  // Occupation
  assert.ok(kws.has('healthcare') || kws.has('worker'), 'expected healthcare worker tokens')
  assert.ok(kws.has('rn'), 'expected healthcare worker type token')

  // Location focus
  assert.ok(kws.has('appalachia') || kws.has('appalachian'), 'expected appalachia tokens')
  assert.ok(kws.has('rural'), 'expected rural token')

  // Narrative keywords
  assert.ok(kws.has('veterans') || kws.has('veteran'), 'expected target population tokens')
  assert.ok(kws.has('housing') || kws.has('stability'), 'expected primary goal tokens')
})

test('profile signals: medical_insurance section feeds assistance and keyword signals', () => {
  const signals = buildProfileSignals({
    profile: { id: 'test', primary_type: 'individual_need', display_name: 'Test' },
    sections: {
      medical_insurance: {
        insurance_provider: 'BlueCross',
        plan_type: 'Medicaid',
        notes: 'Coverage gap for DME items',
      },
    },
  })
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('medicaid'), 'plan_type=Medicaid should register medicaid keyword')
  assert.ok(signals.assistance.has('medicaid'), 'plan_type=Medicaid should add medicaid to assistance set')
  assert.ok(kws.has('bluecross'), 'insurance_provider should register as keyword')
})

test('profile signals: medical_history section feeds health signals', () => {
  const signals = buildProfileSignals({
    profile: { id: 'test', primary_type: 'individual_need', display_name: 'Test' },
    sections: {
      medical_history: {
        primary_condition: 'Multiple Sclerosis',
        secondary_conditions: ['Chronic Fatigue', 'Neuropathy'],
        mobility_needs: 'wheelchair',
        dme_needed: ['shower chair', 'hospital bed'],
      },
    },
  })
  assert.ok(signals.health.has('multiple sclerosis'), 'primary_condition should be in healthSet')
  assert.ok(signals.health.has('chronic fatigue'), 'secondary_conditions should be in healthSet')
  assert.ok(signals.health.has('mobility_needs'), 'mobility_needs should flag in healthSet')
  assert.ok(signals.health.has('dme'), 'dme_needed should flag dme in healthSet')
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('shower chair') || kws.has('hospital bed'), 'DME items should be keywords')
  assert.ok(kws.has('durable medical equipment'), 'dme_needed should register DME keyword')
})

test('profile signals: nonprofit_compliance section feeds applicantTypes and keywords', () => {
  const signals = buildProfileSignals({
    profile: { id: 'test', primary_type: 'organization', display_name: 'Test Org' },
    sections: {
      nonprofit_compliance: {
        is_501c3: true,
        sam_registered: true,
        fiscal_sponsor: true,
        fiscal_sponsor_name: 'Community Foundation of Greater Chattanooga',
      },
    },
  })
  assert.ok(signals.applicantTypes.has('501c3'), 'is_501c3 should add 501c3 to applicantTypes')
  assert.ok(signals.applicantTypes.has('sam_registered'), 'sam_registered should add to applicantTypes')
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('501c3'), 'is_501c3 should register 501c3 keyword')
  assert.ok(kws.has('sam registered') || kws.has('sam.gov'), 'sam_registered should register keyword')
  assert.ok(kws.has('fiscal sponsor'), 'fiscal_sponsor should register keyword')
})

test('profile signals: employment section feeds occupation/assistance signals', () => {
  const signals = buildProfileSignals({
    profile: { id: 'test', primary_type: 'individual_need', display_name: 'Test' },
    sections: {
      employment: {
        current_status: 'unemployed',
        career_goal: 'become a licensed electrician',
      },
    },
  })
  assert.ok(signals.assistance.has('unemployed'), 'unemployed status should add to assistance set')
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('job seeker') || kws.has('workforce development'), 'unemployed should register job seeker keyword')
  assert.ok(signals.intentPhrases.has('become a licensed electrician'), 'career_goal should register as intent phrase')
})

test('profile signals: housing section feeds assistance and demographic signals', () => {
  const signals = buildProfileSignals({
    profile: { id: 'test', primary_type: 'individual_need', display_name: 'Test' },
    sections: {
      housing: {
        status: 'at-risk',
        broadband_speed: 'no service',
        geographic_designation: ['rural', 'frontier'],
      },
    },
  })
  assert.ok(signals.assistance.has('housing_at_risk'), 'at-risk housing should add housing_at_risk to assistance')
  assert.ok(signals.assistance.has('digital_divide'), 'no broadband should add digital_divide to assistance')
  assert.ok(signals.demographics.has('rural'), 'geographic_designation rural should add to demographics')
  assert.ok(signals.demographics.has('frontier'), 'geographic_designation frontier should add to demographics')
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('broadband access') || kws.has('digital divide'), 'no broadband should register digital divide keywords')
})

test('profile signals: family (household) section feeds financial and family signals', () => {
  const signals = buildProfileSignals({
    profile: { id: 'test', primary_type: 'individual_need', display_name: 'Test' },
    sections: {
      family: {
        household_size: 6,
        responsibilities: 'Primary caregiver for elderly parent',
      },
    },
  })
  assert.ok(signals.financial.householdSize === 6, 'household_size should set financial.householdSize')
  assert.ok(signals.family.has('caregiver'), 'caregiving responsibilities should add caregiver to family set')
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('large household'), 'household_size >= 5 should register large household keyword')
})

test('profile signals: every schema section produces at least one keyword when populated', () => {
  // Guard test: ensures no schema section is silently ignored by buildProfileSignals.
  const sectionData = {
    basic_information: { gender: 'female', age: 25 },
    organization_details: { organization_type: 'nonprofit', mission: 'serve the community' },
    financial_information: { household_income: 30000, low_income: true },
    government_assistance: { snap_recipient: true },
    health_medical: { chronic_illness: true },
    medical_insurance: { plan_type: 'Medicaid' },
    medical_history: { primary_condition: 'Diabetes' },
    nonprofit_compliance: { is_501c3: true },
    small_business_details: { business_name: 'Test LLC', naics_code: '722330' },
    demographics: { african_american: true },
    family_life: { single_parent: true },
    military_service: { veteran: true },
    occupation: { healthcare_worker: true },
    location_focus: { rural_resident: true },
    university_applications: { applications: [{ name: 'UTK', intended_major: 'Biology' }] },
    education: { field_of_study: 'Engineering' },
    employment: { current_status: 'part-time', career_goal: 'nursing degree' },
    housing: { status: 'stable', broadband_speed: 'none' },
    family: { household_size: 4, responsibilities: 'childcare' },
    programs_services: { keywords: ['mental health'], focus_areas: ['youth services'] },
    narrative: { primary_goal: 'expand outreach' },
  }

  const baseProfile = { id: 'guard-test', primary_type: 'individual_need', display_name: 'Guard Test' }

  for (const [sectionKey, data] of Object.entries(sectionData)) {
    const signals = buildProfileSignals({
      profile: baseProfile,
      sections: { [sectionKey]: data },
    })

    const keywordCount = signals.keywordSet?.size ?? 0
    const totalSignals =
      keywordCount +
      (signals.demographics?.size ?? 0) +
      (signals.health?.size ?? 0) +
      (signals.assistance?.size ?? 0) +
      (signals.military?.size ?? 0) +
      (signals.family?.size ?? 0) +
      (signals.occupation?.size ?? 0) +
      (signals.applicantTypes?.size ?? 0) +
      (signals.interests?.size ?? 0)

    assert.ok(
      totalSignals > 0,
      `Section "${sectionKey}" produced 0 signals — buildProfileSignals is not processing it. ` +
        'Add extraction logic to profileHelpers.js.',
    )
  }
})

