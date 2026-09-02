import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  buildAnyaProfileSnapshot,
  serializeAnyaApplicationContext,
} from '../../backend/services/anyaProfileVisibility.js'

const orchestratorSource = fs.readFileSync(
  new URL('../../backend/services/anyaOrchestrator.js', import.meta.url),
  'utf8',
)
const registrySource = fs.readFileSync(
  new URL('../../backend/services/anyaToolRegistry.js', import.meta.url),
  'utf8',
)

const context = {
  profile: {
    id: 'profile-secret-id',
    user_id: 'user-secret-id',
    display_name: 'Demo Applicant',
    primary_type: 'individual',
    min_match_score: 7,
  },
  organization: {
    name: 'Demo Organization',
    ein: '12-3456789',
  },
  signals: {
    needs: new Set(['transportation', 'medical equipment']),
    location: { state: 'OH', zip: '44039' },
  },
  sections: {
    basic_information: {
      age: 42,
      has_dependents: false,
      phone: '555-0100',
      ssn: '123-45-6789',
    },
    financial_information: {
      household_income: 0,
      item_needs: ['15 passenger bus'],
      bank_account_number: '987654321',
    },
    medical_history: {
      dme_needed: ['shower chair', 'portable oxygen concentrator'],
      medicaid_id: 'M-123',
    },
  },
  documents: [
    {
      title: 'Equipment quote',
      processing_status: 'parsed',
      extracted_text: 'very large extracted text must not be preloaded',
      summary: 'Quote for an accessible vehicle',
    },
  ],
}

test('Anya profile snapshot contains real non-empty facts from every section', () => {
  const snapshot = buildAnyaProfileSnapshot(context)
  assert.equal(snapshot.profile.display_name, 'Demo Applicant')
  assert.equal(snapshot.profile.min_match_score, 7)
  assert.equal(snapshot.profile.id, undefined)
  assert.equal(snapshot.profile.user_id, undefined)
  assert.deepEqual(snapshot.matching_signals.needs, ['transportation', 'medical equipment'])
  assert.equal(snapshot.sections.basic_information.age, 42)
  assert.equal(snapshot.sections.basic_information.has_dependents, false)
  assert.equal(snapshot.sections.financial_information.household_income, 0)
  assert.deepEqual(snapshot.sections.financial_information.item_needs, ['15 passenger bus'])
  assert.deepEqual(snapshot.sections.medical_history.dme_needed, ['shower chair', 'portable oxygen concentrator'])
  assert.equal(snapshot.complete, true)
  assert.ok(snapshot.fact_count >= 10)
})

test('Anya profile snapshot redacts credentials and omits document/binary bodies', () => {
  const snapshot = buildAnyaProfileSnapshot(context)
  assert.equal(snapshot.sections.basic_information.ssn, '[redacted: value is on file]')
  assert.equal(snapshot.sections.financial_information.bank_account_number, '[redacted: value is on file]')
  assert.equal(snapshot.sections.medical_history.medicaid_id, '[redacted: value is on file]')
  assert.equal(snapshot.organization.ein, '[redacted: value is on file]')
  assert.equal(snapshot.documents[0].summary, 'Quote for an accessible vehicle')
  assert.equal(snapshot.documents[0].extracted_text, undefined)
  assert.ok(snapshot.redacted_fields.includes('sections.basic_information.ssn'))
})

test('targeted section reads recover a section omitted by the bounded preload', () => {
  const large = {
    ...context,
    sections: {
      ...context.sections,
      narrative: { essay: 'x'.repeat(7000) },
      programs_services: { program_description: 'y'.repeat(7000) },
    },
  }
  const bounded = buildAnyaProfileSnapshot(large, { maxChars: 4000 })
  assert.ok(bounded.truncated_sections.length > 0)
  assert.equal(bounded.complete, false)

  const targeted = buildAnyaProfileSnapshot(large, {
    sectionKeys: ['programs_services'],
    maxChars: 20000,
  })
  assert.equal(targeted.sections.programs_services.program_description.length, 7000)
  assert.deepEqual(targeted.truncated_sections, [])
  assert.equal(targeted.complete, true)
})

test('unknown requested sections are named instead of silently disappearing', () => {
  const snapshot = buildAnyaProfileSnapshot(context, { sectionKeys: ['not_a_section'] })
  assert.deepEqual(snapshot.unknown_requested_sections, ['not_a_section'])
  assert.equal(snapshot.complete, false)
})

test('application context stays valid JSON and preserves canonical profile facts', () => {
  const snapshot = buildAnyaProfileSnapshot(context)
  const serialized = serializeAnyaApplicationContext({
    current_user: { display_name: 'Owner', is_admin: true },
    active_profile: snapshot,
    current_page: {
      name: 'Profile',
      guidance: 'Help with this profile.',
      snapshot: { transient: 'z'.repeat(50000) },
    },
  })
  const parsed = JSON.parse(serialized)
  assert.deepEqual(parsed.active_profile.sections.medical_history.dme_needed, [
    'shower chair',
    'portable oxygen concentrator',
  ])
  assert.equal(parsed.current_page.snapshot, null)
  assert.equal(parsed.current_page.snapshot_omitted_for_context_budget, true)
})

test('large derived signals cannot crowd profile sections out of the preload', () => {
  const snapshot = buildAnyaProfileSnapshot({
    profile: { display_name: 'Large Signal Profile', primary_type: 'disabled_adult' },
    signals: { keywordSet: new Set(Array.from({ length: 700 }, (_, index) => `signal-${index}-${'x'.repeat(30)}`)) },
    sections: {
      medical: { durable_medical_equipment: 'power wheelchair and transfer lift' },
      transportation: { requested_vehicle: 'wheelchair-accessible van' },
    },
  }, { maxChars: 5000 })

  assert.equal(snapshot.profile.display_name, 'Large Signal Profile')
  assert.equal(snapshot.sections.medical.durable_medical_equipment, 'power wheelchair and transfer lift')
  assert.equal(snapshot.sections.transportation.requested_vehicle, 'wheelchair-accessible van')
  assert.equal(snapshot.matching_signals, null)
  assert.ok(snapshot.truncated_components.includes('matching_signals'))
  assert.ok(JSON.stringify(snapshot).length <= 5000)
})

test('Anya chat and the explicit tool share the canonical access-scoped snapshot', () => {
  assert.match(
    orchestratorSource,
    /const activeProfileId = resolveAnyaActiveProfileId[\s\S]{0,800}?await loadAnyaProfileSnapshot/,
  )
  assert.doesNotMatch(
    orchestratorSource,
    /SELECT id, display_name, primary_type, state, organization_type, categories FROM profiles/,
  )
  assert.match(orchestratorSource, /await getProfilePreferredLanguageAsync\(db, activeProfileId\)/)
  assert.match(orchestratorSource, /\['profile\.getSnapshot'/)
  assert.match(orchestratorSource, /serializeAnyaApplicationContext\(applicationContext\)/)
  assert.doesNotMatch(orchestratorSource, /serialized\.slice\(0, 11_900\)/)

  assert.match(registrySource, /name: 'profile\.getSnapshot'/)
  assert.match(
    registrySource,
    /profile\.getSnapshot'[\s\S]{0,1800}?ensureProfileAccess\(ctx, profileId\)[\s\S]{0,800}?loadAnyaProfileSnapshot/,
  )
})
