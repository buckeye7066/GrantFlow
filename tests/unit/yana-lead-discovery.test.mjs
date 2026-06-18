/**
 * Yana — Client Discoverer (mission Goal 14).
 *
 * Verifies Yana now does REAL work (not a phantom COUNT): she discovers lead
 * candidates from organizations, qualifies them deterministically, pushes
 * qualified leads to John, persists a real run in yana_lead_runs, and produces
 * lead packets that PASS John's bridge filter (johnYanaBridge) so John can
 * actually draft outreach.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  runYanaDiscovery,
  getYanaStatus,
  makeYanaLeadSource,
  scoreOrganizationLead,
  _resetYanaSchemaCache,
} from '../../backend/services/yana/yanaLeadDiscovery.js'
import { fetchLeadsForJohn } from '../../backend/services/john/johnYanaBridge.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, applicant_type TEXT,
      organization_type TEXT, nonprofit_type TEXT, city TEXT, state TEXT,
      website TEXT, ein TEXT, mission TEXT,
      focus_areas TEXT DEFAULT '[]', program_areas TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  // STRONG lead: email + website + mission + focus + type + ein → score 100.
  sqlite.prepare(`INSERT INTO organizations (id, name, email, applicant_type, city, state, website, ein, mission, focus_areas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'org-strong', 'Helping Hands Ministry', 'contact@helpinghands.org', 'church',
    'Cleveland', 'OH', 'https://helpinghands.org', '12-3456789',
    'Helping Hands Ministry provides food, shelter, and family support across Cuyahoga County for over twenty years.',
    JSON.stringify(['food_security', 'housing']),
  )
  // WEAK lead: email only, nothing else → score below threshold.
  sqlite.prepare(`INSERT INTO organizations (id, name, email) VALUES (?, ?, ?)`)
    .run('org-weak', 'Tiny Org', 'a@b.co')
  // No-email org: must not become a candidate via the default loader.
  sqlite.prepare(`INSERT INTO organizations (id, name) VALUES (?, ?)`).run('org-noemail', 'No Contact Org')
  return sqlite
}

beforeEach(() => { _resetYanaSchemaCache() })

describe('Yana lead discovery', () => {
  it('scores a complete organization as a strong qualified lead', () => {
    const scored = scoreOrganizationLead({
      name: 'X', email: 'x@y.org', website: 'https://y.org', applicant_type: 'nonprofit',
      ein: '11-1111111', mission: 'A'.repeat(120), focus_areas: JSON.stringify(['a', 'b']),
    })
    assert.equal(scored.lead_score, 100)
    assert.ok(scored.public_evidence.length > 0)
    assert.deepEqual(scored.source_urls, ['https://y.org'])
  })

  it('discovers + qualifies + pushes, and persists a real run', async () => {
    const db = makeDb()
    const result = await runYanaDiscovery(db, { allowLeads: true })

    assert.equal(result.ok, true)
    assert.equal(result.candidates_total, 2, 'two orgs have email → two candidates (no-email org excluded)')
    assert.equal(result.candidates_qualified, 1, 'only the complete org qualifies')
    assert.equal(result.leads_pushed_to_john, 1, 'the qualified lead is pushed to John')

    // Persisted in yana_lead_runs (NOT the renamed yana_runs/hamilton_runs).
    const run = db.prepare('SELECT * FROM yana_lead_runs WHERE id = ?').get(result.run_id)
    assert.ok(run, 'run row persisted')
    assert.equal(run.status, 'completed')
    assert.equal(run.candidates_qualified, 1)

    const strong = db.prepare("SELECT * FROM yana_lead_candidates WHERE organization_id = 'org-strong'").get()
    assert.equal(strong.qualification_status, 'qualified')
    assert.equal(strong.pushed_to_john, 1)
    const weak = db.prepare("SELECT * FROM yana_lead_candidates WHERE organization_id = 'org-weak'").get()
    assert.equal(weak.qualification_status, 'unqualified')
    assert.equal(weak.pushed_to_john, 0)

    const status = await getYanaStatus(db)
    assert.equal(status.last_status, 'completed')
  })

  it('observe mode (allowLeads=false) qualifies but does NOT push', async () => {
    const db = makeDb()
    const result = await runYanaDiscovery(db, { allowLeads: false })
    assert.equal(result.candidates_qualified, 1)
    assert.equal(result.leads_pushed_to_john, 0)
    const strong = db.prepare("SELECT pushed_to_john FROM yana_lead_candidates WHERE organization_id = 'org-strong'").get()
    assert.equal(strong.pushed_to_john, 0)
  })

  it('re-running is idempotent on organization_id (upsert, no duplicates)', async () => {
    const db = makeDb()
    await runYanaDiscovery(db, { allowLeads: true })
    await runYanaDiscovery(db, { allowLeads: true })
    const n = db.prepare("SELECT COUNT(*) AS c FROM yana_lead_candidates").get().c
    assert.equal(n, 2, 'still two candidates after a second run')
  })

  it('produces lead packets that PASS John\'s bridge filter (real handoff)', async () => {
    const db = makeDb()
    await runYanaDiscovery(db, { allowLeads: true })
    const source = makeYanaLeadSource(db)

    // Run through the actual John bridge. db:null avoids needing John's tables;
    // suppression overridden — we are testing the CONTENT gate (qualified /
    // score>=70 / email / evidence / source).
    const out = await fetchLeadsForJohn({
      db: null,
      leadSource: source,
      suppression: { isSuppressed: () => false },
    })
    assert.equal(out.leads.length, 1, 'the qualified Yana lead reaches John')
    assert.equal(out.leads[0].organization_name, 'Helping Hands Ministry')
    assert.equal(out.leads[0].qualified, true)
    assert.ok(out.leads[0].lead_score >= 70)
  })
})
