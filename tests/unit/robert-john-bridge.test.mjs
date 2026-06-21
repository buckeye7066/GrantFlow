import test from 'node:test'
import assert from 'node:assert/strict'

import { applyDefaultJohnEnv, makeJohnDb, makeQualifiedLead } from './john-test-helpers.mjs'
import {
  fetchLeadsForJohn,
  registerLeadSource,
  getRegisteredLeadSources,
  NULL_LEAD_SOURCE,
} from '../../backend/services/john/johnYanaBridge.js'
import {
  makeRobertLeadSource,
  robertSourceToLeadPacket,
  listQualifiedRobertLeads,
} from '../../backend/services/robert/robertJohnBridge.js'

// ── Test DB: john tables (from helper) + the robert_source_candidates table ──
// robert_source_candidates is the existing store the bridge READS (no new
// table is introduced); we create it here so the bridge can be exercised
// without the full Robert migration chain.
function makeDb() {
  const db = makeJohnDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS robert_source_candidates (
      id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_domain TEXT,
      source_type TEXT,
      source_scope TEXT,
      geography_state TEXT,
      geography_county TEXT,
      geography_city TEXT,
      applicant_types_json TEXT DEFAULT '[]',
      need_categories_json TEXT DEFAULT '[]',
      trust_score INTEGER DEFAULT 0,
      discovered_by TEXT,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked_at DATETIME,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      evidence_json TEXT DEFAULT '{}',
      robots_allowed INTEGER DEFAULT 1,
      rate_limit_bucket TEXT
    );
  `)
  return db
}

let _seq = 0
function insertSource(db, { id, name, url, status = 'approved', evidence = {} }) {
  const sid = id || `src-${++_seq}`
  // Spread the rows out in time so ORDER BY discovered_at DESC is deterministic.
  const ts = new Date(Date.now() - (1000 - _seq) * 1000).toISOString()
  db._raw
    .prepare(
      `INSERT INTO robert_source_candidates (id, source_name, source_url, status, evidence_json, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sid, name, url, status, JSON.stringify(evidence), ts)
  return sid
}

const CLIENT_LEAD_EVIDENCE = {
  search_query: 'youth services nonprofit ohio',
  lead: {
    is_client_prospect: true,
    email: 'director@helpinghands.test',
    contact_person: { name: 'Jamie Rivera', title: 'Executive Director' },
    organization_type: 'nonprofit',
    funding_need_summary: 'Seeking ~$80k for an after-school program.',
    grantflow_fit_summary: 'Strong fit for youth + education grants.',
    lead_score: 80,
  },
}

test('robertSourceToLeadPacket maps a tagged client-prospect row into a John packet', () => {
  const packet = robertSourceToLeadPacket({
    id: 'abc',
    source_name: 'Helping Hands Youth Center',
    source_url: 'https://helpinghands.test',
    geography_city: 'Columbus',
    geography_state: 'OH',
    discovered_at: '2026-06-21T00:00:00.000Z',
    evidence_json: JSON.stringify(CLIENT_LEAD_EVIDENCE),
  })
  assert.ok(packet)
  assert.equal(packet.lead_id, 'robert-src:abc')
  assert.equal(packet.organization_name, 'Helping Hands Youth Center')
  assert.equal(packet.qualified, true)
  assert.equal(packet.lead_score, 80)
  assert.equal(packet.location, 'Columbus, OH')
  assert.deepEqual(packet.contact_points, [{ type: 'email', value: 'director@helpinghands.test' }])
  assert.ok(packet.public_evidence.length > 0)
  assert.deepEqual(packet.source_urls, ['https://helpinghands.test'])
})

test('robertSourceToLeadPacket ignores an UNtagged funding source (funder is not a lead)', () => {
  // A plain funding source Robert discovered (the funding→profile path). It has
  // a source_url but no evidence.lead block — it must NEVER become a John lead.
  const packet = robertSourceToLeadPacket({
    id: 'funder-1',
    source_name: 'Acme Family Foundation',
    source_url: 'https://acmefoundation.test',
    evidence_json: JSON.stringify({ search_query: 'family foundation grants', snippet: 'gives grants' }),
  })
  assert.equal(packet, null)
})

test('robertSourceToLeadPacket drops a tagged prospect with no usable email', () => {
  const packet = robertSourceToLeadPacket({
    id: 'no-email',
    source_name: 'No Contact Org',
    source_url: 'https://nocontact.test',
    evidence_json: JSON.stringify({ lead: { is_client_prospect: true, email: '' } }),
  })
  assert.equal(packet, null)
})

test('listQualifiedRobertLeads returns only tagged client prospects, ignoring funders', async () => {
  const db = makeDb()
  try {
    insertSource(db, { name: 'Acme Family Foundation', url: 'https://acmefoundation.test', evidence: { snippet: 'funder' } })
    insertSource(db, { name: 'Helping Hands Youth Center', url: 'https://helpinghands.test', evidence: CLIENT_LEAD_EVIDENCE })
    const leads = await listQualifiedRobertLeads(db)
    assert.equal(leads.length, 1)
    assert.equal(leads[0].organization_name, 'Helping Hands Youth Center')
  } finally {
    db.close()
  }
})

test('makeRobertLeadSource feeds Robert leads into fetchLeadsForJohn alongside Yana', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeDb()
  try {
    insertSource(db, { name: 'Helping Hands Youth Center', url: 'https://helpinghands.test', evidence: CLIENT_LEAD_EVIDENCE })
    // Yana source via the standard test adapter shape.
    const yanaSource = {
      name: 'yana',
      async listQualifiedLeads() {
        return [makeQualifiedLead({ lead_id: 'yana-1', organization_name: 'Riverbend VFD' })]
      },
      async markQueuedForReview() { return { ok: true } },
    }
    const robertSource = makeRobertLeadSource(db)

    // Aggregate across BOTH sources (no explicit leadSource → use registry).
    registerLeadSource(NULL_LEAD_SOURCE) // reset
    registerLeadSource(yanaSource)
    registerLeadSource(robertSource)
    assert.equal(getRegisteredLeadSources().length, 2)

    const r = await fetchLeadsForJohn({ db })
    const orgs = r.leads.map((l) => l.organization_name).sort()
    assert.deepEqual(orgs, ['Helping Hands Youth Center', 'Riverbend VFD'])
    assert.deepEqual(r.source_names.sort(), ['robert', 'yana'])
    // Each lead carries its owning source for hook routing.
    const robertLead = r.leads.find((l) => l.organization_name === 'Helping Hands Youth Center')
    assert.equal(robertLead._leadSource.name, 'robert')
  } finally {
    registerLeadSource(NULL_LEAD_SOURCE)
    restore()
    db.close()
  }
})

test('fetchLeadsForJohn dedupes the same org across Yana and Robert (keeps highest-ranked)', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeDb()
  try {
    // Robert surfaces the SAME org/email as Yana, but with a LOWER score.
    insertSource(db, {
      name: 'Shared Org',
      url: 'https://sharedorg.test',
      evidence: { lead: { is_client_prospect: true, email: 'info@sharedorg.test', lead_score: 72 } },
    })
    const yanaSource = {
      name: 'yana',
      async listQualifiedLeads() {
        return [
          makeQualifiedLead({
            lead_id: 'yana-shared',
            organization_name: 'Shared Org',
            lead_score: 95,
            contact_points: [{ type: 'email', value: 'info@sharedorg.test' }],
            source_urls: ['https://sharedorg.test/about'],
          }),
        ]
      },
      async markQueuedForReview() { return { ok: true } },
    }
    registerLeadSource(NULL_LEAD_SOURCE)
    registerLeadSource(yanaSource)
    registerLeadSource(makeRobertLeadSource(db))
    const agg = await fetchLeadsForJohn({ db })
    assert.equal(agg.leads.length, 1, 'duplicate org collapsed to one draft')
    assert.equal(agg.leads[0].lead_id, 'yana-shared', 'higher-scored Yana lead wins')
    assert.ok(agg.filtered_out.duplicate_across_sources >= 1)
  } finally {
    registerLeadSource(NULL_LEAD_SOURCE)
    restore()
    db.close()
  }
})

test('Robert source enforces its own daily cap (John does not re-enforce)', async () => {
  const restore = applyDefaultJohnEnv()
  process.env.ROBERT_JOHN_MAX_LEADS_PER_24H = '1'
  const db = makeDb()
  try {
    insertSource(db, { id: 's1', name: 'Org One', url: 'https://orgone.test', evidence: { lead: { is_client_prospect: true, email: 'a@orgone.test' } } })
    insertSource(db, { id: 's2', name: 'Org Two', url: 'https://orgtwo.test', evidence: { lead: { is_client_prospect: true, email: 'b@orgtwo.test' } } })
    const before = await listQualifiedRobertLeads(db)
    assert.equal(before.length, 1, 'cap of 1 limits the batch')

    // Simulate John having already drafted a Robert lead in the last 24h.
    db._raw
      .prepare(
        `INSERT INTO john_email_drafts (id, yana_lead_id, draft_status, created_at)
         VALUES (?, ?, 'created', ?)`,
      )
      .run('d1', 'robert-src:s1', new Date().toISOString())
    const after = await listQualifiedRobertLeads(db)
    assert.equal(after.length, 0, 'cap reached → no more Robert leads this window')
  } finally {
    delete process.env.ROBERT_JOHN_MAX_LEADS_PER_24H
    restore()
    db.close()
  }
})

test('markQueuedForReview stamps the source row without touching Robert funding fields', async () => {
  const db = makeDb()
  try {
    const sid = insertSource(db, { name: 'Stamp Org', url: 'https://stamporg.test', evidence: CLIENT_LEAD_EVIDENCE })
    const source = makeRobertLeadSource(db)
    const res = await source.markQueuedForReview({ leadId: `robert-src:${sid}` })
    assert.equal(res.ok, true)
    const row = db._raw.prepare('SELECT * FROM robert_source_candidates WHERE id = ?').get(sid)
    // status (the funding→profile field) is unchanged; only evidence stamped.
    assert.equal(row.status, 'approved')
    const ev = JSON.parse(row.evidence_json)
    assert.ok(ev.lead.queued_for_john_at)
    assert.equal(ev.lead.is_client_prospect, true)
  } finally {
    db.close()
  }
})
