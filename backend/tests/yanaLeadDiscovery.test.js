/**
 * Unit tests for backend/services/yana/yanaLeadDiscovery.js
 *
 * Yana = Client Discoverer (mission Goal 14). These tests prove the core,
 * deterministic, network-free funnel invariants without the full server:
 *
 *   1. scoreOrganizationLead is deterministic and produces explainable scores
 *      + evidence/source for John's bridge.
 *   2. qualifyScore enforces the four gates (email, score threshold, public
 *      evidence, contact source).
 *   3. discoverLeadCandidates upserts candidates and is idempotent per org.
 *   4. Yana Rule 4 — pushQualifiedToJohn never forwards more than the rolling
 *      24h cap (default 50), pushes the highest-value leads first, and reports
 *      cap accounting. A second push in the same window forwards 0.
 *   5. observe mode (allowLeads=false) qualifies but pushes nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  scoreOrganizationLead,
  qualifyScore,
  discoverLeadCandidates,
  pushQualifiedToJohn,
  countLeadsPushedWithinWindow,
  runYanaDiscovery,
  QUALIFY_THRESHOLD,
  DAILY_LEAD_CAP,
  _resetYanaSchemaCache,
} from '../services/yana/yanaLeadDiscovery.js'

function makeDb() {
  // Raw better-sqlite3: the service awaits synchronous returns, which resolve
  // fine, and has no `.dialect` so it takes the SQLite code paths.
  return new Database(':memory:')
}

/** A fully-formed org that scores well above the qualify threshold. */
function richOrg(i) {
  return {
    id: String(i),
    name: `Org ${i}`,
    email: `contact${i}@example.org`,
    website: `https://org${i}.example.org`,
    mission: 'We provide measurable community programs and direct services to families.',
    focus_areas: JSON.stringify(['education', 'housing']),
    program_areas: JSON.stringify(['after-school']),
    applicant_type: 'nonprofit',
    ein: `12-345${String(i).padStart(4, '0')}`,
    city: 'Columbus',
    state: 'OH',
  }
}

/** Inject N orgs into discovery without needing the organizations table. */
function loaderFor(orgs) {
  return async () => orgs
}

beforeEach(() => {
  // Schema-ensured is module-level cached; reset it so each fresh in-memory DB
  // re-creates the Yana tables.
  _resetYanaSchemaCache()
})

describe('scoreOrganizationLead', () => {
  it('is deterministic and produces evidence + source for a rich org', () => {
    const a = scoreOrganizationLead(richOrg(1))
    const b = scoreOrganizationLead(richOrg(1))
    expect(a).toEqual(b) // no randomness, no network
    expect(a.hasEmail).toBe(true)
    expect(a.lead_score).toBeGreaterThanOrEqual(QUALIFY_THRESHOLD)
    expect(a.public_evidence.length).toBeGreaterThan(0)
    expect(a.source_urls.length).toBeGreaterThan(0)
    expect(a.website_url).toMatch(/^https:\/\//)
  })

  it('normalizes a bare-domain website to https://', () => {
    const s = scoreOrganizationLead({ name: 'X', email: 'x@x.org', website: 'x.org' })
    expect(s.website_url).toBe('https://x.org')
  })
})

describe('qualifyScore', () => {
  it('qualifies a rich org', () => {
    const { qualified } = qualifyScore(scoreOrganizationLead(richOrg(1)))
    expect(qualified).toBe(true)
  })

  it('rejects an org with no usable email', () => {
    const scored = scoreOrganizationLead({ name: 'No Email', website: 'https://noemail.org', mission: 'x'.repeat(40), focus_areas: '["a"]' })
    const { qualified, reasons } = qualifyScore(scored)
    expect(qualified).toBe(false)
    expect(reasons).toContain('no_usable_email')
  })

  it('rejects a thin org below the score threshold', () => {
    const scored = scoreOrganizationLead({ name: 'Thin', email: 'thin@thin.org' })
    const { qualified } = qualifyScore(scored)
    expect(qualified).toBe(false)
  })
})

describe('discoverLeadCandidates', () => {
  it('upserts candidates and counts qualified, idempotently per org', async () => {
    const db = makeDb()
    const orgs = [richOrg(1), richOrg(2), { id: '3', name: 'Thin', email: 'thin@thin.org' }]
    const first = await discoverLeadCandidates(db, { loadOrganizations: loaderFor(orgs) })
    expect(first.candidates_total).toBe(3)
    expect(first.candidates_qualified).toBe(2) // org 3 is too thin

    // Re-running updates in place (UNIQUE organization_id) — no duplicate rows.
    await discoverLeadCandidates(db, { loadOrganizations: loaderFor(orgs) })
    const count = db.prepare('SELECT COUNT(*) AS c FROM yana_lead_candidates').get().c
    expect(count).toBe(3)
  })
})

describe('pushQualifiedToJohn — Yana Rule 4 rolling cap', () => {
  it('forwards at most the rolling cap and reports accounting', async () => {
    const db = makeDb()
    const cap = 5
    const orgs = Array.from({ length: 8 }, (_, i) => richOrg(i + 1))
    await discoverLeadCandidates(db, { loadOrganizations: loaderFor(orgs) })

    const first = await pushQualifiedToJohn(db, { cap })
    expect(first.leads_pushed_to_john).toBe(cap)
    expect(first.cap_reached).toBe(true)
    expect(first.already_pushed_in_window).toBe(0)

    // Second push in the same window is throttled to zero.
    const second = await pushQualifiedToJohn(db, { cap })
    expect(second.leads_pushed_to_john).toBe(0)
    expect(second.already_pushed_in_window).toBe(cap)

    expect(await countLeadsPushedWithinWindow(db)).toBe(cap)
  })

  it('defaults to a 50-lead cap', () => {
    expect(DAILY_LEAD_CAP).toBe(50)
  })

  it('observe mode (allowLeads=false) pushes nothing', async () => {
    const db = makeDb()
    const orgs = Array.from({ length: 3 }, (_, i) => richOrg(i + 1))
    const res = await runYanaDiscovery(db, { allowLeads: false, deps: { loadOrganizations: loaderFor(orgs) } })
    expect(res.ok).toBe(true)
    expect(res.mode).toBe('observe')
    expect(res.candidates_qualified).toBe(3)
    expect(res.leads_pushed_to_john).toBe(0)
    expect(await countLeadsPushedWithinWindow(db)).toBe(0)
  })

  it('qualify_and_push mode forwards qualified leads within the cap', async () => {
    const db = makeDb()
    const orgs = Array.from({ length: 3 }, (_, i) => richOrg(i + 1))
    const res = await runYanaDiscovery(db, { allowLeads: true, deps: { loadOrganizations: loaderFor(orgs) } })
    expect(res.mode).toBe('qualify_and_push')
    expect(res.leads_pushed_to_john).toBe(3)
    expect(res.cap).toBe(DAILY_LEAD_CAP)
  })
})
