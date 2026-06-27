import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  applyEnv,
  makeFakeOutlookProvider,
  makeJohnDb,
  makeQualifiedLead,
} from './john-test-helpers.mjs'
import { runJohn, getJohnStatus } from '../../backend/services/john/johnAgent.js'
import { listDrafts, listRuns } from '../../backend/services/john/johnRunStore.js'
import { JOHN_MODES, RUN_STATUS } from '../../backend/services/john/johnTypes.js'

function makeSource(leads) {
  return {
    name: 'fake',
    async listQualifiedLeads() { return leads },
    async markQueuedForReview() { return { ok: true } },
  }
}

test('runJohn defaults to observe mode and never calls the provider', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const r = await runJohn({
      db,
      mode: JOHN_MODES.OBSERVE,
      provider,
      leadSource: makeSource([makeQualifiedLead({})]),
    })
    assert.equal(r.ok, true)
    assert.equal(r.status, RUN_STATUS.COMPLETED)
    assert.equal(provider.calls.length, 0, 'observe mode never calls Outlook')
    const drafts = await listDrafts(db, { limit: 10 })
    assert.equal(drafts.length, 0)
  } finally {
    restore()
    db.close()
  }
})

test('runJohn in draft mode caps drafts at maxDrafts and respects the rolling 24h limit', async () => {
  const restore = applyEnv({
    JOHN_ENABLED: 'true',
    JOHN_DRAFT_ONLY: 'true',
    JOHN_ALLOW_SEND: 'false',
    JOHN_MAX_DRAFTS_PER_24H: '5',
    JOHN_MAX_DRAFTS_PER_RUN: '5',
    JOHN_MAX_DRAFTS_PER_HOUR: '5',
    JOHN_MIN_LEAD_SCORE: '70',
    JOHN_REQUIRE_YANA_QUALIFIED: 'true',
    JOHN_REQUIRE_PUBLIC_EVIDENCE: 'true',
    JOHN_REQUIRE_CONTACT_SOURCE: 'true',
    JOHN_SUPPRESSION_ENABLED: 'true',
    JOHN_OPT_OUT_LANGUAGE_REQUIRED: 'true',
    JOHN_PHYSICAL_ADDRESS_REQUIRED: 'true',
    JOHN_PHYSICAL_ADDRESS: '123 Mission Way',
  })
  const db = makeJohnDb()
  try {
    const leads = []
    for (let i = 0; i < 8; i++) {
      leads.push(makeQualifiedLead({
        lead_id: `lead-${i}`,
        organization_name: `Org ${i}`,
        contact_points: [{ type: 'email', value: `org${i}@example-org-${i}.test`, role: 'Executive Director', confidence: 0.9 }],
      }))
    }
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const r = await runJohn({
      db,
      mode: JOHN_MODES.DRAFT,
      provider,
      leadSource: makeSource(leads),
      maxDrafts: 5,
    })
    assert.equal(r.status, RUN_STATUS.COMPLETED)
    assert.equal(r.drafts_created, 5)
    const drafts = await listDrafts(db, { limit: 100 })
    assert.equal(drafts.length, 5)
    // A second run on the same day must produce 0 more drafts.
    const r2 = await runJohn({
      db,
      mode: JOHN_MODES.DRAFT,
      provider,
      leadSource: makeSource(leads),
      maxDrafts: 5,
    })
    assert.equal(r2.status, RUN_STATUS.DAILY_LIMIT_REACHED)
    assert.equal(r2.drafts_created, 0)
  } finally {
    restore()
    db.close()
  }
})

test('runJohn refuses to send (assertDraftOnly) if an operator turns draft-only off', async () => {
  const restore = applyEnv({
    JOHN_ENABLED: 'true',
    JOHN_DRAFT_ONLY: 'false',
    JOHN_ALLOW_SEND: 'true',
  })
  const db = makeJohnDb()
  try {
    await assert.rejects(
      runJohn({ db, mode: JOHN_MODES.DRAFT }),
      (err) => err && err.code === 'JOHN_DRAFT_ONLY_REQUIRED'
    )
  } finally {
    restore()
    db.close()
  }
})

test('runJohn writes a john_runs row that records the outcome', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const r = await runJohn({
      db,
      mode: JOHN_MODES.DRAFT,
      provider,
      leadSource: makeSource([makeQualifiedLead({ lead_id: 'l1' })]),
      maxDrafts: 5,
    })
    assert.equal(r.status, RUN_STATUS.COMPLETED)
    const runs = await listRuns(db, { limit: 5 })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].mode, JOHN_MODES.DRAFT)
    assert.equal(runs[0].drafts_created, 1)
  } finally {
    restore()
    db.close()
  }
})

test('getJohnStatus returns the safety posture used by the admin console', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const status = await getJohnStatus(db)
    assert.equal(status.agent, 'John')
    assert.equal(status.draft_only, true)
    assert.equal(status.allow_send, false)
    assert.equal(status.daily_cap, 50)
    assert.equal(status.from_alias, 'GrantFlow@axiombiolabs.org')
  } finally {
    restore()
    db.close()
  }
})
