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

