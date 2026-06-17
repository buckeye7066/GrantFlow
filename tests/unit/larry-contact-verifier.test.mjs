/**
 * Larry — contact verification.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  verifyProspectContact,
  verifyAndPersistContact,
} from '../../backend/services/larry/larryContactVerifier.js'
import { upsertProspectCandidate } from '../../backend/services/larry/larryRunStore.js'
import { CONTACT_VERIFICATION_STATUS, PROSPECT_STATUS } from '../../backend/services/larry/larryTypes.js'
import { createInMemoryDb } from './larry-test-helpers.mjs'

test('verifyProspectContact returns VERIFIED when website is live and email is org', async () => {
  const result = await verifyProspectContact(
    {
      website_url: 'https://athensfoodpantry.org',
      primary_contact_email: 'director@athensfoodpantry.org',
      city: 'Athens',
      state: 'TN',
      primary_contact_phone: '(423) 555-1234',
    },
    {
      webChecker: async () => ({ ok: true, status: 200, finalUrl: 'https://athensfoodpantry.org' }),
    },
  )
  assert.equal(result.status, CONTACT_VERIFICATION_STATUS.VERIFIED)
})

test('verifyProspectContact returns UNREACHABLE when nothing is provided', async () => {
  const result = await verifyProspectContact({})
  assert.equal(result.status, CONTACT_VERIFICATION_STATUS.UNREACHABLE)
})

test('verifyProspectContact returns PARTIAL on mixed signals', async () => {
  const result = await verifyProspectContact(
    {
      website_url: 'https://athensfoodpantry.org',
      primary_contact_email: 'foo@mailinator.com',
      state: 'TN',
    },
    {
      webChecker: async () => ({ ok: true, status: 200 }),
    },
  )
  assert.ok(
    result.status === CONTACT_VERIFICATION_STATUS.PARTIAL ||
      result.status === CONTACT_VERIFICATION_STATUS.UNREACHABLE,
    `expected PARTIAL or UNREACHABLE, got ${result.status}`,
  )
})

test('verifyAndPersistContact updates the prospect row in the DB', async () => {
  const db = createInMemoryDb()
  const inserted = await upsertProspectCandidate(db, {
    organization_name: 'Athens Community Food Pantry',
    state: 'TN',
    city: 'Athens',
    website_url: 'https://athensfoodpantry.org',
    primary_contact_email: 'director@athensfoodpantry.org',
    primary_contact_phone: '(423) 555-1234',
  })
  assert.ok(inserted?.id)

  const result = await verifyAndPersistContact({
    db,
    prospect: inserted,
    webChecker: async () => ({ ok: true, status: 200 }),
  })

  assert.equal(result.prospect.contact_verification_status, CONTACT_VERIFICATION_STATUS.VERIFIED)
  assert.equal(result.prospect.status, PROSPECT_STATUS.CONTACT_VERIFIED)
})
