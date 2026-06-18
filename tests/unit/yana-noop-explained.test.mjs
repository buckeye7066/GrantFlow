/**
 * Item 7 — Yana qualifies leads correctly and explains a 0-qualified run.
 *
 * The audit found Yana reports 0 qualified leads (so John has no upstream
 * leads). The deep-dive confirmed this is a DATA/config condition, not a code
 * bug: the scoring + qualification are sound and the 70 threshold is reachable
 * (email+website+mission+focus = 70). These tests pin both: a rich org
 * qualifies, a sparse org does not, and a 0-qualified run now reports WHY
 * (honest NOOP) instead of a silent zero.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  scoreOrganizationLead,
  qualifyScore,
  runYanaDiscovery,
  QUALIFY_THRESHOLD,
} from '../../backend/services/yana/yanaLeadDiscovery.js'

test('a complete org clears the qualification bar without needing an EIN', () => {
  const scored = scoreOrganizationLead({
    name: 'Rivertown Youth Foundation',
    email: 'contact@rivertown.org',
    website: 'https://rivertown.org',
    mission: 'We provide after-school STEM programs for underserved youth across the region.',
    focus_areas: JSON.stringify(['education', 'youth']),
    organization_type: 'nonprofit',
    // no ein on purpose
  })
  assert.ok(scored.lead_score >= QUALIFY_THRESHOLD, `score ${scored.lead_score} should reach ${QUALIFY_THRESHOLD}`)
  assert.equal(qualifyScore(scored).qualified, true)
})

test('a sparse org (no website/evidence) is disqualified with reasons', () => {
  const scored = scoreOrganizationLead({ name: 'Bare Org', email: 'x@y.org' })
  const { qualified, reasons } = qualifyScore(scored)
  assert.equal(qualified, false)
  assert.ok(reasons.some((r) => r.includes('below') || r === 'no_contact_source' || r === 'no_public_evidence'))
})

test('a 0-qualified run reports an explicit noop_reason + disqualification breakdown', async () => {
  const db = wrapSqlite(new Database(':memory:'))
  // Source orgs that all FAIL to qualify (have email, but no website/evidence).
  const loadOrganizations = async () => ([
    { id: 'o1', name: 'Sparse One', email: 'a@one.org' },
    { id: 'o2', name: 'Sparse Two', email: 'b@two.org' },
  ])

  const result = await runYanaDiscovery(db, { trigger: 'test', allowLeads: false, deps: { loadOrganizations } })
  assert.equal(result.ok, true)
  assert.equal(result.candidates_qualified, 0)
  assert.ok(result.noop_reason, 'a 0-qualified run must explain itself')
  assert.match(result.noop_reason, /0 of 2 organizations qualified/)
  assert.ok(result.disqualification_reasons && Object.keys(result.disqualification_reasons).length > 0)
})

test('an empty source reports the no-source noop_reason', async () => {
  const db = wrapSqlite(new Database(':memory:'))
  const result = await runYanaDiscovery(db, { trigger: 'test', allowLeads: false, deps: { loadOrganizations: async () => [] } })
  assert.equal(result.candidates_qualified, 0)
  assert.match(result.noop_reason, /no source organizations/)
})
