/**
 * Yana — Lead Pipeline orchestrator: mode gating, observe-mode safety,
 * full-cycle flow with injected adapters.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { runLarry, getLarryStatus } from '../../backend/services/larry/larryAgent.js'
import { LARRY_MODES } from '../../backend/services/larry/larryTypes.js'
import { createInMemoryDb } from './yana-leads-test-helpers.mjs'

test('refuses to run when LARRY_ENABLED=false', async () => {
  const db = createInMemoryDb()
  const result = await runLarry({
    db,
    mode: LARRY_MODES.OBSERVE,
    config: { enabled: false, mode: 'observe' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'agent_disabled')
})

test('observe mode does not invoke any adapter', async () => {
  const db = createInMemoryDb()
  let adapterCalled = false
  const result = await runLarry({
    db,
    mode: LARRY_MODES.OBSERVE,
    options: {
      searchAdapter: () => {
        adapterCalled = true
        return { records: [] }
      },
    },
    config: {
      enabled: true,
      mode: 'observe',
      maxProspectsPerRun: 50,
      maxVerifiesPerRun: 50,
      maxLeadsPerRun: 50,
      maxOutreachDraftsPerRun: 50,
      maxOutreachSendsPerDay: 50,
      requireApprovalToSend: true,
      allowLiveWeb: false,
      autoSendOutreach: false,
      rateLimitPerDomainPerHour: 100,
      persistProspects: true,
      timeoutMs: 1000,
    },
  })
  assert.equal(result.ok, true)
  assert.equal(adapterCalled, false, 'observe must NOT call adapters')
})

test('discover-prospects + verify + score + qualify + draft happy path', async () => {
  const db = createInMemoryDb()

  const records = [
    {
      organization_name: 'Athens VFD',
      organization_type: 'volunteer_fire_department',
      applicant_type: 'volunteer_fire_department',
      city: 'Athens',
      state: 'TN',
      website_url: 'https://athensvfd.org',
      primary_contact_email: 'chief@athensvfd.org',
      primary_contact_name: 'Chief Smith',
      primary_contact_role: 'Fire Chief',
      ein: '123456789',
      programs: ['turnout gear replacement'],
      signals: { recent_grant_history: '2024 AFG award', active_capital_campaign: 'station expansion' },
    },
  ]

  const config = {
    enabled: true,
    mode: 'full-cycle',
    maxProspectsPerRun: 50,
    maxVerifiesPerRun: 50,
    maxLeadsPerRun: 50,
    maxOutreachDraftsPerRun: 50,
    maxOutreachSendsPerDay: 50,
    requireApprovalToSend: true,
    allowLiveWeb: true,
    autoSendOutreach: false,
    rateLimitPerDomainPerHour: 100,
    persistProspects: true,
    timeoutMs: 1000,
    fromEmail: 'team@grantflow.app',
  }

  const result = await runLarry({
    db,
    mode: LARRY_MODES.FULL_CYCLE,
    options: {
      searchAdapter: async () => ({ records }),
      webChecker: async () => ({ ok: true, status: 200 }),
    },
    config,
  })

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`)
  const summary = result.summary
  assert.ok(summary.phases.discover.candidates.length >= 1, 'discover should find ≥1')
  assert.ok(summary.phases.verify.verified.length >= 1, 'verify should mark ≥1 verified')
  assert.ok(summary.phases.score_and_packet.built.length >= 1, 'score_and_packet should build ≥1 lead')
  assert.ok(summary.phases.qualify.qualified.length >= 1, 'qualify should pass ≥1 lead')
  assert.ok(summary.phases.draft.drafts.length >= 1, 'draft should produce ≥1 attempt')

  // Send phase should NOT have any approved attempts since admin never approved.
  assert.equal(summary.phases.send.sent.length, 0)
})

test('getLarryStatus returns enabled/mode/samples without sending anything', async () => {
  const db = createInMemoryDb()
  const status = await getLarryStatus(db, {
    config: {
      enabled: true,
      mode: 'observe',
      requireApprovalToSend: true,
      allowLiveWeb: false,
      autoSendOutreach: false,
      maxOutreachSendsPerDay: 25,
    },
  })
  assert.equal(status.agent, 'Yana')
  assert.equal(status.enabled, true)
  assert.equal(typeof status.samples.any_prospects, 'boolean')
})
