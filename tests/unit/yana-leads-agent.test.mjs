/**
 * Yana — Lead Pipeline orchestrator: mode gating, observe-mode safety,
 * full-cycle flow with injected adapters.
 *
 * CORRECTED MODEL (owner-authoritative): Yana FINDS LEADS and DRAFTS outreach;
 * she NEVER sends email. Discovery + qualify + draft run end-to-end and produce
 * drafts regardless of any switch — that is the normal, intended state, not a
 * degraded one. FULL_CYCLE stops at saved drafts and never transmits. The only
 * gated thing is the SEPARATE, human-approved send-outreach step (which is not
 * part of Yana's automated cycle).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { runYanaOutreach, getYanaOutreachStatus } from '../../backend/services/yanaOutreach/yanaOutreachAgent.js'
import { YANA_OUTREACH_MODES } from '../../backend/services/yanaOutreach/yanaOutreachTypes.js'
import { createInMemoryDb } from './yana-leads-test-helpers.mjs'

test('the SEPARATE manual SEND step is refused when its switch is off (honest reason, not "agent disabled")', async () => {
  const db = createInMemoryDb()
  // Sending is a separate human action, not Yana's job. When its switch is off
  // an explicit send request is refused with an honest `send_disabled` reason —
  // NOT a misleading "agent_disabled" that would imply Yana herself is broken.
  const send = await runYanaOutreach({
    db,
    mode: YANA_OUTREACH_MODES.SEND_OUTREACH,
    config: { enabled: false, mode: 'observe' },
  })
  assert.equal(send.ok, false)
  assert.equal(send.reason, 'send_disabled')
  assert.notEqual(send.reason, 'agent_disabled')
})

test('OBSERVE runs even when the send switch is off (discovery is always on)', async () => {
  const db = createInMemoryDb()
  // The owner asking "have Yana find leads" must never get a bare "agent
  // disabled": discovery/qualify/draft are safe and never send.
  const result = await runYanaOutreach({
    db,
    mode: YANA_OUTREACH_MODES.OBSERVE,
    config: { enabled: false, mode: 'observe' },
  })
  assert.equal(result.ok, true, `disabled OBSERVE should run read-only, got ${JSON.stringify(result)}`)
  assert.notEqual(result.reason, 'agent_disabled')
  assert.notEqual(result.reason, 'send_disabled')
  assert.ok(result.summary?.phases?.observe, 'observe phase should be present')
})

test('FULL_CYCLE discovers + drafts to completion and NEVER reaches a send phase', async () => {
  const db = createInMemoryDb()
  const records = [
    {
      organization_name: 'Athens VFD',
      organization_type: 'volunteer_fire_department',
      applicant_type: 'volunteer_fire_department',
      city: 'Athens', state: 'TN',
      website_url: 'https://athensvfd.org',
      primary_contact_email: 'chief@athensvfd.org',
      ein: '123456789',
      programs: ['turnout gear replacement'],
    },
  ]
  const result = await runYanaOutreach({
    db,
    mode: YANA_OUTREACH_MODES.FULL_CYCLE,
    options: {
      searchAdapter: async () => ({ records }),
      webChecker: async () => ({ ok: true, status: 200 }),
    },
    config: {
      // Send switch OFF — the NORMAL state. Discovery + drafting still run.
      enabled: false,
      mode: 'full-cycle',
      maxProspectsPerRun: 50, maxVerifiesPerRun: 50, maxLeadsPerRun: 50,
      maxOutreachDraftsPerRun: 50, maxOutreachSendsPerDay: 50,
      requireApprovalToSend: true, allowLiveWeb: true, autoSendOutreach: false,
      rateLimitPerDomainPerHour: 100, persistProspects: true, timeoutMs: 1000,
      fromEmail: 'team@grantflow.app',
    },
  })
  assert.equal(result.ok, true, `full-cycle should run, got ${JSON.stringify(result)}`)
  assert.notEqual(result.reason, 'agent_disabled')
  // The automated cycle stops at saved drafts: it has a draft phase and NO send
  // phase at all (send is a separate human action, never part of the cycle).
  assert.ok(result.summary.phases.draft, 'draft phase should run')
  assert.equal(result.summary.phases.send, undefined, 'FULL_CYCLE must never reach a send phase')
  // Status is honest + positive, never "agent disabled".
  assert.ok(typeof result.status_note === 'string' && result.status_note.length > 0, 'a status note should be present')
  assert.doesNotMatch(result.status_note, /disabled/i, 'status note must not imply the agent is disabled')
})

test('observe mode does not invoke any adapter', async () => {
  const db = createInMemoryDb()
  let adapterCalled = false
  const result = await runYanaOutreach({
    db,
    mode: YANA_OUTREACH_MODES.OBSERVE,
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

  const result = await runYanaOutreach({
    db,
    mode: YANA_OUTREACH_MODES.FULL_CYCLE,
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
  assert.ok(summary.phases.draft.drafts.length >= 1, 'draft should produce ≥1 draft')

  // FULL_CYCLE stops at saved drafts — there is no send phase, and a run that
  // produced drafts is a SUCCESS (positive, honest status note).
  assert.equal(summary.phases.send, undefined, 'FULL_CYCLE must not run a send phase')
  assert.match(result.status_note, /draft/i, 'a drafting run should report drafts saved for review')
})

test('getYanaOutreachStatus reports the draft-only role honestly (Yana never sends)', async () => {
  const db = createInMemoryDb()
  const status = await getYanaOutreachStatus(db, {
    config: {
      enabled: false, // send step off — the NORMAL state
      mode: 'observe',
      requireApprovalToSend: true,
      allowLiveWeb: false,
      autoSendOutreach: false,
      maxOutreachSendsPerDay: 25,
    },
  })
  assert.equal(status.agent, 'Yana')
  // Honest framing: discovery/drafting are always on; Yana never sends; only the
  // separate manual send step follows the switch.
  assert.equal(status.sends_email, false)
  assert.equal(status.discovery_and_drafting, 'always_on')
  assert.equal(status.send_step_enabled, false)
  assert.equal(typeof status.samples.any_prospects, 'boolean')
  assert.equal(typeof status.samples.any_approved_for_manual_send, 'boolean')
})
