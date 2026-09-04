import { describe, it, expect, vi } from 'vitest'

// Billing enforcement is covered separately; this suite exercises downstream Hamilton behavior.
vi.mock('../services/billing/entitlementService.js', () => ({
  resolveProfileEntitlement: vi.fn(async () => ({ allowed: true, source: 'tier' })),
}))
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {
  decomposeListing,
  buildOpportunityRecord,
  isNgWebCatalogHost,
  listingHostSponsor,
} from '../services/hamilton/listingDecomposition.js'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

// Fakes: the real inserter/match/apply have their own test suites; here we prove
// the decomposition CONTROL FLOW — admission gate → sole match authority →
// bounded, NGWeb-guarded apply fan-out.
function fakeInsert(overrides = {}) {
  let n = 0
  return async (_db, rec) => {
    n += 1
    if (overrides.rejectTitles?.includes(rec.title)) return { id: null, skipped: true, reason: 'reality:dead_url' }
    return { id: `opp-${n}`, inserted: true, skipped: false }
  }
}
function fakeMatch(decisionByTitle) {
  return (_p, opp) => ({ decision: decisionByTitle[opp.title] || 'REVIEW', score: 0.7 })
}
function enumOf(items) {
  return async () => ({ items, rejected: [], notFound: [] })
}

const profile = { id: 'p1', basic_information: { first_name: 'A' } }

describe('isNgWebCatalogHost', () => {
  it('matches every NGWeb tenant, not other hosts', () => {
    expect(isNgWebCatalogHost('https://mtsu.scholarships.ngwebsolutions.com/Scholarships/Search')).toBe(true)
    expect(isNgWebCatalogHost('https://clevelandstatecc.scholarships.ngwebsolutions.com/x')).toBe(true)
    expect(isNgWebCatalogHost('https://bold.org/scholarships/category/housing')).toBe(false)
    expect(isNgWebCatalogHost('https://evil-ngwebsolutions.com.attacker.net')).toBe(false)
  })
})

describe('buildOpportunityRecord', () => {
  it('prefers the item apply link, falls back to the listing URL, trusted origin', () => {
    const withLink = buildOpportunityRecord(
      { title: 'X Scholarship', amount: 2000, applyUrl: 'https://f.org/apply/x' },
      { listingUrl: 'https://f.org/list' },
    )
    expect(withLink.application_url).toBe('https://f.org/apply/x')
    expect(withLink.source_url).toBe('https://f.org/apply/x')
    expect(withLink.record_origin).toBe('scholarship_crawler')
    expect(withLink.amount_min).toBe(2000)

    const noLink = buildOpportunityRecord({ title: 'Y Scholarship', applyUrl: null }, { listingUrl: 'https://f.org/list' })
    expect(noLink.application_url).toBeNull()
    expect(noLink.source_url).toBe('https://f.org/list')
  })

  it('SPONSOR: keeps the award-text sponsor when the enumerator captured one', () => {
    const rec = buildOpportunityRecord(
      { title: 'Coca-Cola Scholars', sponsor: 'The Coca-Cola Foundation', applyUrl: 'https://x.org/apply' },
      { listingUrl: 'https://scholarshipowl.com/scholarships' },
    )
    expect(rec.sponsor).toBe('The Coca-Cola Foundation')
  })

  it('SPONSOR: falls back to the REAL hub/listing host org when the award names none', () => {
    // The award's own text named no sponsor → the row still carries a real funder
    // (the hub it was demonstrably listed on) instead of a NULL sponsor.
    const owl = buildOpportunityRecord({ title: 'John Smith Memorial Scholarship', applyUrl: null }, { listingUrl: 'https://scholarshipowl.com/scholarships/john-smith' })
    expect(owl.sponsor).toBe('ScholarshipOwl')
    const bold = buildOpportunityRecord({ title: 'Housing Scholarship', applyUrl: 'https://bold.org/scholarships/housing' }, { listingUrl: 'https://bold.org/scholarships/category/housing' })
    expect(bold.sponsor).toBe('Bold.org')
  })
})

describe('listingHostSponsor', () => {
  it('maps common scholarship hubs to their display name', () => {
    expect(listingHostSponsor('https://scholarshipowl.com/scholarships/x')).toBe('ScholarshipOwl')
    expect(listingHostSponsor('https://www.bold.org/scholarships/y')).toBe('Bold.org')
    expect(listingHostSponsor('https://www.scholarships.com/financial-aid')).toBe('Scholarships.com')
  })
  it('capitalizes the registrable label of an unknown host (a REAL identity, never fabricated)', () => {
    expect(listingHostSponsor('https://www.aifsabroad.com/scholarships-grants-details/')).toBe('AIFS Abroad') // curated
    expect(listingHostSponsor('https://foundationgrants.example-unknown-host.org/x')).toBe('Example-unknown-host')
    expect(listingHostSponsor('https://w1.mtsu.edu/honors/scholarships.php')).toBe('Mtsu')
  })
  it('returns null for an empty or unparseable URL (caller leaves sponsor null)', () => {
    expect(listingHostSponsor(null)).toBeNull()
    expect(listingHostSponsor('not a url')).toBeNull()
    expect(listingHostSponsor('')).toBeNull()
  })
})

describe('decomposeListing — control flow', () => {
  const items = [
    { title: 'Housing Security Scholarship', amount: 2000, applyUrl: 'https://bold.org/apply/housing' },
    { title: 'First-Gen Fellowship', amount: 5000, applyUrl: 'https://bold.org/apply/firstgen' },
    { title: 'Ineligible Award', amount: 1000, applyUrl: 'https://bold.org/apply/inelig' },
    { title: 'Dead Award', amount: 500, applyUrl: 'https://bold.org/apply/dead' },
  ]
  const listing = { url: 'https://bold.org/scholarships/category/housing', title: 'Housing', text: 't', links: [] }

  it('admits, matches, and applies only ACCEPTs with a real link', async () => {
    const applied = []
    const out = await decomposeListing(
      { db: {}, profile, listing },
      {
        enumerate: enumOf(items),
        insert: fakeInsert({ rejectTitles: ['Dead Award'] }),
        match: fakeMatch({
          'Housing Security Scholarship': 'ACCEPT',
          'First-Gen Fellowship': 'ACCEPT',
          'Ineligible Award': 'REJECT',
          'Dead Award': 'ACCEPT',
        }),
        applyItem: async (item) => { applied.push(item.title); return { status: 'completed_draft' } },
      },
    )
    expect(out.enumerated).toBe(4)
    expect(out.admitted).toBe(3) // Dead Award bounced at the inserter
    // Only the two accepted-with-link awards were applied.
    expect(applied.sort()).toEqual(['First-Gen Fellowship', 'Housing Security Scholarship'])
    expect(out.applies_attempted).toBe(2)
    const inelig = out.items.find((i) => i.title === 'Ineligible Award')
    expect(inelig.outcome).toBe('not_accepted')
    const dead = out.items.find((i) => i.title === 'Dead Award')
    expect(dead.outcome).toBe('not_admitted')
  })

  it('bounds apply fan-out with maxApplies', async () => {
    const applied = []
    const out = await decomposeListing(
      { db: {}, profile, listing, maxApplies: 1 },
      {
        enumerate: enumOf(items.slice(0, 2)),
        insert: fakeInsert(),
        match: fakeMatch({ 'Housing Security Scholarship': 'ACCEPT', 'First-Gen Fellowship': 'ACCEPT' }),
        applyItem: async (item) => { applied.push(item.title); return { status: 'submitted' } },
      },
    )
    expect(out.applies_attempted).toBe(1)
    expect(applied).toHaveLength(1)
    expect(out.items.some((i) => i.outcome === 'apply_fanout_capped')).toBe(true)
  })

  it('caps enumeration with maxItems', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ title: `Scholarship ${i}`, applyUrl: null }))
    const out = await decomposeListing(
      { db: {}, profile, listing, maxItems: 10 },
      { enumerate: enumOf(many), insert: fakeInsert(), match: fakeMatch({}) },
    )
    expect(out.enumerated).toBe(10)
  })

  it('NGWeb catalog: admits for visibility but NEVER applies, even for ACCEPTs', async () => {
    const applied = []
    const ngwebListing = { url: 'https://mtsu.scholarships.ngwebsolutions.com/Scholarships/Search', title: 'Scholarships Search', text: 't', links: [] }
    const out = await decomposeListing(
      { db: {}, profile, listing: ngwebListing },
      {
        enumerate: enumOf([{ title: 'Aaron & Clara Todd Scholarship', amount: 1000, applyUrl: null }]),
        insert: fakeInsert(),
        match: fakeMatch({ 'Aaron & Clara Todd Scholarship': 'ACCEPT' }),
        applyItem: async (item) => { applied.push(item.title); return { status: 'submitted' } },
      },
    )
    expect(out.catalog_only).toBe(true)
    expect(out.admitted).toBe(1)
    expect(applied).toHaveLength(0)
    expect(out.items[0].outcome).toBe('catalog_only')
  })

  it('records ACCEPTs when no apply runner is wired (deferred, not applied)', async () => {
    const out = await decomposeListing(
      { db: {}, profile, listing },
      {
        enumerate: enumOf([{ title: 'Housing Security Scholarship', applyUrl: 'https://bold.org/apply/h' }]),
        insert: fakeInsert(),
        match: fakeMatch({ 'Housing Security Scholarship': 'ACCEPT' }),
        // applyItem intentionally omitted
      },
    )
    expect(out.items[0].outcome).toBe('accepted_apply_deferred')
    expect(out.applies_attempted).toBe(0)
  })
})

describe('buildOpportunityRecord survives the REAL inserter gate stack', () => {
  // Proves the feature does not silently no-op: a decomposed listing item, built
  // by buildOpportunityRecord, is actually admitted by the canonical
  // upsertFundingOpportunity (quality → provenance → policy → validation →
  // reality → dedupe), not bounced before it can be matched.
  it('admits a well-formed enumerated award through upsertFundingOpportunity', async () => {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const item = {
      title: 'Housing Security Scholarship',
      amount: 2000,
      sponsor: 'Bold.org',
      deadline: '2026-12-01',
      applyUrl: 'https://bold.org/scholarships/housing-security-scholarship',
      evidence: 'The Housing Security Scholarship awards $2,000 to students facing housing insecurity.',
    }
    const rec = buildOpportunityRecord(item, { listingUrl: 'https://bold.org/scholarships/category/housing' })
    const res = await upsertFundingOpportunity(db, rec, { verifyUrl: false, allowDirectories: true })
    expect(res.skipped, `record was gated: ${res.reason}`).toBeFalsy()
    expect(res.id).toBeTruthy()
    const row = db.prepare('SELECT title, application_url, record_origin FROM funding_opportunities WHERE id = ?').get(res.id)
    expect(row.title).toBe('Housing Security Scholarship')
    expect(row.record_origin).toBe('scholarship_crawler')
    db.close()
  })
})

/**
 * 2026-08-21 — "0 award(s) found, 0 admitted to matching, 0 profile-accepted
 * award task(s) created" was the ENTIRE message the owner saw on the run
 * dashboard. The decomposer always knows why it enumerated nothing; the
 * orchestrator discarded the reason at the render, so "no AI provider is
 * configured" and "this page genuinely lists no awards" printed identically.
 */
describe('describeDecomposition — a zero is never reported without its reason', () => {
  it('names the enumerator failure instead of printing three zeros', async () => {
    const { describeDecomposition } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
    const msg = describeDecomposition({
      enumerated: 0,
      admitted: 0,
      items: [],
      rejected: [],
      notFound: ['no AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)'],
    }, 0)
    expect(msg).toContain('no AI provider configured')
    expect(msg).toContain('not evidence the page is empty')
  })

  it('says so LOUDLY when even the reason is missing', async () => {
    const { describeDecomposition } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
    const msg = describeDecomposition({ enumerated: 0, admitted: 0, items: [], rejected: [], notFound: [] }, 0)
    expect(msg).toContain('unexplained')
  })

  it('reports the fabrication guard when it refused candidates', async () => {
    const { describeDecomposition } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
    const msg = describeDecomposition({
      enumerated: 0, admitted: 0, items: [], notFound: ['no individual award opportunities enumerated from the listing text'],
      rejected: [{ title: 'Made Up Award', reason: 'title_not_on_page' }],
    }, 0)
    expect(msg).toContain('fabrication guard')
    expect(msg).toContain('title_not_on_page')
  })

  it('explains why nothing was ADMITTED even when awards were enumerated', async () => {
    const { describeDecomposition } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
    const msg = describeDecomposition({
      enumerated: 4, admitted: 0, notFound: [], rejected: [],
      items: [{ outcome: 'not_admitted', detail: 'inserter rejected or deduped without id' }],
    }, 0)
    expect(msg).toContain('4 award(s) found')
    expect(msg).toContain('None was admitted')
  })

  it('still renders the ordinary success sentence unchanged in shape', async () => {
    const { describeDecomposition } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
    const msg = describeDecomposition({
      enumerated: 6, admitted: 5, notFound: [], rejected: [],
      items: [{ outcome: 'accepted_apply_deferred' }],
    }, 3)
    expect(msg).toContain('6 award(s) found, 5 admitted to matching, 3 profile-accepted')
    expect(msg).toContain('No child application was submitted')
  })
})
