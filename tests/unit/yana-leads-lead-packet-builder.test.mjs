/**
 * Yana — Lead Pipeline lead packet building + qualification.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildLeadPacket, isPacketQualified } from '../../backend/services/larry/larryLeadPacketBuilder.js'

const HEALTHY_PROSPECT = {
  id: 'p-1',
  organization_name: 'Athens Volunteer Fire Department',
  applicant_type: 'volunteer_fire_department',
  city: 'Athens',
  state: 'TN',
  website_url: 'https://athensvfd.org',
  primary_contact_email: 'chief@athensvfd.org',
  primary_contact_name: 'Chief Smith',
  primary_contact_role: 'Fire Chief',
  ein: '12-3456789',
  contact_verification_status: 'verified',
  programs_json: ['turnout gear replacement'],
  need_categories_json: ['equipment'],
  signals_json: {
    active_capital_campaign: 'station expansion',
    recent_grant_history: '2024 AFG award',
    volunteer_led: true,
  },
}

test('buildLeadPacket produces a packet with score, summary, pitch, channel', () => {
  const packet = buildLeadPacket(HEALTHY_PROSPECT)
  assert.ok(packet, 'packet should exist')
  assert.equal(packet.prospect_candidate_id, 'p-1')
  assert.ok(packet.fit_score > 0)
  assert.ok(packet.urgency_score > 0)
  assert.ok(packet.composite_score >= packet.fit_score * 0.6)
  assert.ok(packet.recommended_pitch && packet.recommended_pitch.length > 0)
  assert.equal(packet.recommended_outreach_method, 'email')
  assert.ok(packet.packet_summary.includes('Athens Volunteer Fire Department'))
})

test('buildLeadPacket prefers phone channel when no email', () => {
  const packet = buildLeadPacket({
    ...HEALTHY_PROSPECT,
    primary_contact_email: null,
    primary_contact_phone: '(555) 123-4567',
  })
  assert.equal(packet.recommended_outreach_method, 'phone')
})

test('isPacketQualified passes for a healthy packet', () => {
  const packet = buildLeadPacket(HEALTHY_PROSPECT)
  const verdict = isPacketQualified(packet)
  assert.equal(verdict.qualified, true, `expected qualified=true, reasons=${JSON.stringify(verdict.reasons)}`)
})

test('isPacketQualified blocks unverified contacts', () => {
  const packet = buildLeadPacket({ ...HEALTHY_PROSPECT, contact_verification_status: 'unverified' })
  const verdict = isPacketQualified(packet)
  assert.equal(verdict.qualified, false)
  assert.ok(verdict.reasons.some((r) => /contact verification/.test(r)))
})

test('isPacketQualified blocks low fit scores', () => {
  const packet = buildLeadPacket({
    id: 'p-2',
    organization_name: 'Sketchy Org',
    state: 'TN',
    contact_verification_status: 'verified',
  })
  const verdict = isPacketQualified(packet)
  assert.equal(verdict.qualified, false)
  assert.ok(verdict.reasons.some((r) => /fit_score/.test(r) || /composite_score/.test(r)))
})
