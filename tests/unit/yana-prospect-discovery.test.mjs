/**
 * Yana outbound prospect discovery — find NEW orgs that could become GrantFlow
 * clients (not the operator's own organizations), enrich a contact channel, and
 * graduate them through discovered → needs_enrichment → qualified for John.
 *
 * Network-free: the ProPublica 990 search and the live-web enricher are both
 * dependency-injected.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  mapNonprofitToProspect,
  makePropublica990Source,
  registerProspectSource,
  _resetProspectSources,
} from '../../backend/services/yana/yanaProspectSources.js'
import {
  makeContactEnricher,
  extractEmailsFromHtml,
} from '../../backend/services/yana/yanaContactEnrichment.js'
import {
  discoverProspects,
  runYanaDiscovery,
  _resetYanaSchemaCache,
} from '../../backend/services/yana/yanaLeadDiscovery.js'

function makeDb() {
  _resetYanaSchemaCache()
  return wrapSqlite(new Database(':memory:'))
}

// A couple of fake ProPublica 990 orgs (normalizeOrg shape).
const FAKE_990 = [
  { ein: '111111111', name: 'Rivertown Youth Coalition', city: 'Akron', state: 'OH', ntee_code: 'O20', income_amount: 250000, profile_url: 'https://projects.propublica.org/nonprofits/organizations/111111111' },
  { ein: '222222222', name: 'Lakeside Community Health', city: 'Toledo', state: 'OH', ntee_code: 'E20', income_amount: 900000, profile_url: 'https://projects.propublica.org/nonprofits/organizations/222222222' },
]
function fakeSearch() {
  return async () => ({ total_results: FAKE_990.length, organizations: FAKE_990 })
}

test('mapNonprofitToProspect maps a 990 org to a prospect with no contact yet', () => {
  const p = mapNonprofitToProspect(FAKE_990[0])
  assert.equal(p.source, 'propublica_990')
  assert.equal(p.external_id, '111111111')
  assert.equal(p.entity_type, 'nonprofit')
  assert.equal(p.email, null)
  assert.equal(p.website_url, null)
  assert.deepEqual(p.source_urls, [FAKE_990[0].profile_url])
  assert.ok(p.focus_areas.length > 0, 'NTEE mapped to cause focus')
  assert.ok(p.public_evidence.length > 0, 'has identity evidence')
})

test('990 provider discovers + dedupes by EIN and respects limit', async () => {
  const src = makePropublica990Source({ searchOrganizations: fakeSearch() })
  const all = await src.discover({ limit: 100, queries: [{ q: 'x' }, { q: 'y' }] })
  // Two query plans return the same 2 orgs → deduped to 2 by EIN.
  assert.equal(all.length, 2)
  const limited = await src.discover({ limit: 1, queries: [{ q: 'x' }] })
  assert.equal(limited.length, 1)
})

test('extractEmailsFromHtml prefers info@/contact@ and drops junk', () => {
  const html = `<a href="mailto:noreply@x.org">no</a> <a href="mailto:info@river.org">x</a> webmaster: hello@example.com`
  const emails = extractEmailsFromHtml(html)
  assert.equal(emails[0], 'info@river.org')
  assert.ok(!emails.includes('hello@example.com'), 'example.com filtered')
  assert.ok(!emails.includes('noreply@x.org'), 'no-reply filtered')
})

test('enricher is an honest NOOP when live web is disabled', async () => {
  const enricher = makeContactEnricher({ env: {}, searchProvider: async () => [] })
  assert.equal(enricher.enabled, false)
  const r = await enricher.enrich({ organization_name: 'X' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'live_web_disabled')
})

test('enricher finds homepage + email when enabled', async () => {
  const enricher = makeContactEnricher({
    env: { YANA_ALLOW_LIVE_WEB: 'true' },
    searchProvider: async () => ([
      { url: 'https://www.guidestar.org/profile/x' }, // directory — skipped
      { url: 'https://rivertownyouth.org' },          // official site
    ]),
    fetcher: async () => '<a href="mailto:info@rivertownyouth.org">Email us</a>',
  })
  assert.equal(enricher.enabled, true)
  const r = await enricher.enrich({ organization_name: 'Rivertown Youth Coalition', city: 'Akron', state: 'OH' })
  assert.equal(r.ok, true)
  assert.equal(r.website_url, 'https://rivertownyouth.org')
  assert.equal(r.email, 'info@rivertownyouth.org')
})

test('discoverProspects is an honest NOOP when allowLiveWeb is off', async () => {
  const db = makeDb()
  const res = await discoverProspects(db, { allowLiveWeb: false })
  assert.equal(res.discovered, 0)
  assert.equal(res.reason, 'live_web_disabled')
})

test('discovered prospects land as needs_enrichment without a contact channel', async () => {
  const db = makeDb()
  _resetProspectSources()
  registerProspectSource('test_990', makePropublica990Source({ searchOrganizations: fakeSearch() }))

  const res = await discoverProspects(db, {
    allowLiveWeb: true,
    sources: ['test_990'],
    enricher: { enabled: false, enrich: async () => ({ ok: false }) },
    providerArgs: { queries: [{ q: 'x' }] },
  })
  assert.equal(res.discovered, 2)
  assert.equal(res.qualified, 0)
  assert.equal(res.needs_enrichment, 2, 'real nonprofits, no contact yet → needs_enrichment')

  const rows = await db.prepare("SELECT qualification_status, source, external_id FROM yana_lead_candidates").all()
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.source === 'propublica_990' && r.qualification_status === 'needs_enrichment'))
  _resetProspectSources()
})

test('prospect upsert is idempotent (ON CONFLICT source+external_id, no dupes)', async () => {
  const db = makeDb()
  _resetProspectSources()
  registerProspectSource('test_990', makePropublica990Source({ searchOrganizations: fakeSearch() }))
  const opts = {
    allowLiveWeb: true,
    sources: ['test_990'],
    enricher: { enabled: false, enrich: async () => ({ ok: false }) },
    providerArgs: { queries: [{ q: 'x' }] },
  }
  await discoverProspects(db, opts)
  await discoverProspects(db, opts) // re-run same prospects
  const count = await db.prepare('SELECT COUNT(*) AS c FROM yana_lead_candidates').get()
  assert.equal(Number(count.c), 2, 're-running discovery updates in place — no duplicate prospect rows')
  _resetProspectSources()
})

test('enrichment graduates a prospect to qualified (contactable)', async () => {
  const db = makeDb()
  _resetProspectSources()
  registerProspectSource('test_990', makePropublica990Source({ searchOrganizations: fakeSearch() }))

  const enricher = {
    enabled: true,
    enrich: async (p) => ({ ok: true, website_url: `https://${p.external_id}.org`, email: `info@${p.external_id}.org` }),
  }
  const res = await discoverProspects(db, {
    allowLiveWeb: true,
    sources: ['test_990'],
    enricher,
    providerArgs: { queries: [{ q: 'x' }] },
  })
  assert.equal(res.discovered, 2)
  assert.equal(res.enriched, 2)
  assert.equal(res.qualified, 2, 'enriched prospects with email clear the bar')

  const q = await db.prepare("SELECT contact_email FROM yana_lead_candidates WHERE qualification_status = 'qualified'").all()
  assert.equal(q.length, 2)
  assert.ok(q.every((r) => /@/.test(r.contact_email)))
  _resetProspectSources()
})

test('never prospects the operator\'s own organizations (dedupe by name/EIN)', async () => {
  const db = makeDb()
  db.raw.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, ein TEXT);`)
  db.raw.prepare("INSERT INTO organizations (id, name, ein) VALUES ('o1','Rivertown Youth Coalition','111111111')").run()
  _resetProspectSources()
  registerProspectSource('test_990', makePropublica990Source({ searchOrganizations: fakeSearch() }))

  const res = await discoverProspects(db, {
    allowLiveWeb: true,
    sources: ['test_990'],
    enricher: { enabled: false, enrich: async () => ({ ok: false }) },
    providerArgs: { queries: [{ q: 'x' }] },
  })
  assert.equal(res.discovered, 1, 'own org (matched by EIN) is skipped; only the other prospect remains')
  _resetProspectSources()
})

test('enrichment runs with bounded concurrency (parallel, not serial)', async () => {
  const db = makeDb()
  _resetProspectSources()
  // A source that returns 8 contact-less prospects (each needs enrichment).
  const many = Array.from({ length: 8 }, (_, i) => ({
    source: 'test_many',
    external_id: `e${i}`,
    organization_name: `Org ${i}`,
    organization_type: 'nonprofit',
    entity_type: 'nonprofit',
    focus_areas: ['education'],
    public_evidence: [{ type: 'focus_areas', value: ['education'] }],
    source_urls: [],
    email: null,
    website_url: null,
  }))
  registerProspectSource('test_many', { discover: async () => many })

  let inFlight = 0
  let maxInFlight = 0
  const enricher = {
    enabled: true,
    enrich: async (p) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5)) // hold the slot so peers overlap
      inFlight -= 1
      return { ok: true, website_url: `https://${p.external_id}.org`, email: `info@${p.external_id}.org` }
    },
  }

  const res = await discoverProspects(db, { allowLiveWeb: true, sources: ['test_many'], enricher })
  assert.equal(res.discovered, 8)
  assert.equal(res.enriched, 8)
  assert.ok(maxInFlight >= 2, `enrichment should overlap (saw max ${maxInFlight} in flight)`)
  assert.ok(maxInFlight <= 5, `must respect the concurrency cap (saw ${maxInFlight})`)
  _resetProspectSources()
})

test('runYanaDiscovery surfaces prospect funnel in the summary', async () => {
  const db = makeDb()
  _resetProspectSources()
  registerProspectSource('test_990', makePropublica990Source({ searchOrganizations: fakeSearch() }))

  const result = await runYanaDiscovery(db, {
    trigger: 'test',
    allowLeads: false,
    allowLiveWeb: true,
    deps: { loadOrganizations: async () => [] }, // no self-scan candidates
    prospectDeps: {
      sources: ['test_990'],
      enricher: { enabled: true, enrich: async (p) => ({ ok: true, website_url: `https://${p.external_id}.org`, email: `info@${p.external_id}.org` }) },
      providerArgs: { queries: [{ q: 'x' }] },
    },
  })
  assert.equal(result.ok, true)
  assert.ok(result.prospects, 'summary carries the prospect funnel')
  assert.equal(result.prospects.discovered, 2)
  assert.equal(result.candidates_qualified, 2, 'qualified prospects count toward the qualified pool John consumes')
  _resetProspectSources()
})
