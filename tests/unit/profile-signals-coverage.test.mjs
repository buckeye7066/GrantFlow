import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProfileSignals } from '../../backend/services/profileHelpers.js'
import { CANONICAL_SECTION_DEFAULTS } from '../../backend/prompts/profileSections.js'

test('profile signals: comprehensive_application data points become match keywords (PII filtered)', () => {
  const sections = {
    // Minimal required sections (can be empty)
    ...Object.fromEntries(
      Object.entries(CANONICAL_SECTION_DEFAULTS).map(([k, v]) => [k, v]),
    ),
    comprehensive_application: {
      ...CANONICAL_SECTION_DEFAULTS.comprehensive_application,
      stem_student: true,
      extracurricular_activities: ['Volleyball', 'Community Service'],
      advocacy_work: true,
      tenncare_id: 'ABC123456',
      email: ['person@example.com'],
    },
  }

  const signals = buildProfileSignals({
    profile: { display_name: 'Test Profile', primary_type: 'college_student', tags: [], interests: [] },
    sections,
  })

  const keywords = signals.keywordSet
  assert.ok(keywords.has('stem student'), 'expected boolean key name to become keyword')
  assert.ok(keywords.has('volleyball'), 'expected array string value to become keyword')
  assert.ok(keywords.has('community service'), 'expected array string value to become keyword')
  assert.ok(keywords.has('advocacy work'), 'expected boolean key name to become keyword')

  // PII/identifier values should NOT be added as keywords.
  assert.equal(keywords.has('abc123456'), false, 'expected tenncare_id value to be filtered')
  assert.equal(keywords.has('person@example.com'), false, 'expected email value to be filtered')
})

