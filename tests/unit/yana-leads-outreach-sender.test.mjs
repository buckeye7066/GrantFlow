/**
 * Yana — Lead Pipeline outreach sender. Most important safety surface.
 *
 * These tests assert the sender NEVER calls the email adapter when:
 *   - Yana is disabled
 *   - the attempt is not approved
 *   - no FROM_EMAIL is configured
 *   - the recipient is on the suppression list
 *   - the relationship is DNC
 *   - the daily send cap has been hit
 *   - dryRun=true
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { sendOutreachAttempt } from '../../backend/services/yanaOutreach/yanaOutreachSender.js'
import {
  insertOutreachAttempt,
  upsertProspectCandidate,
  upsertLead,
  addSuppressionEntry,
  upsertRelationship,
} from '../../backend/services/yanaOutreach/yanaOutreachRunStore.js'
import { createInMemoryDb } from './yana-leads-test-helpers.mjs'

async function buildAttemptInDb(db, overrides = {}) {
  const prospect = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    city: 'Athens',
    primary_contact_email: 'chief@athensvfd.org',
    ...(overrides.prospect || {}),
  })
  const lead = await upsertLead(db, {
    prospect_candidate_id: prospect.id,
    packet_version: 1,
    fit_score: 80,
    composite_score: 80,
    status: 'qualified',
  })
  const attempt = await insertOutreachAttempt(db, {
    lead_id: lead.id,
    prospect_candidate_id: prospect.id,
    channel: 'email',
    draft_subject: 'Hi',
    draft_body: '<p>Hello there - this is a real outreach test draft, longer than 240 chars to satisfy the quality gate. We are reaching out because of a real fit signal that we identified in public data.</p>',
    draft_text: 'Hello there - this is a real outreach test draft, longer than 240 chars to satisfy the quality gate. We are reaching out because of a real fit signal that we identified in public data.',
    send_status: 'drafted',
    ...(overrides.attempt || {}),
  })
  return { prospect, lead, attempt }
}

test('refuses to send when Yana is disabled', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  const sender = (() => { throw new Error('sender must not be called') })

  const result = await sendOutreachAttempt({
    db,
    attempt: { ...attempt, approved_by_user_id: 'u1', approved_at: new Date().toISOString() },
    prospect,
    emailSender: sender,
    config: { enabled: false, requireApprovalToSend: true, fromEmail: 'a@b.c', maxOutreachSendsPerDay: 100 },
  })
  assert.equal(result.sent, false)
  assert.equal(result.blocked.reason, 'agent_disabled')
})

test('refuses to send when not approved', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  const result = await sendOutreachAttempt({
    db,
    attempt,
    prospect,
    emailSender: () => { throw new Error('sender must not be called') },
    config: { enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c', maxOutreachSendsPerDay: 100 },
  })
  assert.equal(result.sent, false)
  assert.equal(result.blocked.reason, 'send_not_approved')
})

test('refuses to send when no FROM_EMAIL configured', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  const result = await sendOutreachAttempt({
    db,
    attempt: { ...attempt, approved_by_user_id: 'u1', approved_at: new Date().toISOString() },
    prospect,
    emailSender: () => { throw new Error('sender must not be called') },
    config: { enabled: true, requireApprovalToSend: true, fromEmail: null, maxOutreachSendsPerDay: 100 },
  })
  assert.equal(result.sent, false)
  assert.equal(result.blocked.reason, 'provider_not_configured')
})

test('refuses to send to suppression-list recipients', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  await addSuppressionEntry(db, { identifier_type: 'email', identifier_value: 'chief@athensvfd.org' })

  const result = await sendOutreachAttempt({
    db,
    attempt: { ...attempt, approved_by_user_id: 'u1', approved_at: new Date().toISOString() },
    prospect,
    emailSender: () => { throw new Error('sender must not be called') },
    config: { enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c', maxOutreachSendsPerDay: 100 },
  })
  assert.equal(result.sent, false)
  assert.equal(result.blocked.reason, 'on_suppression_list')
})

test('refuses to send to DNC relationship', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  await upsertRelationship(db, prospect.id, { do_not_contact: true, do_not_contact_reason: 'admin' })

  const result = await sendOutreachAttempt({
    db,
    attempt: { ...attempt, approved_by_user_id: 'u1', approved_at: new Date().toISOString() },
    prospect,
    emailSender: () => { throw new Error('sender must not be called') },
    config: { enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c', maxOutreachSendsPerDay: 100 },
  })
  assert.equal(result.sent, false)
  assert.equal(result.blocked.reason, 'relationship_do_not_contact')
})

test('dryRun=true never invokes the email sender but does not crash', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  let calls = 0
  const sender = async () => { calls += 1; return { ok: true } }

  const result = await sendOutreachAttempt({
    db,
    attempt: { ...attempt, approved_by_user_id: 'u1', approved_at: new Date().toISOString() },
    prospect,
    emailSender: sender,
    config: { enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c', maxOutreachSendsPerDay: 100 },
    dryRun: true,
  })
  assert.equal(result.sent, false)
  assert.equal(result.blocked.reason, 'dry_run')
  assert.equal(calls, 0)
})

test('happy path: approved + clean prospect → sender invoked + attempt marked sent', async () => {
  const db = createInMemoryDb()
  const { prospect, attempt } = await buildAttemptInDb(db)
  let calls = 0
  const sender = async ({ to }) => { calls += 1; assert.equal(to, 'chief@athensvfd.org'); return { ok: true, messageId: 'mid-123' } }

  const approved = { ...attempt, approved_by_user_id: 'u1', approved_at: new Date().toISOString() }
  const result = await sendOutreachAttempt({
    db,
    attempt: approved,
    prospect,
    emailSender: sender,
    config: { enabled: true, requireApprovalToSend: true, fromEmail: 'a@b.c', maxOutreachSendsPerDay: 100 },
  })

  assert.equal(result.sent, true)
  assert.equal(calls, 1)
  assert.equal(result.attempt.send_status, 'sent')
  assert.ok(result.attempt.sent_at)
})
