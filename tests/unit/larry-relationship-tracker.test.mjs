/**
 * Larry — relationship tracker + DNC + suppression list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  recordContactedRelationship,
  recordRepliedRelationship,
  markDoNotContact,
  isCooledOff,
} from '../../backend/services/larry/larryRelationshipTracker.js'
import { upsertProspectCandidate, getRelationship, findSuppressionsForProspect } from '../../backend/services/larry/larryRunStore.js'
import { createInMemoryDb } from './larry-test-helpers.mjs'

test('contacted bumps contact_count and sets cooldown_until in the future', async () => {
  const db = createInMemoryDb()
  const prospect = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    primary_contact_email: 'chief@athensvfd.org',
  })
  const rel = await recordContactedRelationship({ db, prospectCandidateId: prospect.id })
  assert.equal(rel.relationship_state, 'contacted')
  assert.equal(rel.contact_count, 1)
  const cooldown = new Date(rel.cooldown_until).getTime()
  assert.ok(cooldown > Date.now(), 'cooldown should be in the future')
})

test('replied with classification=declined sets DNC', async () => {
  const db = createInMemoryDb()
  const prospect = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    primary_contact_email: 'chief@athensvfd.org',
  })
  const rel = await recordRepliedRelationship({
    db,
    prospectCandidateId: prospect.id,
    classification: 'declined',
  })
  assert.equal(rel.relationship_state, 'declined')
  assert.equal(rel.do_not_contact, 1)
})

test('markDoNotContact persists DNC + adds suppression entries', async () => {
  const db = createInMemoryDb()
  const prospect = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    primary_contact_email: 'chief@athensvfd.org',
    primary_contact_phone: '423-555-1234',
    ein: '12-3456789',
  })

  const rel = await markDoNotContact({ db, prospect, reason: 'admin_test' })
  assert.equal(rel.do_not_contact, 1)
  assert.equal(rel.relationship_state, 'do_not_contact')

  const hits = await findSuppressionsForProspect(db, prospect)
  assert.ok(hits.length >= 3, `expected ≥3 suppression entries, got ${hits.length}`)
  const types = hits.map((h) => h.identifier_type)
  assert.ok(types.includes('email'))
  assert.ok(types.includes('domain'))
  assert.ok(types.includes('organization'))
})

test('isCooledOff: future cooldown → true; past or null → false', async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  assert.equal(await isCooledOff({ cooldown_until: future }), true)
  assert.equal(await isCooledOff({ cooldown_until: past }), false)
  assert.equal(await isCooledOff({}), false)
})

test('relationship row is unique per prospect (UNIQUE constraint round-trip)', async () => {
  const db = createInMemoryDb()
  const prospect = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    primary_contact_email: 'chief@athensvfd.org',
  })
  await recordContactedRelationship({ db, prospectCandidateId: prospect.id })
  await recordContactedRelationship({ db, prospectCandidateId: prospect.id })
  const rel = await getRelationship(db, prospect.id)
  assert.equal(rel.contact_count, 2)
})
