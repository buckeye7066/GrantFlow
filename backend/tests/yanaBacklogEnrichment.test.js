/**
 * Yana backlog re-enrichment + Yana→John handoff, end to end.
 *
 * Prod defect this guards against (verified in the 2026-06/07 audits): ProPublica
 * 990 discovery lands real orgs WITHOUT a contact email as `needs_enrichment`,
 * and that pile (420 rows in prod) was written once and NEVER revisited —
 * enrichment only ran inline on newly-discovered prospects. Any org whose
 * enrichment failed at discovery time (Brave 429 breaker, per-site fetch/cert
 * failure) was stuck forever, so nothing new qualified and runs kept reporting
 * "N qualified, 0 pushed to John".
 *
 * These tests prove:
 *   1. Stored needs_enrichment leads get a bounded second chance per run
 *      (enrichNeedsEnrichmentBacklog) and are promoted to `qualified` when a
 *      REAL published email is found — with the source page persisted as
 *      evidence (never a fabricated address).
 *   2. The per-run cap and the per-lead retry budget are honored.
 *   3. A promoted lead flows through the actual handoff surface — pushed by
 *      pushQualifiedToJohn and returned by John's fetchLeadsForJohn via
 *      makeYanaLeadSource — exactly once (already-drafted dedup respected).
 *
 * No network: search/fetch are injected mocks.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

import {
  runYanaDiscovery,
  discoverProspects,
  enrichNeedsEnrichmentBacklog,
  pushQualifiedToJohn,
  makeYanaLeadSource,
  BACKLOG_ENRICH_MAX_ATTEMPTS,
  _resetYanaSchemaCache,
} from '../services/yana/yanaLeadDiscovery.js'
import { registerProspectSource } from '../services/yana/yanaProspectSources.js'
import { makeContactEnricher } from '../services/yana/yanaContactEnrichment.js'
import { fetchLeadsForJohn } from '../services/john/johnYanaBridge.js'
import { insertDraft } from '../services/john/johnRunStore.js'

const JOHN_MIGRATION = fileURLToPath(new URL('../db/migrations/083_john_tables.sql', import.meta.url))

function makeDb() {
  return new Database(':memory:')
}

/** A ProPublica-shaped prospect: real identity, NO contact email. */
function identityOnlyProspect(i) {
  return {
    organization_name: `Riverbend Community Fund ${i}`,
    external_id: `ein-${1000 + i}`,
    source: 'propublica_990',
    applicant_type: 'nonprofit',
    mission: 'Supports families across Riverbend County with food security, housing repair, and after-school programs.',
    city: 'Riverbend',
    state: 'OH',
  }
}

/** Register a fake propublica source yielding the given prospects. */
function registerFakeSource(prospects) {
  registerProspectSource('propublica_990', {
    name: 'propublica_990',
    async discover() { return prospects },
  })
}

/** An ENABLED enricher whose web is fully mocked (no network). */
function mockEnricher({ email = true } = {}) {
  return makeContactEnricher({
    env: { YANA_ALLOW_LIVE_WEB: 'true' },
    searchProvider: async ({ query }) => {
      const slug = String(query).toLowerCase().includes('fund 1') ? 'fund1' : 'org'
      return [{ url: `https://riverbend-${slug}.test/`, title: 'Official site', snippet: '' }]
    },
    fetcher: async (url) => {
      if (!email) return '<html><body>Call us: (555) 555-0100</body></html>'
      if (/\/contact/.test(url)) {
        return '<html><body><a href="mailto:info@riverbendfund.test">info@riverbendfund.test</a></body></html>'
      }
      return '<html><body><h1>Riverbend Community Fund</h1><a href="/contact">Contact Us</a><p>We serve Riverbend County families.</p></body></html>'
    },
  })
}

/** Seed N needs_enrichment prospect rows (discovery with enrichment disabled). */
async function seedBacklog(db, n) {
  registerFakeSource(Array.from({ length: n }, (_, i) => identityOnlyProspect(i + 1)))
  const res = await discoverProspects(db, {
    allowLiveWeb: true,
    sources: ['propublica_990'],
    enricher: makeContactEnricher({ env: {} }), // disabled — honest NOOP
    limit: n,
  })
  expect(res.needs_enrichment).toBe(n)
  return res
}

beforeEach(() => {
  _resetYanaSchemaCache()
})

describe('enrichNeedsEnrichmentBacklog', () => {
  it('promotes a stuck needs_enrichment lead to qualified with a REAL email + source-page evidence', async () => {
    const db = makeDb()
    await seedBacklog(db, 2)

    const summary = await enrichNeedsEnrichmentBacklog(db, { enricher: mockEnricher(), limit: 10 })
    expect(summary.enabled).toBe(true)
    expect(summary.attempted).toBe(2)
    expect(summary.promoted_to_qualified).toBe(2)
    expect(summary.backlog_remaining).toBe(0)

    const rows = db.prepare(`SELECT * FROM yana_lead_candidates ORDER BY organization_name`).all()
    for (const row of rows) {
      expect(row.qualification_status).toBe('qualified')
      expect(row.contact_email).toBe('info@riverbendfund.test') // scraped, not fabricated
      expect(row.enrich_attempts).toBe(1)
      expect(row.last_enrich_attempt_at).toBeTruthy()
      // Evidence trail: the exact public page the email came from.
      const evidence = JSON.parse(row.public_evidence_json)
      const emailEvidence = evidence.find((e) => e.type === 'contact_email_source')
      expect(emailEvidence).toBeTruthy()
      expect(emailEvidence.email).toBe('info@riverbendfund.test')
      expect(emailEvidence.source_url).toMatch(/\/contact/)
      expect(JSON.parse(row.source_urls_json)).toContain(emailEvidence.source_url)
    }
  })

  it('honors the per-run cap so runs stay fast', async () => {
    const db = makeDb()
    await seedBacklog(db, 5)

    const summary = await enrichNeedsEnrichmentBacklog(db, { enricher: mockEnricher(), limit: 2 })
    expect(summary.attempted).toBe(2)
    expect(summary.promoted_to_qualified).toBe(2)
    expect(summary.backlog_remaining).toBe(3)
  })

  it('burns one retry per failed attempt and stops re-selecting exhausted leads', async () => {
    const db = makeDb()
    await seedBacklog(db, 1)
    const noEmail = mockEnricher({ email: false })

    for (let attempt = 1; attempt <= BACKLOG_ENRICH_MAX_ATTEMPTS; attempt += 1) {
      const s = await enrichNeedsEnrichmentBacklog(db, { enricher: noEmail, limit: 10 })
      expect(s.attempted).toBe(1)
      expect(s.promoted_to_qualified).toBe(0)
      const row = db.prepare(`SELECT * FROM yana_lead_candidates`).get()
      expect(row.qualification_status).toBe('needs_enrichment') // honest — no contact found
      expect(row.enrich_attempts).toBe(attempt)
    }

    // Retry budget exhausted → the lead is no longer selected (budget goes to
    // leads that still have a chance) but stays honestly needs_enrichment.
    const after = await enrichNeedsEnrichmentBacklog(db, { enricher: noEmail, limit: 10 })
    expect(after.attempted).toBe(0)
    expect(after.backlog_remaining).toBe(1)
  })

  it('never promotes on an invalid/fabricated email and is an honest NOOP without an enabled enricher', async () => {
    const db = makeDb()
    await seedBacklog(db, 1)

    // Enricher (hypothetically buggy) hands back a non-email — must not promote.
    const bogus = {
      enabled: true,
      async enrich() { return { ok: true, website_url: 'https://x.test', email: 'not-an-email' } },
    }
    const s1 = await enrichNeedsEnrichmentBacklog(db, { enricher: bogus, limit: 10 })
    expect(s1.promoted_to_qualified).toBe(0)
    expect(db.prepare(`SELECT qualification_status FROM yana_lead_candidates`).get().qualification_status).toBe('needs_enrichment')

    // Disabled enricher → NOOP with a reason, nothing mutated.
    const s2 = await enrichNeedsEnrichmentBacklog(db, { enricher: makeContactEnricher({ env: {} }), limit: 10 })
    expect(s2.attempted).toBe(0)
    expect(s2.reason).toBe('enricher_disabled')
  })
})

describe('Yana→John handoff, end to end', () => {
  it('a backlog-promoted lead is pushed and picked up by John exactly once', async () => {
    const db = makeDb()
    db.exec(readFileSync(JOHN_MIGRATION, 'utf8')) // John's real tables (drafts, suppression)

    // Run 1: prospects arrive without email → stuck pile (enrichment disabled).
    await seedBacklog(db, 2)
    let run = await runYanaDiscovery(db, {
      allowLeads: true,
      allowLiveWeb: true,
      deps: { loadOrganizations: async () => [] },
      prospectDeps: { sources: ['propublica_990'], enricher: makeContactEnricher({ env: {} }) },
      backlogEnrichLimit: 0, // no backlog pass yet — prove the pile is stuck
    })
    expect(run.leads_pushed_to_john).toBe(0)
    expect(run.push_noop_reason).toBe('no_unpushed_qualified_leads')

    // Run 2: the normal run loop's backlog pass promotes + pushes them.
    registerFakeSource([]) // nothing new discovered this run
    run = await runYanaDiscovery(db, {
      allowLeads: true,
      allowLiveWeb: true,
      deps: { loadOrganizations: async () => [] },
      prospectDeps: { sources: ['propublica_990'], enricher: mockEnricher() },
      backlogEnrichLimit: 10,
    })
    expect(run.backlog_enrichment.promoted_to_qualified).toBe(2)
    expect(run.candidates_qualified).toBe(2)
    expect(run.leads_pushed_to_john).toBe(2)

    // John's actual reader (the registered Yana lead source through his bridge
    // filters) sees both leads, each exactly once.
    const leadSource = makeYanaLeadSource(db)
    const first = await fetchLeadsForJohn({ db, leadSource })
    expect(first.leads.length).toBe(2)
    const names = first.leads.map((l) => l.organization_name).sort()
    expect(new Set(names).size).toBe(2)
    for (const lead of first.leads) {
      expect(lead.qualified).toBe(true)
      expect(lead.contact_points.some((p) => p.type === 'email' && p.value === 'info@riverbendfund.test')).toBe(true)
      expect(lead.public_evidence.some((e) => e.type === 'contact_email_source')).toBe(true)
    }

    // John drafts one → markQueuedForReview + a real draft row. The lead must
    // NOT be handed to him again (dedup via already_drafted).
    const drafted = first.leads[0]
    await leadSource.markQueuedForReview({ leadId: drafted.lead_id })
    await insertDraft(db, { yana_lead_id: drafted.lead_id, draft_status: 'created' })

    const second = await fetchLeadsForJohn({ db, leadSource })
    expect(second.leads.map((l) => l.lead_id)).not.toContain(drafted.lead_id)
    expect(second.leads.length).toBe(1)
    expect(second.filtered_out.already_drafted).toBe(1)

    // And Yana never re-pushes it either (pushed_to_john stayed set).
    const rePush = await pushQualifiedToJohn(db)
    expect(rePush.leads_pushed_to_john).toBe(0)
    expect(rePush.push_noop_reason).toBe('no_unpushed_qualified_leads')
  })
})
