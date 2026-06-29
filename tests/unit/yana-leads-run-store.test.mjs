/**
 * Yana — Lead Pipeline run store: dedup, JSON round-trip, idempotency.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  startRun,
  completeRun,
  upsertProspectCandidate,
  upsertLead,
  insertOutreachAttempt,
  getProspect,
  findProspectByIdentifiers,
  listLeads,
  countSendsInWindow,
} from '../../backend/services/yanaOutreach/yanaOutreachRunStore.js'
import { createInMemoryDb } from './yana-leads-test-helpers.mjs'

test('startRun → completeRun records mode + status', async () => {
  const db = createInMemoryDb()
  const run = await startRun(db, { mode: 'observe', trigger: 'manual' })
  assert.ok(run.id)
  assert.equal(run.mode, 'observe')
  assert.equal(run.status, 'running')

  const completed = await completeRun(db, run.id, { status: 'completed', summary: { x: 1 } })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.summary_json, { x: 1 })
})

test('upsertProspectCandidate dedups on EIN', async () => {
  const db = createInMemoryDb()
  const a = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    ein: '12-3456789',
  })
  const b = await upsertProspectCandidate(db, {
    organization_name: 'Athens Volunteer Fire Department',
    state: 'TN',
    ein: '12-3456789',
    website_url: 'https://athensvfd.org',
  })
  assert.equal(a.id, b.id, 'second insert with the same EIN should match the first prospect')
  assert.equal(b.website_url, 'https://athensvfd.org', 'updated fields should overwrite empty fields')
})

test('upsertProspectCandidate dedups on website_url when EIN is missing', async () => {
  const db = createInMemoryDb()
  const a = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    website_url: 'https://athensvfd.org',
  })
  const b = await upsertProspectCandidate(db, {
    organization_name: 'Athens Volunteer Fire Department',
    state: 'TN',
    website_url: 'https://athensvfd.org',
  })
  assert.equal(a.id, b.id)
})

test('upsertProspectCandidate dedups on (name, state) when nothing else available', async () => {
  const db = createInMemoryDb()
  const a = await upsertProspectCandidate(db, { organization_name: 'Athens VFD', state: 'TN' })
  const b = await upsertProspectCandidate(db, { organization_name: 'athens vfd', state: 'TN' })
  assert.equal(a.id, b.id)
})

test('findProspectByIdentifiers returns null when nothing matches', async () => {
  const db = createInMemoryDb()
  const result = await findProspectByIdentifiers(db, { organization_name: 'Nonexistent Org', state: 'CA' })
  assert.equal(result, null)
})

test('JSON columns round-trip through upsert + getProspect', async () => {
  const db = createInMemoryDb()
  const inserted = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    need_categories_json: ['equipment', 'training'],
    signals_json: { volunteer_led: true, recent_grant_history: '2024 AFG' },
  })
  const fresh = await getProspect(db, inserted.id)
  assert.deepEqual(fresh.need_categories_json, ['equipment', 'training'])
  assert.equal(fresh.signals_json.volunteer_led, true)
})

test('upsertLead dedups on (prospect_candidate_id, packet_version)', async () => {
  const db = createInMemoryDb()
  const prospect = await upsertProspectCandidate(db, {
    organization_name: 'Athens VFD',
    state: 'TN',
    ein: '12-3456789',
  })

  const a = await upsertLead(db, {
    prospect_candidate_id: prospect.id,
    packet_version: 1,
    fit_score: 50,
    composite_score: 50,
  })
  const b = await upsertLead(db, {
    prospect_candidate_id: prospect.id,
    packet_version: 1,
    fit_score: 80,
    composite_score: 80,
  })
  assert.equal(a.id, b.id)
  assert.equal(b.fit_score, 80)

  const all = await listLeads(db, {})
  assert.equal(all.length, 1)
})

test('countSendsInWindow counts only sent attempts in the window', async () => {
  const db = createInMemoryDb()
  const prospect = await upsertProspectCandidate(db, { organization_name: 'X', state: 'TN' })
  const lead = await upsertLead(db, {
    prospect_candidate_id: prospect.id,
    packet_version: 1,
    fit_score: 80,
    composite_score: 80,
    status: 'qualified',
  })
  await insertOutreachAttempt(db, {
    lead_id: lead.id,
    prospect_candidate_id: prospect.id,
    channel: 'email',
    send_status: 'drafted',
  })
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const count = await countSendsInWindow(db, { sinceIso })
  assert.equal(count, 0)
})
