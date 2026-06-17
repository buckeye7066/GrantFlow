import test from 'node:test'
import assert from 'node:assert/strict'

import { makeQualifiedLead } from './john-test-helpers.mjs'
import {
  buildSalutation,
  interpretLead,
  selectContactPoint,
  selectEvidenceHook,
} from '../../backend/services/john/johnLeadInterpreter.js'

test('selectContactPoint picks the highest-priority valid email', () => {
  const lead = makeQualifiedLead({
    contact_points: [
      { type: 'email', value: 'info@example.org', confidence: 0.4 },
      { type: 'email', value: 'chief@example.org', name: 'Chief Allen', role: 'Fire Chief', confidence: 0.9 },
      { type: 'email', value: 'admin@example.org', confidence: 0.6 },
    ],
  })
  const r = selectContactPoint(lead)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'chief@example.org')
  assert.equal(r.role, 'Fire Chief')
  assert.equal(r.generic, false)
})

test('selectContactPoint flags generic addresses but still surfaces them when no alternative exists', () => {
  const lead = makeQualifiedLead({
    contact_points: [{ type: 'email', value: 'info@example.org', confidence: 0.6 }],
  })
  const r = selectContactPoint(lead)
  assert.equal(r.ok, true)
  assert.equal(r.email, 'info@example.org')
  assert.equal(r.generic, true)
  assert.ok(r.warnings.includes('generic_address_used'))
})

test('selectContactPoint reports failure when no valid email is present', () => {
  const lead = makeQualifiedLead({
    contact_points: [{ type: 'email', value: 'not-an-email' }],
  })
  const r = selectContactPoint(lead)
  assert.equal(r.ok, false)
})

test('selectEvidenceHook prefers items with source URLs and high specificity', () => {
  const lead = makeQualifiedLead({
    public_evidence: [
      { summary: 'general work in the community' },
      { summary: 'replacing 25-year-old SCBA gear', source_url: 'https://x', specificity: 'high' },
      'plain string evidence',
    ],
  })
  const r = selectEvidenceHook(lead)
  assert.ok(r)
  assert.equal(r.text, 'replacing 25-year-old SCBA gear')
  assert.equal(r.source, 'https://x')
})

test('buildSalutation falls back to "Hi team," when name is missing or unsafe', () => {
  assert.equal(buildSalutation(null), 'Hi team,')
  assert.equal(buildSalutation({ name: '' }), 'Hi team,')
  assert.equal(buildSalutation({ name: 'fire@vfd.org' }), 'Hi team,')
  assert.equal(buildSalutation({ name: 'Chief Allen, Fire Chief' }), 'Hi team,')
  assert.equal(buildSalutation({ name: 'Allen' }), 'Hi Allen,')
  assert.equal(buildSalutation({ name: 'Dr. Karen Smith' }), 'Hi Karen,')
})

test('interpretLead returns ok when both contact and evidence are present', () => {
  const lead = makeQualifiedLead({})
  const r = interpretLead(lead)
  assert.equal(r.ok, true)
  assert.ok(r.contact.email)
  assert.ok(r.evidence.text)
  assert.match(r.salutation, /^Hi /)
})
