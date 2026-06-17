import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  makeJohnDb,
  makeQualifiedLead,
} from './john-test-helpers.mjs'
import {
  fetchLeadsForJohn,
  registerLeadSource,
  getRegisteredLeadSource,
  NULL_LEAD_SOURCE,
} from '../../backend/services/john/johnYanaBridge.js'
import { addSuppression } from '../../backend/services/john/johnSuppressionService.js'
import { insertDraft } from '../../backend/services/john/johnRunStore.js'
import { DRAFT_STATUS } from '../../backend/services/john/johnTypes.js'

function makeSource(leads) {
  return {
    name: 'fake',
    async listQualifiedLeads() {
      return leads
    },
    async markQueuedForReview() { return { ok: true } },
  }
}

test('fetchLeadsForJohn drops unqualified leads, low-score leads, and leads with no email', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const leads = [
      makeQualifiedLead({ lead_id: 'a', qualified: false }),
      makeQualifiedLead({ lead_id: 'b', lead_score: 50 }),
      makeQualifiedLead({ lead_id: 'c', contact_points: [] }),
      makeQualifiedLead({ lead_id: 'd' }),
    ]
    const r = await fetchLeadsForJohn({ db, leadSource: makeSource(leads) })
    assert.equal(r.leads.length, 1)
    assert.equal(r.leads[0].lead_id, 'd')
    assert.ok(r.filtered_out.not_qualified_by_yana >= 1)
    assert.ok(r.filtered_out.low_lead_score >= 1)
    assert.ok(r.filtered_out.no_usable_email_contact >= 1)
  } finally {
    restore()
    db.close()
  }
})

test('fetchLeadsForJohn skips leads that already have a non-blocked draft', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    await insertDraft(db, {
      yana_lead_id: 'lead-with-draft',
      draft_status: DRAFT_STATUS.CREATED,
    })
    const leads = [
      makeQualifiedLead({ lead_id: 'lead-with-draft' }),
      makeQualifiedLead({ lead_id: 'fresh-lead' }),
    ]
    const r = await fetchLeadsForJohn({ db, leadSource: makeSource(leads) })
    assert.equal(r.leads.length, 1)
    assert.equal(r.leads[0].lead_id, 'fresh-lead')
    assert.ok(r.filtered_out.already_drafted >= 1)
  } finally {
    restore()
    db.close()
  }
})

test('fetchLeadsForJohn drops suppressed organizations', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    await addSuppression(db, { type: 'organization', value: 'Riverbend Volunteer Fire Department' })
    const r = await fetchLeadsForJohn({
      db,
      leadSource: makeSource([makeQualifiedLead({ lead_id: 'a' })]),
    })
    assert.equal(r.leads.length, 0)
    assert.ok(r.filtered_out.organization_suppressed >= 1)
  } finally {
    restore()
    db.close()
  }
})

test('fetchLeadsForJohn sorts by lead_score desc, then urgency, then contact_confidence', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const leads = [
      makeQualifiedLead({ lead_id: 'low', lead_score: 71, urgency_score: 50, contact_confidence: 0.9 }),
      makeQualifiedLead({ lead_id: 'high', lead_score: 95, urgency_score: 90, contact_confidence: 0.5 }),
      makeQualifiedLead({ lead_id: 'mid', lead_score: 80, urgency_score: 30, contact_confidence: 0.8 }),
    ]
    const r = await fetchLeadsForJohn({ db, leadSource: makeSource(leads) })
    const ids = r.leads.map((l) => l.lead_id)
    assert.deepEqual(ids, ['high', 'mid', 'low'])
  } finally {
    restore()
    db.close()
  }
})

test('registerLeadSource updates the global source; default is the null source', () => {
  assert.equal(getRegisteredLeadSource(), NULL_LEAD_SOURCE)
  const fake = makeSource([])
  registerLeadSource(fake)
  assert.equal(getRegisteredLeadSource(), fake)
  registerLeadSource(NULL_LEAD_SOURCE) // reset
})

test('registerLeadSource rejects sources without listQualifiedLeads', () => {
  assert.throws(() => registerLeadSource({}))
})

test('NULL_LEAD_SOURCE returns no leads — John has no work to do until Yana wires in', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const r = await fetchLeadsForJohn({ db, leadSource: NULL_LEAD_SOURCE })
    assert.equal(r.leads.length, 0)
    assert.equal(r.considered, 0)
  } finally {
    restore()
    db.close()
  }
})
