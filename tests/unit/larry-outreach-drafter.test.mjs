/**
 * Larry — outreach drafter + draft quality gate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { draftEmail, inspectDraftQuality } from '../../backend/services/larry/larryOutreachDrafter.js'

function packetFor(overrides = {}) {
  return {
    id: 'lead-1',
    prospect_candidate_id: 'p-1',
    recommended_pitch: 'Athens VFD has an active capital campaign that GrantFlow can support.',
    packet_json: {
      organization_name: 'Athens Volunteer Fire Department',
      primary_contact: { name: 'Chief Smith', email: 'chief@athensvfd.org' },
      scoring: {
        fit_reasons: [{ code: 'known_grant_seeker_type', detail: 'volunteer fire department' }],
        urgency_reasons: [{ code: 'active_capital_campaign', detail: 'station expansion' }],
      },
      ...overrides,
    },
  }
}

test('draftEmail produces subject + html + text with the org name and a STOP line', () => {
  const draft = draftEmail(packetFor())
  assert.ok(draft.draft_subject.includes('Athens Volunteer Fire Department'))
  assert.ok(draft.draft_text.includes('Chief'))
  assert.ok(/reply with "STOP"/i.test(draft.draft_text))
  assert.ok(draft.draft_body.startsWith('<!doctype html>'))
})

test('draftEmail truncates long bodies', () => {
  const draft = draftEmail(packetFor({ recommended_pitch: 'x'.repeat(5000) }))
  assert.ok(draft.draft_text.length <= 1800)
})

test('inspectDraftQuality flags placeholders and short drafts', () => {
  const tooShort = inspectDraftQuality({
    draft_subject: 'Hi',
    draft_text: 'Hello {{name}}',
  })
  assert.equal(tooShort.ok, false)
  assert.ok(tooShort.issues.some((i) => /placeholder/.test(i)))
  assert.ok(tooShort.issues.some((i) => /draft_too_short/.test(i)))
})

test('inspectDraftQuality passes a healthy draft', () => {
  const draft = draftEmail(packetFor())
  const quality = inspectDraftQuality(draft)
  assert.equal(quality.ok, true, `expected ok, got: ${JSON.stringify(quality.issues)}`)
})
